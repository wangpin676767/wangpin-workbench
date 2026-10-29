'use strict';
// 自訂 Harness：使用者用 .txt 腳本自己定義「多階段流程」。
// 一份腳本由幾個步驟組成，每個步驟可以是：
//   ・對話：純文字的 prompt 階段（不碰檔案），例如規劃、寫稿、評審
//   ・代理：交給會自己讀寫檔案、跑指令的代理（權限沿用這段對話），像 Prime Agent 那樣
//   ・檢查：依標準判斷前面的結果，不通過就帶著意見退回指定步驟重做
// 腳本本身只寫流程和 prompt，不執行腳本裡的程式碼；真的要動檔案、跑指令，一律交給「代理」步驟，
// 所以權限、刪除保護照樣由工作台管。
//
// 模型呼叫全部透過呼叫端傳進來的 runner（沿用目前對話的模型與登入方式；步驟也可以另外指定）。
const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 1;
const AUTO = '__auto__';
const TRASH = '已刪除';
const MAX_BYTES = 512 * 1024;
const TYPES = { 對話: 'prompt', prompt: 'prompt', chat: 'prompt', 文字: 'prompt', 代理: 'agent', agent: 'agent', 檢查: 'check', check: 'check', 驗收: 'check' };
const TYPE_LABEL = { prompt: '對話', agent: '代理', check: '檢查' };
const LEVELS = ['chat', 'read-only', 'workspace-write', 'danger-full-access'];
const PERMISSION = { 沿用對話: '', 僅聊天: 'chat', 唯讀: 'read-only', 可寫入: 'workspace-write', 完全存取: 'danger-full-access' };
const HEADER_KEYS = { 名稱: 'name', 用途: 'purpose', 總時間上限: 'timeLimit', 最多步驟次數: 'maxRuns', 共同指示: 'common', 模型: 'model' };
const STEP_KEYS = { 類型: 'type', 模型: 'model', 檢查: 'target', 檢查對象: 'target', 不通過時回到: 'back', 最多重做: 'retries', 時間上限: 'timeLimit', 接續: 'resume', 權限: 'permission' };
const BUILTIN_VARS = ['輸入', 'input', '上一步', '回饋', '對話紀錄', '專案資料夾', '日期', '目標'];

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
const STEP_RE = /^={3,}\s*(?:步驟\s*\d*\s*[:：]\s*)?(.+?)\s*={3,}\s*$/;
const HEADER_RE = /^【([^】]+)】\s*(.*)$/;
const KV_RE = /^([^\s:：]{1,8})\s*[:：]\s*(.*)$/;

function decode(buf) {
  if (typeof buf === 'string') return buf.replace(/^\uFEFF/, '');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.slice(2)); b.swap16(); return b.toString('utf16le'); }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  // 記事本舊版「ANSI」存成 Big5 時 UTF-8 解會出現替代字元
  if (text.includes('\uFFFD')) { try { return new TextDecoder('big5').decode(buf); } catch { /* 沒有 big5 解碼器 */ } }
  return text;
}

/**
 * 把腳本文字轉成 { name, purpose, common, timeLimit, maxRuns, model, steps, output, errors, warnings }。
 * errors 有東西就不能執行；每條都帶行號，使用者用記事本才找得到。
 */
