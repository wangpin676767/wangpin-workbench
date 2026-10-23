'use strict';
// 能力擴充（Extensions）：讓使用者用勾選的方式，替某一段對話加上額外的工具包。
// 可以只開一個、同時開兩個、或全部開；每個工具包的工具名稱都有自己的前綴，
// 而且每次執行各自建立連線，所以彼此不會搶資源，也不會跨對話干擾。
//
// 三個內建工具包各做各的事，互不隸屬：
//   ・Prime Agent（解難題）：PrimeIntellect 的獨立編碼代理，整包任務外包出去。
//   ・Zenith（解難題）：Intelligent Internet 的長任務協作 harness，用 MCP 指揮 worker／validator。
//   ・Scrapling（爬蟲）：抓網頁用的工具包，跟前兩個沒有關係。
const fs = require('fs');
const path = require('path');
const os = require('os');
const mcpClient = require('./mcpClient');
const primeAgent = require('./primeAgent');
const zenithPatch = require('./zenithPatch');

const WIN = process.platform === 'win32';
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

function pathDirs() {
  return String(process.env.PATH || '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

/** 在指定資料夾與 PATH 上找第一個存在的執行檔。 */
function findBin(names, dirs = []) {
  for (const dir of [...dirs, ...pathDirs()]) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

function findScrapling(custom) {
  const home = os.homedir();
  const names = WIN ? ['scrapling.exe', 'scrapling.cmd', 'scrapling'] : ['scrapling'];
  if (custom && exists(custom)) return custom;
  return findBin(names, [
    path.join(home, '.local', 'bin'),
    path.join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts'),
    path.join(home, '.venv', WIN ? 'Scripts' : 'bin'),
  ]);
}

function findUv(custom) {
  const home = os.homedir();
  const names = WIN ? ['uv.exe', 'uv.cmd'] : ['uv'];
  if (custom && exists(custom)) return custom;
  return findBin(names, [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')]);
}

/** Zenith 是 Python 專案，要找的是含 pyproject.toml 的 uv 專案資料夾。 */
function findZenithRoot(custom) {
  const home = os.homedir();
  const ok = (dir) => {
    if (!isDir(dir)) return false;
    try { return /zenith-harness/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')); } catch { return false; }
  };
  const list = [
    ...(custom ? [custom, path.join(custom, 'zenith')] : []),
    path.join(home, '.zenith', 'src', 'zenith'),
    path.join(home, 'zenith', 'zenith'),
    path.join(home, '.zenith', 'zenith'),
  ];
  return list.find(ok) || null;
}

/** Zenith 的 worker 是透過 ACP 轉接器啟動的（claude-agent-acp／codex-acp）。 */
function findAcpDir() {
  const home = os.homedir();
  const names = WIN ? ['claude-agent-acp.cmd', 'codex-acp.cmd'] : ['claude-agent-acp', 'codex-acp'];
  const dirs = [
    path.join(home, '.zenith', 'acp'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
  ];
  const hit = findBin(names, dirs);
  return hit ? path.dirname(hit) : null;
}

/** Zenith 的 ACP 轉接器需要 Node 22 以上；這裡找一份可用的。 */
function findNode22() {
  const home = os.homedir();
  const roots = [path.join(home, '.prime-agent', 'runtime'), path.join(home, '.zenith', 'runtime')];
  for (const root of roots) {
    if (!isDir(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const m = /^node-v(\d+)\./.exec(name);
      if (m && Number(m[1]) >= 22 && exists(path.join(root, name, WIN ? 'node.exe' : 'bin/node'))) {
        return WIN ? path.join(root, name) : path.join(root, name, 'bin');
      }
    }
  }
  return null;
}

// ---- 內建工具包 ----
const BUILTINS = [
  {
    id:'ragthoven',name:'RAGthoven',category:'創作',prefix:'ragthoven',kind:'ragthoven',chatSafe:true,
    summary:'使用 RAGthoven 官方 MWAHAHA 幽默工具鏈寫笑話：檢索靈感 → 規劃 → 候選 → 修稿 → 評選。',
    detail:'內建上游幽默工具鏈的工作台適配版，沿用目前對話模型與登入方式。每次約 4 次模型呼叫，約束未通過時最多再修正 1 次；使用本機關鍵字檢索，不需另外申請 embedding API。',
    detect(cfg){const bin=require('./ragthoven').python(cfg.path);return {available:!!bin,path:bin||'',note:bin?'幽默工具鏈已內建；模型沿用目前對話':'請安裝 Python 3.10 以上，或填入 python.exe 路徑'};},
  },
  {
    id:'scriptDoctor',name:'Script Doctor',category:'創作',prefix:'script_doctor',kind:'scriptDoctor',chatSafe:true,
    summary:'寫故事／劇本的多階段流程：logline → 角色與結構大綱 → 分場 → Fountain 初稿 → Script Doctor 診斷 → 修稿 → 最終檢查；也能診斷你既有的劇本。',
    detail:'診斷面向與確定性關鍵字規則移植自 ScriptDoctor-AI（github.com/Masngo/ScriptDoctor-AI，Apache-2.0）；原專案的 Gemini 與網路查證不內建，所有模型呼叫沿用目前對話的模型與登入方式。寫作每次 6 次模型呼叫，格式仍有錯時最多 7 次；純 JavaScript，不需 Python。',
    detect(){return {available:true,path:'',note:'劇本工具鏈已內建；模型沿用目前對話'};},
  },
  {
    id:'companion',name:'長期陪伴角色',category:'陪伴',prefix:'companion',kind:'companion',chatSafe:true,
    // 不提供工具：勾選後這段對話的每則訊息都直接由角色回覆（main.js 的 companion 分支），模型拿不到檔案或指令
    summary:'勾選後，這段對話由一位有自己生活、心情與記憶的長期陪伴角色直接回覆（預設名字「葉澄」，可在設定改）。她會記得你們之間的事、感知現在幾點和多久沒聊，關係會自然慢慢變化。',
    detail:'性格核心參考《魔法使之夜》蒼崎青子（直率、好勝、嘴硬、毒舌但在意人），人生背景與人際關係全部原創。人格、角色內推理、長期記憶與關係時間線分別是 PsyAgent、Thinking in Character（RAR）、Letta（MemGPT）、Graphiti／Zep 的概念適配（純 JavaScript 本機實作，非官方套件，不需要 Python、Neo4j 或資料庫）。模型沿用目前對話、純聊天唯讀；每回合 1 次模型呼叫（推理＋回覆＋記憶整理合併），回覆沒通過口吻檢查時再重寫 1 次，最多 2 次。記憶存在本機 userData/companion。',
    detect(cfg){return {available:true,path:'',note:`角色：${String(cfg.name||'').trim()||require('./companionPersona').DEFAULT_NAME}；模型沿用目前對話（僅聊天、不碰檔案）`};},
  },
  {
    id:'aoko',name:'蒼崎青子（命題 Agent）',category:'陪伴',prefix:'aoko',kind:'aoko',chatSafe:true,
    // 不提供工具：勾選後這段對話的每則訊息都由青子直接回覆（main.js 的 aoko 分支），模型拿不到檔案或指令
    summary:'勾選後，這段對話由《魔法使之夜》蒼崎青子（見習時期）直接回覆。她的思考被拆成 84 條因果命題、各自一個規則節點：程式先更新情緒、激動、疲勞、信任、預期落差，選定反射／習慣／審慮與要做的行動，模型才依這些限制寫台詞。',
    detail:'人物設定（有公開依據的特質與本擴充的推論分開標示）在 vendor/aoko/persona/aoko.json；84 條命題與資料埠在 vendor/aoko/rules。引擎是 Python（3.10 以上），純本機、不裝額外套件；模型呼叫全部轉回工作台，沿用目前對話的模型與登入方式（僅聊天、不碰檔案）。每回合約 2 次模型呼叫（標記原句線索＋寫台詞），回覆沒通過檢查時再重寫 1 次。跨回合狀態存在 userData/aoko，每段對話各一份。預設她看不到工作台的對話紀錄；在擴充選單勾選「讓青子看得到本段對話紀錄」後，每回合會帶入最近 12 則訊息當背景（只套用該段對話）。這是功能層次的模擬，不代表證明她的內部運作與人類相同；台詞是本擴充的設計，不是原作台詞。',
    detect(cfg){const bin=require('./ragthoven').python(cfg.path);return {available:!!bin,path:bin||'',note:bin?`引擎已內建；Python：${bin}；模型沿用目前對話（僅聊天、不碰檔案）`:'請安裝 Python 3.10 以上，或填入 python.exe 路徑'};},
  },
  {
    id:'harness',name:'自訂 Harness',category:'流程',prefix:'harness',kind:'harness',chatSafe:true,
    // 不提供工具：勾選後這段對話的每則訊息都交給選定的腳本跑完整個流程（main.js 的 harness 分支）
    summary:'勾選後，這段對話的訊息交給你選的 Harness 腳本（.txt）跑完整個流程：多階段 prompt、會自己寫程式跑指令的代理、檢查不合格就退回重做，都能自由組合；也能選「依目標自動建立」讓模型先寫一份新腳本再執行。',
    detail:'腳本存在 userData\\harness 資料夾，一份腳本一個 .txt，用記事本就能改；內建 4 份範本（通用流程、程式代理、研究查證、寫作）。模型預設沿用目前對話，每個步驟也可以另外指定模型或降低權限；代理步驟的權限不會超過這段對話的權限，刪除保護照樣有效。每回合的模型呼叫次數＝腳本實際執行的步驟數（含檢查退回重做）。',
    detect(cfg){const n=(()=>{try{return require('fs').readdirSync(require('path').join(require('electron').app.getPath('userData'),'harness')).filter((x)=>/\.txt$/i.test(x)).length;}catch{return 0;}})();return {available:true,path:'',note:`${n?`已有 ${n} 份腳本`:'第一次使用時會建立 4 份範本'}；預設腳本：${String(cfg.defaultScript||'').trim()||'範本-通用流程.txt'}；模型沿用目前對話`};},
  },
  {
    id: 'primeAgent',
    name: 'Prime Agent',
    category: '解難題',
    prefix: 'prime_agent',
    kind: 'prime',
    summary: '預設由工作台代理沿用目前對話的模型與登入方式處理任務；也可切換為原生 Prime Agent（獨立 API 設定）。',
    detail: '它會在這段對話的專案資料夾裡自己讀寫檔案、執行指令，等於多一個獨立的代理幫忙。跟 Zenith、Scrapling 是三個各自獨立的工具包。',
    detect(cfg) {
      if (cfg.mode !== 'native') return {available:true,path:'',note:'沿用目前對話的模型與登入方式（工作台代理引擎）'};
      const bin = primeAgent.resolveBin(cfg.path);
      return bin ? { available: true, path: bin, note: `已找到：${bin}` } : { available: false, path: '', note: primeAgent.INSTALL_HINT };
    },
  },
  {
    id: 'zenith',
    name: 'Zenith',
    category: '解難題',
    prefix: 'zenith',
    kind: 'mcp',
    summary: 'Intelligent Internet 的長任務 harness：把一個大目標拆成任務清單，派 worker 去做、再派 validator 獨立驗收，做不完就重新規劃。預設沿用目前對話的模型與登入方式。',
    detail: '適合要跑好幾個小時、容易「做一半就說做完了」的工作。跟 Prime Agent 不同：Prime Agent 是一個代理做到底，Zenith 是指揮一整組代理分工與驗收。它派工靠 ACP 轉接器跑 Claude Code 或 Codex；對話用 DeepSeek、Gemini、Grok 或 GPT API 時，worker 仍由 Claude Code 執行，但模型換成你選的那一個（DeepSeek 走官方 Anthropic 相容端點，其餘走工作台本機轉譯代理），用該供應商的金鑰計費。',
    detect(cfg) {
      const uv = findUv(cfg.uvPath);
      const root = findZenithRoot(cfg.path);
      if (!uv) return { available: false, path: '', note: '找不到 uv。請先安裝 uv（https://docs.astral.sh/uv/），Zenith 是 Python 專案，要靠它啟動。' };
      if (!root) return { available: false, path: '', note: ZENITH_INSTALL_HINT };
      if (!isDir(path.join(root, '.venv'))) return { available: false, path: root, note: `已找到 Zenith 原始碼（${root}），但還沒建立環境。請在該資料夾執行 uv sync。` };
      const acp = findAcpDir();
      // Windows 不開開發人員模式就建不了 symlink，Zenith 建專案會死在這裡，所以先就地修好
      const fix = zenithPatch.ensureWindowsLinks(root);
      const fixNote = fix.status === 'skipped' ? `；⚠ Windows 連結修正未套用：${fix.reason}` : '';
      const fixedWorker = cfg.worker === 'codex' || cfg.worker === 'claude' ? cfg.worker : '';
      const workerNote = fixedWorker ? `；worker 固定用 ${fixedWorker === 'codex' ? 'Codex' : 'Claude Code'}` : '；worker 沿用目前對話的模型與登入方式';
      return {
        available: true,
        path: root,
        note: `已找到：${root}${acp ? `；worker 轉接器：${acp}` : '；尚未安裝 ACP 轉接器，worker 會無法派工（npm i -g @agentclientprotocol/claude-agent-acp）'}${workerNote}${fixNote}`,
      };
    },
    spec(cfg, ctx = {}) {
      const uv = findUv(cfg.uvPath);
      const root = findZenithRoot(cfg.path);
      if (!uv || !root) throw new Error('找不到 uv 或 Zenith 專案資料夾');
      zenithPatch.ensureWindowsLinks(root);
      require('./zenithRuntimePatch').ensure(root);
      const acp = findAcpDir();
      const node22 = findNode22();
      const picked = zenithWorker(cfg, ctx);
      const env = {
        // Zenith 的輸出含 em dash 等字元，Windows 預設的 cp932／cp950 會讓 stdout 壞掉
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ZENITH_HOME: ctx.sessionRoot ? path.join(ctx.sessionRoot, 'zenith') : path.join(os.homedir(), '.zenith', 'home'),
        ZENITH_WORKER_PROVIDER: picked.provider,
        ZENITH_VALIDATOR_PROVIDER: picked.provider,
        ...picked.env,
        ZENITH_MAX_PARALLEL_NODES: String(Math.min(8, Math.max(1, Number(cfg.parallel) || 2))),
      };
      const extraPath = [acp, node22].filter(Boolean).join(path.delimiter);
      if (extraPath) env.PATH = `${extraPath}${path.delimiter}${process.env.PATH || ''}`;
      return {
        transport: 'stdio',
        command: uv,
        args: ['run', '--project', root, 'zenith-server', '--mode', 'orchestrator'],
        env,
        // 沿用／退回的結果要讓使用者看得到，openSession 會把這些轉成對話裡的提示
        notices: picked.notices,
        // 需要本機轉譯代理時，由 openSession 啟動並把端點補進 env
        proxy: picked.proxy || null,
        startupMs: 180000,
        // advance_project 是刻意阻塞的：它會等 worker 真的把任務跑完，可能好幾十分鐘
        callMs: 3600000,
      };
    },
  },
  {
    id: 'scrapling',
    name: 'Scrapling',
    category: '爬蟲',
    prefix: 'scrapling',
    kind: 'mcp',
    chatSafe: true, // 只上網抓資料，不會動到這台電腦的檔案，所以「僅聊天」模式也能用
    // Claude Code 內建的抓網頁工具會搶走這件事，勾了擴充卻看不到它被用到，所以這回合把它關掉
    nativeDisallow: ['WebFetch', 'WebSearch'],
    summary: '抓網頁：一般請求、JS 渲染、以及可繞過反爬蟲的隱形模式，並可轉成 Markdown。',
    detail: '適合大量或會擋機器人的網站；跟內建瀏覽器不同，它不需要開視窗，速度快很多。這是純爬蟲工具，不會幫你解題。',
    detect(cfg) {
      const bin = findScrapling(cfg.path);
      return bin
        ? { available: true, path: bin, note: `已找到：${bin}` }
        : { available: false, path: '', note: '找不到 scrapling。請先安裝（pip install "scrapling[fetchers]" 後執行 scrapling install），或在下面填執行檔路徑。' };
    },
    spec(cfg) {
      const bin = findScrapling(cfg.path);
      if (!bin) throw new Error('找不到 scrapling 執行檔');
      return { transport: 'stdio', command: bin, args: ['mcp'], startupMs: 90000, callMs: 300000 };
    },
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    category: '搜尋',
    prefix: 'searxng',
    kind: 'searxng',
    chatSafe: true, // 只查搜尋引擎，不碰這台電腦的檔案
    nativeDisallow: ['WebSearch'],
    summary: '元搜尋引擎：同一個查詢同時問 Google、Bing、Yahoo、Yandex、DuckDuckGo、Brave、Qwant 等十幾個引擎，合併去重後排序；另有「窮搜」把多種寫法 × 多頁全部查過。',
    detail: 'SearXNG（github.com/searxng/searxng，AGPL-3.0）在本機背景執行，只聽 127.0.0.1、不開任何視窗，第一次搜尋時才啟動、App 關閉時一起結束。它只負責「找網址」；要讀網頁全文，同時勾 Scrapling 效果最好。不需要任何 API 金鑰，也不花模型費用。',
    detect(cfg) { return require('./searxng').status(cfg); },
  },
];

const ZENITH_INSTALL_HINT = 'Zenith 安裝方式：git clone https://github.com/Intelligent-Internet/zenith 到（例如）%USERPROFILE%\\.zenith\\src，再到其中的 zenith 資料夾執行 uv sync；worker 還需要 npm i -g @agentclientprotocol/claude-agent-acp。裝好後回到「API 設定 → 能力擴充」按「重新偵測」。';

const ZENITH_WORKER_LABEL = { claude: 'Claude Code', codex: 'Codex' };

/**
 * 決定 Zenith 這次要用哪個 worker，以及要不要把對話的模型帶過去。
 *
 * Zenith 派工一律透過 ACP 轉接器，而轉接器只有 Claude Code 與 Codex 兩種，
 * 所以「沿用目前對話」只有在對話本身就走這兩種 CLI 時才成立。對不上的時候寧可退回、
 * 也要把理由講出來：靜默換一個 worker，使用者會以為 Zenith 正在用他選的模型做事。
 *
 * 回傳 { provider, env, notices, inherited }；env 只放跟 worker 有關的變數。
 */
function zenithWorker(cfg = {}, ctx = {}) {
  const mode = cfg.worker === 'claude' || cfg.worker === 'codex' ? cfg.worker : 'inherit';
  const fallback = cfg.fallback === 'codex' ? 'codex' : 'claude';
  const env = {};
  const notices = [];
  if (mode !== 'inherit') return { provider: mode, env, notices, inherited: false };

  const conversation = ctx.conversation || {};
  const provider = String(conversation.provider || '');
  const via = String(conversation.via || '');
  // 模型是空字串代表「用 CLI 自己的預設」，這時候不能塞空值進去，否則 CLI 會拿空字串當模型名
  const model = String(conversation.model || '').trim();
  const modelLabel = model || '它自己的預設模型';

  if (provider === 'claude') {
    if (model) env.ANTHROPIC_MODEL = model;
    // 訂閱登入的 Claude Code 自己有憑證；走 API 金鑰時轉接器是另一個行程，拿不到 app 這邊的金鑰
    const byKey = via !== 'claudecode';
    if (byKey && (ctx.apiKeys || {}).claude) env.ANTHROPIC_API_KEY = ctx.apiKeys.claude;
    notices.push(`Zenith 這次沿用目前對話：worker 與 validator 都用 Claude Code（${modelLabel}，${byKey ? 'Anthropic API 金鑰' : '訂閱登入'}）。`);
    return { provider: 'claude', env, notices, inherited: true };
  }
  if (provider === 'codex' || (provider === 'gpt' && via === 'codex')) {
    // Codex 的模型只能寫在啟動指令裡：acp_runner 會把指令中的 -c model="…" 解析進 CODEX_CONFIG
    const command = model ? `codex-acp -c model="${model}"` : 'codex-acp';
    env.ZENITH_WORKER_ACP_COMMAND = command;
    env.ZENITH_VALIDATOR_ACP_COMMAND = command;
    notices.push(`Zenith 這次沿用目前對話：worker 與 validator 都用 Codex（${modelLabel}）。`);
    return { provider: 'codex', env, notices, inherited: true };
  }

  // 其他 API 模型：worker 仍然是 Claude Code（ACP 轉接器只有這兩種），但把它的模型端點換掉，
  // 讓它實際在使用者選的模型上工作。DeepSeek 官方就有 Anthropic 相容端點；
  // Gemini、Grok、GPT API 只有 OpenAI 相容端點，改由工作台在本機開轉譯代理。
  const endpoint = conversation.endpoint || {};
  const apiKey = endpoint.apiKey || (ctx.apiKeys || {})[provider] || '';
  const label = API_LABEL[provider] || provider;
  if (API_LABEL[provider] && apiKey) {
    const useModel = model || API_DEFAULT_MODEL[provider] || '';
    const base = String(endpoint.baseUrl || '').trim().replace(/\/+$/, '');
    if (provider === 'deepseek' && (!base || /^https:\/\/api\.deepseek\.com(?:\/v1)?$/i.test(base))) {
      Object.assign(env, {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: useModel, ANTHROPIC_SMALL_FAST_MODEL: useModel, ANTHROPIC_DEFAULT_OPUS_MODEL: useModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: useModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: useModel, CLAUDE_CODE_SUBAGENT_MODEL: useModel,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
      notices.push(`Zenith 這次沿用目前對話：worker 與 validator 由 Claude Code 執行，但模型是 DeepSeek / ${useModel}（DeepSeek 官方 Anthropic 相容端點，用你的 DeepSeek 金鑰計費）。`);
      return { provider: 'claude', env, notices, inherited: true };
    }
    const defaults = { gpt: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', grok: 'https://api.x.ai/v1', meta: 'https://api.meta.ai/v1', ablit: 'https://api.abliteration.ai/v1', lmstudio: 'http://localhost:1234/v1', deepseek: 'https://api.deepseek.com' };
    notices.push(`Zenith 這次沿用目前對話：worker 與 validator 由 Claude Code 執行，但模型是 ${label} / ${useModel}（工作台本機轉譯代理 → ${label} API，用你的 ${label} 金鑰計費）。`);
    return { provider: 'claude', env, notices, inherited: true, proxy: { provider, model: useModel, baseUrl: base || defaults[provider], apiKey, label } };
  }

  const who = provider ? `${provider}${model ? ` / ${model}` : ''}` : '這次沒有對話模型資訊';
  const why = API_LABEL[provider] && !apiKey ? `找不到 ${label} 的 API 金鑰` : '這個模型沒有可用的沿用方式';
  notices.push(`Zenith 無法沿用目前對話的 ${who}（${why}），這次改用 ${ZENITH_WORKER_LABEL[fallback]}。想固定用哪一個，可到「API 設定 → 能力擴充 → Zenith」指定。`);
  return { provider: fallback, env, notices, inherited: false };
}
const API_LABEL = { gpt: 'GPT', gemini: 'Gemini', grok: 'Grok', meta: 'Meta', ablit: 'Abliteration', lmstudio: 'LM Studio', deepseek: 'DeepSeek' };
const API_DEFAULT_MODEL = { gpt: 'gpt-6-sol', gemini: 'gemini-3.8-flash', grok: 'grok-4.6', meta: 'muse-spark-1.3', ablit: 'abliterated-model-large-v2', deepseek: 'deepseek-flash' };

const BUILTIN_IDS = new Set(BUILTINS.map((p) => p.id));
const cfgFor = (settings, id) => (settings?.extensions?.config || {})[id] || {};
const customList = (settings) => (settings?.extensions?.custom || []).filter((c) => c && c.id);

/** 使用者自訂的 MCP 伺服器也包成同樣的形狀。 */
function customPack(entry) {
  if (entry.kind === 'prompt') return {
    id: entry.id, name: entry.name || entry.id, category: 'Prompt',
    prefix: sanitize(entry.id), kind: 'prompt', custom: true, chatSafe: true,
    summary: 'Markdown 指示；只會將內容帶入這段對話，不執行腳本。',
    detail: entry.sourcePath || '',
    detect() { return { available: typeof entry.content === 'string' && !!entry.content.trim() && Buffer.byteLength(entry.content, 'utf8') <= 256 * 1024, path: entry.sourcePath || '', note: '已保存 Markdown 內容快照' }; },
  };
  return {
    id: entry.id,
    name: entry.name || entry.id,
    category: '自訂',
    prefix: sanitize(entry.prefix || entry.id),
    kind: 'mcp',
    custom: true,
    summary: entry.summary || (entry.transport === 'http' ? `自訂 MCP：${entry.url || ''}` : `自訂 MCP：${entry.command || ''}`),
    detail: '',
    detect() {
      if (entry.transport === 'http') return entry.url ? { available: true, path: entry.url, note: entry.url } : { available: false, path: '', note: '沒有填網址' };
      return exists(entry.command) || !path.isAbsolute(String(entry.command || ''))
        ? { available: !!entry.command, path: entry.command || '', note: entry.command || '沒有填執行檔' }
        : { available: false, path: '', note: `找不到 ${entry.command}` };
    },
    spec() {
      if (entry.transport === 'http') return { transport: 'http', url: entry.url, headers: entry.headers || {}, startupMs: 60000 };
      return { transport: 'stdio', command: entry.command, args: entry.args || [], env: entry.env || {}, startupMs: 90000 };
    },
  };
}

function allPacks(settings) {
  const external = settings?.extensions?.externalSkills === true;
  const loaded = settings?.extensions?.loadedBuiltins || [];
  return [...BUILTINS.filter(p => !(settings?.extensions?.removed || []).includes(p.id) && (!external || loaded.includes(p.id))), ...customList(settings).filter(p => !(settings?.extensions?.removed || []).includes(p.id)).map(customPack)];
}

/** Selected Markdown is data-only. No command, MCP or script is executed. */
function promptSkills(settings, selection) {
  const selected = new Set(selectionFor(settings, selection));
  const chunks = [];
  let bytes = 0;
  for (const entry of customList(settings)) {
    if (entry.kind !== 'prompt' || !selected.has(entry.id)) continue;
    if (typeof entry.content !== 'string' || !entry.content.trim() || Buffer.byteLength(entry.content, 'utf8') > 256 * 1024) throw new Error(`skill「${entry.name || entry.id}」內容無效或超過 256 KiB`);
    const text = `\n\n[skill: ${String(entry.name || entry.id).slice(0, 160)}]\n${entry.content}\n[/skill]\n`;
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 1024 * 1024) throw new Error('所選 skill 內容總和超過 1 MiB，請減少選取數量');
    chunks.push(text);
  }
  return chunks.join('');
}

function sanitize(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '').slice(0, 40) || 'ext';
}

/** 給畫面用：每個工具包的狀態。 */
function describe(settings) {
  const enabled = new Set(settings?.extensions?.enabled || []);
  return allPacks(settings).map((p) => {
    let status;
    try { status = p.detect(cfgFor(settings, p.id)); } catch (e) { status = { available: false, path: '', note: e.message }; }
    return {
      id: p.id, name: p.name, kind: p.kind, custom: !!p.custom, prefix: p.prefix, category: p.category || '自訂',
      summary: p.summary, detail: p.detail || '',
      available: !!status.available, path: status.path || '', note: status.note || '',
      enabled: enabled.has(p.id),
    };
  });
}

/** 這次執行要啟用哪些工具包：對話有指定就用對話的，沒有就用全域預設。 */
// 沒有指定就是「全不開」：擴充只跟著各自的對話走，不再有會蔓延到所有對話的全域預設
function selectionFor(settings, override) {
  const ids = Array.isArray(override) ? override : [];
  const known = new Set(allPacks(settings).map((p) => p.id));
  return [...new Set(ids.filter((id) => known.has(id)))];
}

function toFunctionDef(prefix, tool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: `${prefix}_${sanitize(tool.name)}`.slice(0, 64),
      description: tool.description || `${prefix} 的 ${tool.name}`,
      parameters: { type: 'object', properties: schema.properties || {}, required: schema.required || [], ...(schema.additionalProperties === false ? { additionalProperties: false } : {}) },
    },
  };
}

const PRIME_TOOLS = (prefix) => [
  {
    type: 'function',
    function: {
      name: `${prefix}_task`,
      description: 'Prime Agent：把一個完整、獨立的難題交給 Prime Agent 處理。它會在這段對話的專案資料夾裡自己讀檔、寫檔、跑指令，最後把結論回給你。適合需要長時間反覆嘗試的任務；簡單的事情自己做就好，不要每件事都丟給它。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要它完成的任務，寫清楚目標、限制與完成條件' },
          model: { type: 'string', description: '可選：幾乎都該留空，改用使用者在「能力擴充」設定好的模型。只有使用者這次明確指定時才填，而且必須是 Prime Agent 已載入的模型 ID（例如 anthropic/claude-opus-5）；填不存在的 ID 會被忽略。' },
          timeout_minutes: { type: 'number', description: '可選：最久等幾分鐘（預設 20，最多 60）' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: `${prefix}_followup`,
      description: 'Prime Agent：接著上一個 prime_agent_task 再追加指示（同一個工作階段，記得前面做過什麼）。要先呼叫過 prime_agent_task 才能用。',
      parameters: { type: 'object', properties: { message: { type: 'string', description: '追加的指示' } }, required: ['message'], additionalProperties: false },
    },
  },
];

/** Prime Agent 用環境變數取得金鑰；這裡把 app 已經有的金鑰換成它認得的名稱。 */
const PRIME_KEY_ENV = {
  claude: 'ANTHROPIC_API_KEY',
  gpt: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
};
const PRIME_PROVIDER = { claude: 'anthropic', gpt: 'openai', deepseek: 'deepseek', gemini: 'google', grok: 'xai' };

function primeAuth(cfg, apiKeys = {}) {
  const env = {};
  for (const [appProvider, varName] of Object.entries(PRIME_KEY_ENV)) {
    const key = apiKeys[appProvider];
    if (key) env[varName] = key;
  }
  // 沒有指定供應商時，挑第一個有金鑰的來用，免得它開起來說「沒有可用的模型」
  const order = ['claude', 'gemini', 'deepseek', 'gpt', 'grok'];
  const picked = cfg.provider || PRIME_PROVIDER[order.find((p) => apiKeys[p])] || '';
  return { env, provider: picked };
}

/**
 * 建立這次執行要用的擴充工具。
 * ctx: { settings, selection, cwd, chatId, sessionRoot, version, apiKeys, onNotice, onProgress }
 * 回傳 { tools, names, labels, execute, close, notices, active }
 */
async function openSession(ctx = {}) {
  const settings = ctx.settings || {};
  const ids = selectionFor(settings, ctx.selection);
  const packs = allPacks(settings).filter((p) => ids.includes(p.id));
  const tools = [];
  const labels = new Map();
  const annotations = new Map();
  const routes = new Map();     // 工具名稱 -> 執行函式
  const closers = [];
  const notices = [];
  const active = [];
  const used = new Set();

  const uniquePrefix = (p) => {
    let prefix = sanitize(p.prefix || p.id);
    while (used.has(prefix)) prefix = `${prefix}_${p.id}`.slice(0, 40);
    used.add(prefix);
    return prefix;
  };

  for (const pack of packs) {
    // 陪伴角色不是工具包：它接管整段對話的回覆，由 main.js 在送出時直接處理
    if (pack.kind === 'companion' || pack.kind === 'harness' || pack.kind === 'aoko' || pack.kind === 'prompt') continue;
    // 「僅聊天」時：API 模型還是可以用不碰檔案的工具包（例如 Scrapling）；
    // 但 Codex／Claude Code 這類原生 CLI 在僅聊天模式下會被關掉所有工具，連 MCP 也叫不動，
    // 所以這裡就不要讓它顯示成「已啟用」卻其實用不了。
    if (ctx.level === 'chat' && (!pack.chatSafe || ctx.noToolsInChat)) {
      notices.push(`「${pack.name}」這次沒有啟用：目前的權限是「僅聊天」，模型拿不到任何工具。請把輸入框下方的權限改成「唯讀」以上，再送出一次。`);
      continue;
    }
    const cfg = cfgFor(settings, pack.id);
    const prefix = uniquePrefix(pack);
    try {
      if(pack.kind==='ragthoven') {
        const runtime=require('./ragthoven');
        if(!runtime.python(cfg.path))throw new Error('找不到 Python 3.10 以上');
        const name=`${prefix}_write_joke`;
        tools.push({type:'function',function:{name,description:'使用已內建的 RAGthoven MWAHAHA 工具鏈寫笑話，沿用目前對話模型。依序執行規劃、候選、修稿、評選及約束檢查，通常 4 次模型呼叫。',parameters:{type:'object',properties:{topic:{type:'string',description:'笑話主題'},language:{type:'string',description:'輸出語言，預設繁體中文'},style:{type:'string',description:'風格與限制'},word1:{type:'string',description:'可選：必須包含的字詞'},word2:{type:'string',description:'可選：第二個必含字詞'}},required:['topic'],additionalProperties:false}}});
        const runner=ctx.createConversationAgent?.('ragthoven');
        labels.set(name,'RAGthoven 寫笑話');
        routes.set(name,(args,opts)=>runtime.execute(args,{pythonPath:cfg.path,runner,signal:opts?.signal,onProgress:opts?.onProgress}));
        active.push({id:pack.id,name:pack.name,tools:1,toolNames:[name]});
        continue;
      }
      if (pack.kind === 'searxng') {
        const sx = require('./searxng');
        if (!sx.status(cfg).available) throw new Error(sx.status(cfg).note);
        const defs = sx.toolDefs(prefix);
        const [searchName, deepName, enginesName] = defs.map((d) => d.function.name);
        tools.push(...defs);
        labels.set(searchName, 'SearXNG 搜尋'); labels.set(deepName, 'SearXNG 窮搜'); labels.set(enginesName, 'SearXNG 引擎清單');
        // 服務在第一次真的要搜尋時才啟動：只勾選、沒用到就不會多開一個 Python
        const base = (opts) => sx.ensure(cfg, { signal: opts?.signal, onProgress: opts?.onProgress });
        routes.set(searchName, async (args, opts) => sx.search(await base(opts), args, { signal: opts?.signal }, cfg));
        routes.set(deepName, async (args, opts) => sx.deepSearch(await base(opts), args, cfg, { signal: opts?.signal, onProgress: opts?.onProgress }));
        routes.set(enginesName, async (args, opts) => sx.engines(await base(opts), args));
        active.push({ id: pack.id, name: pack.name, tools: 3, toolNames: [searchName, deepName, enginesName], nativeDisallow: pack.nativeDisallow || [] });
        continue;
      }
      if(pack.kind==='scriptDoctor') {
        const runtime=require('./scriptDoctor');
        const runner=ctx.createConversationAgent?.('scriptDoctor');
        const write=`${prefix}_write`,review=`${prefix}_review`;
        const timeout=fallback=>({type:'number',description:`整條流程的總時間上限（分鐘，1–60），預設 ${fallback}`});
        tools.push({type:'function',function:{name:write,description:'用 Script Doctor 多階段流程寫故事或劇本，沿用目前對話模型：logline → 角色與結構大綱 → 分場 → 初稿（預設 Fountain）→ 診斷 → 修稿 → 最終檢查，約 6 次模型呼叫。',parameters:{type:'object',properties:{premise:{type:'string',description:'題材或需求'},length:{type:'string',description:'篇幅，例如「短片 5 場」「10 分鐘」'},format:{type:'string',description:'格式，預設 Fountain 劇本；寫「短篇小說」則輸出散文體'},language:{type:'string',description:'輸出語言，預設繁體中文'},genre:{type:'string',description:'可選：類型與調性'},timeout_minutes:timeout(30)},required:['premise'],additionalProperties:false}}});
        tools.push({type:'function',function:{name:review,description:'用 Script Doctor 診斷使用者既有的劇本或故事：確定性格式檢查＋事實／技藝稽核（嚴重度、改寫建議），再產出修稿建議或完整修訂稿，約 2 次模型呼叫。',parameters:{type:'object',properties:{script:{type:'string',description:'要診斷的劇本或故事全文'},goal:{type:'string',description:'可選：修稿目標'},format:{type:'string',description:'可選：格式；不填則自動判斷'},language:{type:'string',description:'輸出語言，預設繁體中文'},rewrite:{type:'boolean',description:'true 時直接產出完整修訂稿，預設只給修稿建議'},timeout_minutes:timeout(20)},required:['script'],additionalProperties:false}}});
        labels.set(write,'Script Doctor 寫劇本');labels.set(review,'Script Doctor 診斷劇本');
        const run=fn=>(args,opts)=>runtime[fn](args,{runner,signal:opts?.signal,onProgress:opts?.onProgress});
        routes.set(write,run('write'));routes.set(review,run('review'));
        active.push({id:pack.id,name:pack.name,tools:2,toolNames:[write,review]});
        continue;
      }
      if (pack.kind === 'prime') {
        if (cfg.mode !== 'native' && ctx.createConversationAgent) {
          const runner = ctx.createConversationAgent('prime');
          for (const def of PRIME_TOOLS(prefix)) {
            const copy = JSON.parse(JSON.stringify(def));
            copy.function.description = copy.function.name.endsWith('_followup') ? '向前一個工作台代理追加指示；沿用目前對話選用的模型與登入方式，保留既有任務紀錄。' : '將完整獨立任務交給工作台代理，沿用目前對話選用的模型與登入方式。使用者可在對話模型選單自由切換。這是工作台引擎，不是原生 PrimeIntellect 執行程序。';
            if (copy.function.parameters.properties.model) delete copy.function.parameters.properties.model;
            tools.push(copy);
          }
          const run = (followup) => async(args,opts) => {
            const result=await runner.ask(String(followup?args.message:args.task).trim(),{followup,signal:opts?.signal,timeoutMs:Math.min(60,Math.max(1,Number(args.timeout_minutes)||20))*60000,onProgress:opts?.onProgress});
            return `${result.text}\n\n［工作台代理，沿用對話：${ctx.conversation.provider} / ${ctx.conversation.model || '預設模型'}；${ctx.conversation.via}］`;
          };
          labels.set(`${prefix}_task`,'代理任務（沿用對話模型）');
          labels.set(`${prefix}_followup`,'代理追加指示（沿用對話模型）');
          routes.set(`${prefix}_task`,run(false));routes.set(`${prefix}_followup`,run(true));
          active.push({id:pack.id,name:'代理任務（沿用對話模型／工作台引擎）',tools:2,toolNames:[`${prefix}_task`,`${prefix}_followup`]});
          continue;
        }
        const bin = primeAgent.resolveBin(cfg.path);
        if (!bin) throw new Error(primeAgent.INSTALL_HINT);
        const auth = primeAuth(cfg, ctx.apiKeys || {});
        let session = null;
        let starting = null;
        let currentModel = cfg.model || '';
        let currentProvider = auth.provider;
        const askPrime = (s, message, options) => require('./primeFallback').ask({
          session:s, message, options, config:cfg,
          current:() => ({provider:currentProvider, model:currentModel}),
          setCurrent:next => { currentProvider = next.provider; currentModel = next.model; },
          notice:message => { notices.push(message); ctx.onNotice?.(message); },
        });
        // 起 session 時只用設定裡的模型：模型自己指定的 ID 還沒驗證過，
        // 拿去當 --model 會讓整個 Prime Agent 開不起來。啟動後再用 useModel 切。
        const ensure = async () => {
          if (session && !session.closed) return session;
          if (session?.closed) starting = null;
          if (!starting) {
            currentModel = cfg.model || '';
            currentProvider = auth.provider;
            starting = (async () => primeAgent.createSession({
              bin,
              cwd: ctx.cwd || undefined,
              provider: auth.provider,
              model: currentModel,
              env: auth.env,
              sessionDir: ctx.sessionRoot ? path.join(ctx.sessionRoot, 'prime-agent') : '',
            }))().catch((e) => { starting = null; throw e; });
          }
          session = await starting;
          return session;
        };
        closers.push(() => { try { session?.close(); } catch { /* 已結束 */ } });
        for (const def of PRIME_TOOLS(prefix)) tools.push(def);
        labels.set(`${prefix}_task`, 'Prime Agent 任務');
        labels.set(`${prefix}_followup`, 'Prime Agent 追加指示');
        // 指定模型時先對照 Prime Agent 真正載入的清單：
        // 它只認得「有金鑰的供應商」底下那些 ID，而且模型屬於哪一家要由清單決定，
        // 不能沿用目前的供應商，否則 anthropic + gemini-… 這種組合一定換來 Model not found。
        const useModel = async (s, wanted) => {
          const want = String(wanted || '').trim();
          if (!want || want === currentModel) return;
          const models = await s.availableModels().catch(() => []);
          const hit = primeAgent.matchModel(models, want, '');
          if (!hit) {
            const known = models.length ? `目前可用的模型：${models.slice(0, 12).map((m) => `${m.provider}/${m.id}`).join('、')}${models.length > 12 ? ' 等' : ''}。` : '目前 Prime Agent 沒有載入任何模型，請先在「API 設定」填好對應供應商的 API 金鑰。';
            const text = `Prime Agent 沒有「${want}」這個模型，這次沿用 ${currentProvider || '預設供應商'} / ${currentModel || '預設模型'}。${known}`;
            notices.push(text);
            ctx.onNotice?.(text);
            return;
          }
          if (hit.provider === currentProvider && hit.id === currentModel) return;
          await s.command('set_model', { provider: hit.provider, modelId: hit.id });
          currentProvider = hit.provider;
          currentModel = hit.id;
        };
        routes.set(`${prefix}_task`, async (args, opts) => {
          const s = await ensure();
          await useModel(s, args.model);
          const minutes = Math.min(60, Math.max(1, Number(args.timeout_minutes) || 20));
          const r = await askPrime(s, String(args.task || '').trim(), { signal: opts?.signal, timeoutMs: minutes * 60000, onTool: opts?.onProgress });
          return `${r.text || '（Prime Agent 沒有輸出文字）'}${r.tools.length ? `\n\n［Prime Agent 使用了 ${r.tools.length} 次工具：${[...new Set(r.tools)].slice(0, 12).join('、')}］` : ''}`;
        });
        routes.set(`${prefix}_followup`, async (args, opts) => {
          if (!session || session.closed) throw new Error('Prime Agent 還沒開始工作，請先用 prime_agent_task 交付任務。');
          const r = await askPrime(session, String(args.message || '').trim(), { signal: opts?.signal, timeoutMs: 20 * 60000, onTool: opts?.onProgress });
          return r.text || '（Prime Agent 沒有輸出文字）';
        });
        active.push({ id: pack.id, name: pack.name, tools: 2, toolNames: [`${prefix}_task`, `${prefix}_followup`], nativeDisallow: pack.nativeDisallow || [] });
        continue;
      }

      // 一般 MCP 工具包
      const { notices: specNotices, proxy: proxySpec, ...spec } = pack.spec(cfg, ctx);
      if (proxySpec) {
        const proxy = await require('./anthropicProxy').start(proxySpec);
        closers.push(() => proxy.close());
        spec.env = { ...(spec.env || {}), ...proxy.env() };
      }
      // 工具包在決定怎麼啟動時（例如 Zenith 沿用或退回 worker）也會有話要說
      for (const text of specNotices || []) { notices.push(text); ctx.onNotice?.(text); }
      const client = await mcpClient.connect({ ...spec, version: ctx.version || '0', cwd: ctx.cwd || undefined });
      closers.push(() => { try { client.close(); } catch { /* 已結束 */ } });
      const names = [];
      for (const tool of client.tools) {
        const def = toFunctionDef(prefix, tool);
        if (routes.has(def.function.name)) continue;
        tools.push(def);
        names.push(def.function.name);
        labels.set(def.function.name, `${pack.name}：${tool.name}`);
        annotations.set(def.function.name, { ...(tool.annotations || {}) });
        routes.set(def.function.name, (args, opts) => client.call(tool.name, args, { signal: opts?.signal }));
      }
      active.push({ id: pack.id, name: pack.name, tools: names.length, toolNames: names, nativeDisallow: pack.nativeDisallow || [] });
    } catch (e) {
      notices.push(`「${pack.name}」這次沒有啟用：${e.message}`);
      ctx.onNotice && ctx.onNotice(`「${pack.name}」這次沒有啟用：${e.message}`);
    }
  }

  return {
    tools,
    active,
    notices,
    names: new Set(routes.keys()),
    // 這回合要關掉的「原生 CLI 內建同類工具」，避免模型繞過使用者勾的擴充
    nativeDisallow: [...new Set(active.flatMap((a) => a.nativeDisallow || []))],
    label: (name) => labels.get(name) || name,
    annotations: (name) => ({ ...(annotations.get(name) || {}) }),
    has: (name) => routes.has(name),
    execute: (name, args, opts) => {
      const fn = routes.get(name);
      if (!fn) throw new Error(`沒有這個擴充工具：${name}`);
      return fn(args || {}, opts || {});
    },
    close() { for (const fn of closers.splice(0)) { try { fn(); } catch { /* 已結束 */ } } },
  };
}

/**
 * 給模型看的說明。使用者是「特地勾選」才會有這段，所以講法要明確：
 * 對得上的工作就直接呼叫，不要只是提一句「可以用某某工具」然後自己土法煉鋼。
 */
function promptHint(active) {
  if (!active || !active.length) return '';
  const detail = {
    ragthoven:'・RAGthoven（ragthoven_write_joke）：使用官方 MWAHAHA 幽默工具鏈的工作台適配版寫笑話。使用者要寫笑話時實際呼叫工具；模型與登入方式沿用目前對話，通常呼叫模型 4 次，最多 5 次。',
    scriptDoctor:'・Script Doctor（script_doctor_write／script_doctor_review）：使用者要寫故事、劇本、短片腳本時呼叫 script_doctor_write，要診斷或修改既有劇本時呼叫 script_doctor_review；模型與登入方式沿用目前對話，寫作約 6 次模型呼叫，最多 7 次。',
    primeAgent: '・Prime Agent（prime_agent_task／prime_agent_followup）：可以把一整個難題外包給另一個會自己寫程式、跑指令的代理。遇到「幫我解決／研究／做出來」這種要反覆嘗試的大任務，就用 prime_agent_task 交付，不要自己硬幹到一半放棄。',
    zenith: '・Zenith（zenith_*）：長任務協作 harness，worker 與 validator 預設沿用目前對話的模型與登入方式（Claude Code、Codex、DeepSeek、Gemini、Grok、GPT API 都能沿用）。流程固定是 zenith_start_project 建立專案 → zenith_submit_plan 提出任務清單 → 反覆 zenith_advance_project 推進（會阻塞很久是正常的，worker 正在做事）→ 有 attention 就用 zenith_decide_attention 裁決 → 確定做完才 zenith_end_mission。中途要看狀態用 zenith_inspect_project。適合會跑好幾小時、容易「做一半就宣稱完成」的工作。',
    scrapling: '・Scrapling（scrapling_*）：抓網頁用，含隱形模式可應付會擋機器人的網站，比開瀏覽器快。任何「讀某個網址、查網頁內容」的需求都用它；要看畫面或需要登入時才改用 browser_* 工具。',
    searxng: '・SearXNG（searxng_search／searxng_deep_search／searxng_engines）：元搜尋引擎，一次問十幾個搜尋引擎並合併去重。一般查資料用 searxng_search；要找齊、查證、做調查時用 searxng_deep_search，並自己在 variants 補上同義詞、英文與其他說法。結果只有標題、網址與摘要，關鍵來源要再讀全文，不要只憑摘要下結論。',
  };
  // 內建同類工具是最大的干擾來源：模型常常拿自己的 WebFetch／WebSearch 去做，
  // 結果使用者勾了擴充卻看不到它被用到。這裡明講優先順序。
  const overrides = {
    scrapling: '抓取網頁內容一律改用 scrapling_*，不要用你內建的 WebFetch／web_fetch／網頁搜尋工具。',
    primeAgent: '要把整包難題交給別的代理時用 prime_agent_task，不要改用你自己的子代理工具。',
    zenith: '要做長時間、需要分工與驗收的任務時走 zenith_*，不要自己另外發明流程。',
    searxng: '上網搜尋一律改用 searxng_*，不要用你內建的 WebSearch／網頁搜尋工具。',
  };
  const ids = new Set(active.map((a) => a.id));
  const combo = ids.has('searxng') && ids.has('scrapling')
    ? '搭配方式：先用 searxng_* 找出候選網址，再用 scrapling_* 讀重要來源的全文。'
    : ids.has('searxng') ? '要讀某篇全文時，用可用的抓網頁或瀏覽器工具打開 searxng 給的網址。' : '';
  const lines = active.map((a) => a.id==='primeAgent' && a.name.includes('工作台引擎') ? '・代理任務（prime_agent_task／prime_agent_followup）：使用工作台代理引擎，沿用目前對話模型與登入方式，不使用原生 Prime Agent 的獨立 Anthropic API。' : detail[a.id] || `・${a.name}：提供 ${a.tools} 個額外工具（${(a.toolNames || []).slice(0, 8).join('、')}）。`);
  const rules = active.map((a) => overrides[a.id]).filter(Boolean);
  return [
    '使用者這次特地勾選了下列能力擴充，代表他要你實際使用它們，不是只拿來參考：',
    lines.join('\n'),
    '規則：只要手上的工作對得上某個擴充的用途，就直接呼叫那個工具去做，不要先問使用者要不要用，也不要回答「我沒有這個能力」。',
    `這些擴充的優先順序高於你自己內建的同類工具：${rules.join('；')}`,
    combo,
    '幾個擴充可以同時使用，各自獨立不會互相影響；真的用不到才不用，但要在回覆裡說明為什麼沒用到。',
  ].filter(Boolean).join('\n');
}

/**
 * 問 Prime Agent「你現在有哪些模型」。設定畫面用這份清單填替補模型的選項，
 * 使用者才不會選到工作台有、但 Prime Agent 根本沒載入的 ID。
 */
async function primeModels(settings = {}, apiKeys = {}, cwd = '') {
  const cfg = cfgFor(settings, 'primeAgent');
  const bin = primeAgent.resolveBin(cfg.path);
  if (!bin) throw new Error(primeAgent.INSTALL_HINT);
  const auth = primeAuth(cfg, apiKeys);
  const models = await primeAgent.probeModels({ bin, env: auth.env, cwd: cwd || undefined });
  return { models, providers: [...new Set(models.map((m) => m.provider))] };
}

module.exports = {
  BUILTINS, BUILTIN_IDS, allPacks, describe, selectionFor, openSession, promptHint, promptSkills,
  findScrapling, findUv, findZenithRoot, findAcpDir, findNode22, primeAuth, primeModels, zenithWorker, ZENITH_INSTALL_HINT,
};