function parse(raw) {
  const text = decode(raw).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const script = { name: '', purpose: '', common: '', timeLimit: 30, maxRuns: 20, model: '', steps: [], output: '', errors: [], warnings: [] };
  const err = (line, message) => script.errors.push({ line, message });
  const warn = (line, message) => script.warnings.push({ line, message });
  let section = 'header';   // header | step | output
  let step = null;
  let inPrompt = false;
  let headerKey = '';       // 正在讀的多行【欄位】
  const stepLine = new Map();
  const finishStep = () => { if (step) { step.prompt = step.prompt.replace(/^\n+|\s+$/g, ''); script.steps.push(step); } step = null; inPrompt = false; };

  for (let i = 0; i < lines.length; i++) {
    const no = i + 1;
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const m = STEP_RE.exec(line.trim());
    if (m) {
      finishStep(); headerKey = '';
      const title = m[1].trim();
      if (/^(?:輸出|output)$/i.test(title)) { section = 'output'; continue; }
      if (section === 'output') err(no, '「=== 輸出 ===」要放在最後，後面不能再有步驟。');
      section = 'step';
      if (stepLine.has(title)) err(no, `步驟名稱「${title}」重複了（第 ${stepLine.get(title)} 行已經用過），每個步驟要取不同的名字。`);
      if (/[{}]/.test(title)) err(no, '步驟名稱不能含 { 或 }。');
      stepLine.set(title, no);
      step = { name: title, line: no, type: 'prompt', typeSet: false, model: '', target: '', back: '', retries: 2, timeLimit: 0, resume: false, permission: '', prompt: '', promptLine: 0 };
      continue;
    }
    if (section === 'output') { script.output += `${line}\n`; continue; }
    if (section === 'header') {
      const h = HEADER_RE.exec(line.trim());
      if (h) {
        const key = HEADER_KEYS[h[1].trim()];
        if (!key) { warn(no, `不認得的欄位「【${h[1]}】」，已略過。`); headerKey = ''; continue; }
        headerKey = key;
        script[key] = h[2].trim();
        continue;
      }
      if (headerKey && line.trim()) { script[headerKey] = script[headerKey] ? `${script[headerKey]}\n${line.trimEnd()}` : line.trim(); continue; }
      if (line.trim()) warn(no, '這一行不在任何欄位或步驟裡，已略過。');
      continue;
    }
    // section === 'step'
    if (inPrompt) { step.prompt += `${line}\n`; continue; }
    if (!line.trim()) continue;
    const kv = KV_RE.exec(line.trim());
    if (kv && kv[1] === '提示') { inPrompt = true; step.promptLine = no; if (kv[2].trim()) step.prompt += `${kv[2].trim()}\n`; continue; }
    const key = kv && STEP_KEYS[kv[1]];
    if (!key) { err(no, `步驟「${step.name}」裡看不懂這一行。步驟的設定要寫成「類型：對話」這種格式，prompt 要寫在「提示：」那一行之後。`); continue; }
    const value = kv[2].trim();
    if (key === 'type') {
      const t = TYPES[value] || TYPES[value.toLowerCase()];
      if (!t) err(no, `類型「${value}」不存在，只能是：對話、代理、檢查。`); else { step.type = t; step.typeSet = true; }
    } else if (key === 'retries') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) err(no, '「最多重做」要是 0 到 10 的整數。'); else step.retries = n;
    } else if (key === 'timeLimit') {
      const n = Number(String(value).replace(/分鐘?$/, ''));
      if (!(n > 0 && n <= 120)) err(no, '「時間上限」要是 1 到 120（分鐘）。'); else step.timeLimit = n;
    } else if (key === 'resume') {
      step.resume = /^(?:是|要|yes|true|1)$/i.test(value);
    } else if (key === 'permission') {
      if (!(value in PERMISSION)) err(no, `權限只能是：${Object.keys(PERMISSION).join('、')}。`); else step.permission = PERMISSION[value];
    } else step[key] = value;
  }
  finishStep();
  script.output = script.output.replace(/^\n+|\s+$/g, '');

  // ---- 整份檢查 ----
  const tl = Number(String(script.timeLimit).replace(/分鐘?$/, ''));
  if (!(tl > 0 && tl <= 240)) { err(0, '【總時間上限】要是 1 到 240（分鐘）。'); script.timeLimit = 30; } else script.timeLimit = tl;
  const mr = Number(script.maxRuns);
  if (!(Number.isInteger(mr) && mr >= 1 && mr <= 100)) { err(0, '【最多步驟次數】要是 1 到 100 的整數。'); script.maxRuns = 20; } else script.maxRuns = mr;
  if (!script.name) warn(0, '沒有寫【名稱】，會用檔名代替。');
  if (!script.steps.length) err(0, '沒有任何步驟。步驟要用一行「=== 步驟：名稱 ===」開頭。');
  const names = new Set(script.steps.map((s) => s.name));
  const index = new Map(script.steps.map((s, i) => [s.name, i]));
  script.steps.forEach((s, i) => {
    if (!s.prompt.trim()) err(s.line, `步驟「${s.name}」沒有 prompt（要寫在「提示：」那一行之後）。`);
    if (s.type === 'check') {
      const target = s.target || (i > 0 ? script.steps[i - 1].name : '');
      if (!target) err(s.line, `檢查步驟「${s.name}」前面沒有步驟可以檢查。`);
      else if (!names.has(target)) err(s.line, `檢查步驟「${s.name}」要檢查的「${target}」不是任何步驟的名稱。`);
      else if (index.get(target) >= i) err(s.line, `檢查步驟「${s.name}」只能檢查排在它前面的步驟。`);
      s.target = target;
      const back = s.back || target;
      if (!names.has(back)) err(s.line, `「不通過時回到」的「${back}」不是任何步驟的名稱。`);
      else if (index.get(back) >= i) err(s.line, `「不通過時回到」只能指向排在「${s.name}」前面的步驟。`);
      s.back = back;
    } else if (s.target || s.back) warn(s.line, `「檢查」「不通過時回到」只對檢查步驟有用，步驟「${s.name}」會忽略它們。`);
    if (s.type !== 'agent' && s.permission) warn(s.line, `「權限」只對代理步驟有用，步驟「${s.name}」會忽略它。`);
    if (s.type !== 'agent' && s.resume) warn(s.line, `「接續」只對代理步驟有用，步驟「${s.name}」會忽略它。`);
  });
  // 變數要對得上：打錯字的話模型只會看到原封不動的 {{…}}
  const known = new Set([...BUILTIN_VARS, ...names]);
  const checkVars = (body, line, where) => {
    for (const v of String(body || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (!known.has(v[1])) err(line, `${where}用了 {{${v[1]}}}，但沒有這個步驟或內建變數。可用的有：${[...BUILTIN_VARS.slice(0, 1), ...BUILTIN_VARS.slice(2), ...names].map((n) => `{{${n}}}`).join('、')}。`);
    }
  };
  for (const s of script.steps) checkVars(s.prompt, s.promptLine || s.line, `步驟「${s.name}」的 prompt `);
  checkVars(script.output, 0, '「=== 輸出 ===」');
  checkVars(script.common, 0, '【共同指示】');
  script.ok = !script.errors.length;
  return script;
}

const describeErrors = (script) => [...script.errors].sort((a, b) => a.line - b.line).map((e) => `${e.line ? `第 ${e.line} 行：` : ''}${e.message}`);

// ---------------------------------------------------------------------------
// 範本
// ---------------------------------------------------------------------------
const FORMAT_HELP = `# ── Codex Multi Harness 腳本格式（v${FORMAT_VERSION}）──────────────────────────
# 以「#」開頭的行是註解，執行時會忽略（prompt 裡也一樣，所以 prompt 不要用 # 開頭的標題）。
#
# 開頭的欄位（都可以省略）：
#   【名稱】腳本名稱            【用途】一句話說明
#   【總時間上限】分鐘（預設 30）  【最多步驟次數】整份最多執行幾次步驟，含重做（預設 20）
#   【模型】整份預設用的模型（留空＝沿用目前對話）
#   【共同指示】可以寫很多行，會放在每個步驟的 prompt 前面
#
# 步驟：用一行「=== 步驟：名稱 ===」開頭，接著寫設定，最後在「提示：」之後寫 prompt。
#   類型：對話｜代理｜檢查
#     對話＝純文字階段，不碰檔案（規劃、寫稿、評審…）
#     代理＝會自己讀寫檔案、跑指令的代理，在這段對話的專案資料夾工作，權限沿用對話
#     檢查＝判斷前面的結果合不合格，不合格就帶著意見退回重做
#   模型：沿用對話｜模型 ID｜供應商/模型 ID（例如 claude/claude-sonnet-5、deepseek/deepseek-flash）
#   時間上限：這一步最多幾分鐘
#   權限（代理）：沿用對話｜唯讀｜僅聊天｜可寫入｜完全存取（只能比對話的權限更低，不會更高）
#   接續（代理）：是＝接著同一個代理上次的工作階段（記得前面做過什麼）
#   檢查（檢查）：要檢查哪一步，預設是前一步
#   不通過時回到（檢查）：不合格時退回哪一步，預設就是被檢查的那一步
#   最多重做（檢查）：最多退回幾次（預設 2），用完還是不合格就照目前結果往下走並註明
#
# prompt 裡可以用的變數：
#   {{輸入}} 你這次送出的訊息       {{步驟名稱}} 那一步最新的輸出
#   {{上一步}} 前一個執行的步驟的輸出  {{回饋}} 檢查退回時給的修正意見（沒有就是空的）
#   {{對話紀錄}} 這段對話最近的往來    {{專案資料夾}} 對話的工作資料夾    {{日期}} 今天
#
# 最後用「=== 輸出 ===」寫要回覆給你的內容（可用變數）；省略就回覆最後一個步驟的輸出。
# ─────────────────────────────────────────────────────────────────────────`;

const TEMPLATES = [
  {
    file: '範本-通用流程.txt',
    text: `${FORMAT_HELP}

【名稱】通用流程：規劃 → 執行 → 檢查 → 修正
【用途】把目標拆成計畫、照計畫完成、依標準檢查，不合格就退回修正。
【總時間上限】30
【最多步驟次數】12
【共同指示】
用繁體中文。不知道的事直接說不知道，不要編造。

=== 步驟：規劃 ===
類型：對話
提示：
目標：
{{輸入}}

請寫出完成這個目標的計畫：
1. 要交出什麼（具體的成果）
2. 分幾步做，每一步做什麼
3. 驗收標準：三到五條，要能明確判斷有沒有做到

=== 步驟：執行 ===
類型：對話
提示：
目標：
{{輸入}}

計畫：
{{規劃}}

請依計畫完成，直接交出成果本身，不要只寫做法。
{{回饋}}

=== 步驟：檢查 ===
類型：檢查
檢查：執行
不通過時回到：執行
最多重做：2
提示：
逐條對照計畫裡的驗收標準檢查下面的成果，指出沒做到的地方與具體修法。

計畫：
{{規劃}}

成果：
{{執行}}

=== 輸出 ===
{{執行}}
`,
  },
  {
    file: '範本-程式代理.txt',
    text: `${FORMAT_HELP}

【名稱】程式代理：分析 → 實作並測試 → 審查
【用途】像 Prime Agent 一樣，讓代理自己讀程式、寫程式、跑指令，再由另一個步驟審查。
【總時間上限】60
【最多步驟次數】8

=== 步驟：分析 ===
類型：代理
權限：唯讀
時間上限：15
提示：
任務：
{{輸入}}

先讀這個專案（{{專案資料夾}}）相關的程式碼，不要修改任何檔案。回報：
- 要改哪些檔案、為什麼
- 怎麼驗證改對了（要跑哪些測試或指令）
- 可能的風險

=== 步驟：實作 ===
類型：代理
接續：是
時間上限：40
提示：
任務：
{{輸入}}

分析結果：
{{分析}}

照分析結果實作，並實際執行測試或指令確認可以用。回報改了哪些檔案、跑了什麼、結果如何；失敗的地方照實說。
{{回饋}}

=== 步驟：審查 ===
類型：檢查
檢查：實作
最多重做：2
提示：
你是嚴格的審查者。檢查下面的實作回報：需求有沒有全部做到、有沒有實際跑過驗證、有沒有沒處理的錯誤或宣稱做完但其實沒做的部分。

任務：
{{輸入}}

實作回報：
{{實作}}

=== 輸出 ===
{{實作}}

（審查意見：{{審查}}）
`,
  },
  {
    file: '範本-研究查證.txt',
    text: `${FORMAT_HELP}

【名稱】研究查證：拆問題 → 查資料 → 交叉驗證 → 結論
【用途】需要查資料、而且要分清楚「有根據」和「推論」的問題。
【總時間上限】45
【最多步驟次數】8

=== 步驟：拆問題 ===
類型：對話
提示：
問題：
{{輸入}}

把它拆成三到六個可以查證的子問題，每個寫出要找什麼樣的證據才算回答。

=== 步驟：查資料 ===
類型：代理
權限：唯讀
提示：
逐一查證下列子問題。可以上網查、讀檔案；每個結論都附上來源（網址或檔案路徑），查不到就寫查不到，不要猜。

子問題：
{{拆問題}}
{{回饋}}

=== 步驟：交叉驗證 ===
類型：檢查
檢查：查資料
最多重做：1
提示：
檢查下面的查證結果：每個結論有沒有來源、來源撐不撐得住結論、有沒有互相矛盾、有沒有把推論寫成事實。

{{查資料}}

=== 步驟：結論 ===
類型：對話
提示：
根據查證結果回答原本的問題。先給結論，再列根據；分清楚「有來源支持」與「推論」。

問題：{{輸入}}

查證結果：
{{查資料}}

驗證意見：
{{交叉驗證}}
`,
  },
  {
    file: '範本-寫作多階段.txt',
    text: `${FORMAT_HELP}

【名稱】寫作：大綱 → 初稿 → 評審 → 修稿
【用途】文章、故事、文案這類要先想結構再寫、寫完要挑毛病的工作。
【總時間上限】30
【最多步驟次數】10

=== 步驟：大綱 ===
類型：對話
提示：
寫作需求：
{{輸入}}

先寫大綱：讀者是誰、要讓讀者得到什麼、段落結構（每段一句話）、語氣。

=== 步驟：初稿 ===
類型：對話
提示：
需求：{{輸入}}

大綱：
{{大綱}}

依大綱寫出完整初稿。
{{回饋}}

=== 步驟：評審 ===
類型：檢查
檢查：初稿
最多重做：2
提示：
你是挑剔的編輯。檢查初稿：有沒有照大綱、開頭抓不抓得住人、有沒有空話與重複、語氣對不對。

大綱：
{{大綱}}

初稿：
{{初稿}}

=== 輸出 ===
{{初稿}}
`,
  },
];

// ---------------------------------------------------------------------------
// 檔案管理（userData/harness/*.txt；刪除＝移到「已刪除」資料夾）
// ---------------------------------------------------------------------------
// 檔名用本機時間（使用者在檔案總管看到的時間），不要用 UTC
const localStamp = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('');
const safeName = (name) => {
  let base = String(name || '').replace(/\.txt$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
  if (!base) base = '未命名腳本';
  return `${base}.txt`;
};
const inside = (root, file) => {
  const p = path.join(root, safeName(file));
  if (path.dirname(p) !== path.resolve(root)) throw new Error('腳本檔名不正確');
  return p;
};

function ensureTemplates(root) {
  fs.mkdirSync(root, { recursive: true });
  // 只在第一次建立：使用者刪掉或改掉範本後不要一直補回來
  const marker = path.join(root, '.templates-v1');
  if (fs.existsSync(marker)) return;
  for (const t of TEMPLATES) {
    const p = path.join(root, t.file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, `\uFEFF${t.text.replace(/\n/g, '\r\n')}`, 'utf8');
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

function list(root) {
  ensureTemplates(root);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.txt$/i.test(d.name))
    .map((d) => {
      const file = path.join(root, d.name);
      const st = fs.statSync(file);
      let script;
      try { script = st.size > MAX_BYTES ? null : parse(fs.readFileSync(file)); } catch { script = null; }
      return {
        file: d.name,
        name: script?.name || d.name.replace(/\.txt$/i, ''),
        purpose: script?.purpose || '',
        ok: !!script?.ok,
        steps: script ? script.steps.map((s) => ({ name: s.name, type: TYPE_LABEL[s.type] })) : [],
        errors: script ? describeErrors(script) : [st.size > MAX_BYTES ? '檔案太大（上限 512 KB）' : '讀不到這個檔案'],
        template: TEMPLATES.some((t) => t.file === d.name),
        mtime: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => Number(b.template) - Number(a.template) || a.file.localeCompare(b.file, 'zh-Hant'));
}

function read(root, file) {
  const p = inside(root, file);
  if (!fs.existsSync(p)) throw new Error(`找不到腳本「${file}」，可能已經被刪除或改名。`);
  if (fs.statSync(p).size > MAX_BYTES) throw new Error('腳本太大（上限 512 KB）');
  const text = decode(fs.readFileSync(p));
  return { file: path.basename(p), path: p, text, script: parse(text) };
}

/** 存檔前一定先解析：格式錯了照樣存（使用者可能改到一半），但把錯誤回報出去。 */
function save(root, file, text, { overwrite = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const body = String(text || '').replace(/^\uFEFF/, '');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('腳本太大（上限 512 KB）');
  let p = inside(root, file);
  if (!overwrite) p = uniquePath(root, path.basename(p));
  fs.writeFileSync(p, `\uFEFF${body.replace(/\r?\n/g, '\r\n')}`, 'utf8');
  const script = parse(body);
  return { file: path.basename(p), path: p, ok: script.ok, errors: describeErrors(script), warnings: script.warnings.map((w) => `${w.line ? `第 ${w.line} 行：` : ''}${w.message}`) };
}

function uniquePath(dir, file) {
  const base = file.replace(/\.txt$/i, '');
  let p = path.join(dir, `${base}.txt`);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n}).txt`);
  return p;
}

function rename(root, from, to) {
  const src = inside(root, from);
  if (!fs.existsSync(src)) throw new Error(`找不到腳本「${from}」`);
  const dst = inside(root, to);
  if (dst.toLowerCase() === src.toLowerCase()) return { file: path.basename(src) };
  if (fs.existsSync(dst)) throw new Error(`已經有一份叫「${path.basename(dst)}」的腳本`);
  fs.renameSync(src, dst);
  return { file: path.basename(dst) };
}

/** 刪除＝移到「已刪除」資料夾（檔名前面加時間），誤刪還救得回來。 */
function remove(root, file) {
  const src = inside(root, file);
  if (!fs.existsSync(src)) throw new Error(`找不到腳本「${file}」`);
  const trash = path.join(root, TRASH);
  fs.mkdirSync(trash, { recursive: true });
  const stamp = localStamp().replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3-$4-$5-$6');
  const dst = path.join(trash, `${stamp}__${path.basename(src)}`);
  fs.renameSync(src, dst);
  return { file: path.basename(src), trashed: dst };
}

function listTrash(root) {
  const trash = path.join(root, TRASH);
  if (!fs.existsSync(trash)) return [];
  return fs.readdirSync(trash).filter((n) => /\.txt$/i.test(n)).sort().reverse()
    .map((n) => ({ entry: n, file: n.replace(/^[\d-]+__/, ''), deletedAt: (/^(\d{4}-\d\d-\d\d)-(\d\d)-(\d\d)-(\d\d)__/.exec(n) || []).slice(1).join(' ').replace(/ (\d\d) (\d\d)$/, ':$1:$2') }));
}

function restore(root, entry) {
  const trash = path.join(root, TRASH);
  const src = path.join(trash, path.basename(String(entry || '')));
  if (!fs.existsSync(src)) throw new Error('找不到這份已刪除的腳本');
  const dst = uniquePath(root, path.basename(src).replace(/^[\d-]+__/, ''));
  fs.renameSync(src, dst);
  return { file: path.basename(dst) };
}

/** 從別的地方載入 TXT：複製一份進腳本資料夾（不移動原檔）。 */
function importFile(root, source) {
  const st = fs.statSync(source);
  if (st.size > MAX_BYTES) throw new Error('檔案太大（上限 512 KB）');
  const text = decode(fs.readFileSync(source));
  const script = parse(text);
  const r = save(root, path.basename(source), text, { overwrite: false });
  return { ...r, name: script.name };
}

// ---------------------------------------------------------------------------
// 執行
// ---------------------------------------------------------------------------
const PROMPT_PREFIX = '這是多階段流程裡的一個純文字步驟：只輸出這一步要求的內容，不要使用工具、不要修改檔案，也不要談論流程本身。';
const CHECK_SUFFIX = '\n\n──\n請依上面的要求判斷。先寫出具體的問題與修正意見（合格就簡短說明為什麼合格），最後一行只能寫「結果：通過」或「結果：不通過」。';
const spell = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分鐘` : `${Math.max(1, Math.round(ms / 1000))} 秒`);

function verdict(text) {
  const all = [...String(text || '').matchAll(/(?:結果|判定|verdict)\s*[:：]\s*(不通過|未通過|通過|不合格|合格|FAIL|PASS)/gi)];
  if (!all.length) return null;
  return /^(?:通過|合格|PASS)$/i.test(all[all.length - 1][1]);
}

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : `{{${k}}}`));
}

/**
 * 執行一份腳本。
 * opts: {
 *   input, history, cwd, signal, onProgress(text), onStep(info),
 *   runnerFor({ step, type, model, permission }) → { ask(message, opts) }   // 由 main.js 依步驟建立
 * }
 * 回傳 { text, runs:[{step,type,ms,verdict}], calls, script }
 */
async function run(script, opts = {}) {
  if (!script || !script.ok) throw new Error(`腳本有錯誤，不能執行：\n${describeErrors(script || { errors: [] }).join('\n')}`);
  const { signal, onProgress } = opts;
  if (signal?.aborted) throw new Error('已取消');
  const totalMs = script.timeLimit * 60000;
  const start = Date.now();
  const vars = {
    輸入: String(opts.input || ''), input: String(opts.input || ''), 目標: String(opts.input || ''),
    上一步: '', 回饋: '', 對話紀錄: String(opts.history || ''), 專案資料夾: String(opts.cwd || '（沒有設定專案資料夾）'),
    日期: new Date().toLocaleDateString('zh-TW'),
  };
  for (const s of script.steps) vars[s.name] = '';
  const feedbackFor = new Map();   // 被退回的步驟 → 檢查意見
  const retriesLeft = new Map(script.steps.filter((s) => s.type === 'check').map((s) => [s.name, s.retries]));
  const unresolved = [];
  const runs = [];
  const agentUsed = new Set();
  let lastAgent = '';
  let calls = 0;
  let i = 0;

  while (i < script.steps.length) {
    if (signal?.aborted) throw new Error('已取消');
    if (runs.length >= script.maxRuns) throw new Error(`已經執行了 ${runs.length} 次步驟，達到【最多步驟次數】${script.maxRuns}，流程停在「${script.steps[i].name}」之前。請提高上限，或減少檢查的「最多重做」次數。`);
    const step = script.steps[i];
    const left = totalMs - (Date.now() - start);
    if (left < 5000) throw new Error(`已達【總時間上限】${script.timeLimit} 分鐘，流程停在「${step.name}」之前，沒有跑完。`);
    const stepMs = Math.min(left, step.timeLimit ? step.timeLimit * 60000 : left);
    const fb = feedbackFor.get(step.name) || '';
    const stepVars = { ...vars, 回饋: fb ? `上次的結果沒有通過檢查，修正意見如下，請依意見修正後重新交出完整結果：\n${fb}` : '' };
    let body = fill(step.prompt, stepVars);
    const common = fill(script.common, stepVars).trim();
    if (common) body = `${common}\n\n${body}`;
    if (step.type === 'check') body += CHECK_SUFFIX;
    if (step.type === 'prompt') body = `${PROMPT_PREFIX}\n\n${body}`;
    const round = runs.filter((r) => r.step === step.name).length + 1;
    const label = `第 ${runs.length + 1} 次・步驟「${step.name}」（${TYPE_LABEL[step.type]}${round > 1 ? `，第 ${round} 次` : ''}）`;
    onProgress?.(label);
    opts.onStep?.({ name: step.name, type: step.type, round, index: i, total: script.steps.length });
    // 代理的工作階段：「接續：是」接著上一個代理步驟的階段；同一個代理步驟被退回重做時也接著自己上次的階段，
    // 它才記得自己做過什麼
    const session = step.type === 'agent' ? (step.resume && lastAgent ? lastAgent : step.name) : '';
    const runner = await opts.runnerFor({ step: step.name, type: step.type, model: step.model || script.model || '', permission: step.permission, session });
    const t0 = Date.now();
    const followup = step.type === 'agent' && agentUsed.has(session);
    let result;
    try {
      result = await runner.ask(body, {
        name: `Harness：${script.name || '腳本'}／${step.name}`,
        signal, timeoutMs: stepMs, followup: !!followup,
        onProgress: (tool) => onProgress?.(`${label}：${tool}`),
      });
    } catch (e) {
      if (signal?.aborted) throw new Error('已取消');
      throw new Error(`步驟「${step.name}」失敗：${e.message}`);
    }
    calls++;
    if (step.type === 'agent') { agentUsed.add(session); lastAgent = session; }
    const text = String(result?.text || '').trim();
    if (!text) throw new Error(`步驟「${step.name}」模型沒有回傳文字`);
    const record = { step: step.name, type: TYPE_LABEL[step.type], ms: Date.now() - t0 };
    runs.push(record);
    if (step.type === 'check') record.verdict = verdict(text) === null ? '沒有寫結果，當作不通過' : verdict(text) ? '通過' : '不通過';
    opts.onStepDone?.({ ...record, output: text });
    vars[step.name] = text;
    vars.上一步 = text;

    if (step.type === 'check') {
      if (!verdict(text)) {
        const left2 = retriesLeft.get(step.name) || 0;
        if (left2 > 0) {
          retriesLeft.set(step.name, left2 - 1);
          feedbackFor.set(step.back, text.replace(/\n?\s*(?:結果|判定)\s*[:：]\s*\S+\s*$/, '').trim());
          onProgress?.(`步驟「${step.name}」判定不通過，退回「${step.back}」重做（還可以再退 ${left2 - 1} 次）`);
          i = script.steps.findIndex((s) => s.name === step.back);
          continue;
        }
        unresolved.push(step.name);
      } else feedbackFor.delete(step.back);
    }
    i++;
  }

  let text = script.output ? fill(script.output, vars).trim() : vars.上一步;
  if (!text) text = vars.上一步;
  if (unresolved.length) text += `\n\n［注意：檢查步驟「${unresolved.join('、')}」重做次數用完仍判定不通過，以上是目前最好的結果。］`;
  return { text, runs, calls, unresolved, ms: Date.now() - start, script };
}

// ---------------------------------------------------------------------------
// 依目標自動建立腳本
// ---------------------------------------------------------------------------
function generatorPrompt(goal, { history = '', level = '' } = {}) {
  const example = TEMPLATES[0].text.split('\n').filter((l) => !/^#/.test(l)).join('\n').trim();
  return [
    '你要替下面這個目標設計一份「Codex Multi Harness 腳本」。只輸出腳本本身的純文字，不要加解說，也不要用 ``` 包起來。',
    '格式規則：',
    FORMAT_HELP,
    '設計要點：',
    '- 依目標選步驟：需要讀寫檔案、跑程式、上網查資料的工作用「代理」步驟；純思考、寫作、規劃用「對話」步驟；最後至少放一個「檢查」步驟，寫出可以明確判斷的驗收標準。',
    '- 步驟名稱用簡短的中文，每個 prompt 都要自給自足：用 {{輸入}} 帶入目標、用 {{步驟名稱}} 帶入前面步驟的結果，被檢查的步驟 prompt 裡要放 {{回饋}}。',
    '- prompt 裡不要有以 # 開頭的行。步驟數控制在 3 到 7 個。',
    level === 'chat' ? '- 目前對話的權限是「僅聊天」，代理步驟拿不到任何工具，所以只用「對話」與「檢查」步驟。' : '',
    '範例（只是參考格式，請依目標自己設計）：',
    example,
    history ? `這段對話最近的往來（參考用）：\n${history.slice(-6000)}` : '',
    `目標：\n${goal}`,
  ].filter(Boolean).join('\n\n');
}

function cleanGenerated(text) {
  let t = String(text || '').replace(/^\uFEFF/, '');
  const fence = /```[\w-]*\n([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1];
  const at = t.search(/^(?:【|===)/m);
  if (at > 0) t = t.slice(at);
  return t.trim();
}

/**
 * 讓模型依目標寫一份腳本並存檔。格式錯了把錯誤丟回去讓它修一次。
 * 回傳 { file, path, text, script, calls }
 */
async function generate(goal, { root, runner, signal, timeoutMs = 300000, history = '', level = '', onProgress } = {}) {
  const g = String(goal || '').trim();
  if (!g) throw new Error('請先寫出目標');
  if (!runner) throw new Error('取不到目前對話的模型');
  onProgress?.('依目標設計新的 Harness 腳本…');
  const ask = (msg) => runner.ask(`${PROMPT_PREFIX}\n\n${msg}`, { name: 'Harness：設計腳本', signal, timeoutMs });
  let calls = 1;
  let text = cleanGenerated((await ask(generatorPrompt(g, { history, level })))?.text);
  let script = parse(text);
  if (!script.ok) {
    onProgress?.('設計出的腳本格式有錯，請模型修正一次…');
    calls++;
    text = cleanGenerated((await ask(`下面這份 Harness 腳本有格式錯誤，請修正後輸出完整腳本（只輸出腳本本身）。\n\n錯誤：\n${describeErrors(script).join('\n')}\n\n格式規則：\n${FORMAT_HELP}\n\n腳本：\n${text}`))?.text);
    script = parse(text);
  }
  if (!script.ok) throw new Error(`模型設計的腳本格式仍然有錯，沒有執行：\n${describeErrors(script).join('\n')}`);
  const stamp = localStamp().slice(0, 12);
  const title = (script.name || g).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 30);
  const header = `# 由 Codex Multi 依目標自動建立（${new Date().toLocaleString('zh-TW')}）\n# 目標：${g.replace(/\s+/g, ' ').slice(0, 200)}\n\n`;
  const saved = save(root, `自動-${stamp}-${title}`, header + text, { overwrite: false });
  return { ...saved, text: header + text, script, calls };
}

function health() {
  const results = TEMPLATES.map((t) => ({ file: t.file, ok: parse(t.text).ok }));
  return { ok: results.every((r) => r.ok), results };
}

module.exports = {
  FORMAT_VERSION, AUTO, TRASH, TEMPLATES, FORMAT_HELP, LEVELS, TYPE_LABEL,
  parse, describeErrors, verdict, fill, decode,
  ensureTemplates, list, read, save, rename, remove, listTrash, restore, importFile, safeName,
  run, generate, generatorPrompt, cleanGenerated, health,
};
