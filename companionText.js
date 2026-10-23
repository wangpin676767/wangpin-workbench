'use strict';
// 陪伴角色的全部內容 ⇄ 一份純文字檔（.txt），用記事本就能改。
//
//   【名字】（最多 20 字）
//   葉澄
//
//   【喜歡】（每行一項）
//   拉麵
//   深夜的空蕩公路
//
// 一個欄位從「【欄位名稱】」那一行開始，到下一個欄位之前都是它的內容，可以換行。
// 【】後面括號裡的是說明；檔案開頭以 # 開頭的行、「━━ 人物 ━━」分隔線都會略過。
// 只回傳「檔案裡有的欄位」，沒列到的欄位維持原樣。人物欄位清單與 HTML 表格共用。
//
// 1.9.18 起檔案後半段是「她記得的事」：三份核心筆記、長期記憶、目前成立的事、還在意的事、關係數值、印象。
// 這幾欄的文字原樣放在 patch.memory 裡，怎麼套用由 companion.js 決定（只套用使用者實際改動的行）。

const kit = require('./companionHtml');

const { FORMAT, FIELDS } = kit;
const SCENARIO_PREFIX = '情境反應：';
const EOL = '\r\n';

// 「她記得的事」：[key, 欄位名稱, 說明, 別名...]
const MEMORY_GROUP = '她記得的事';
const MEMORY_FIELDS = [
  ['self', '她對自己的筆記', '核心記憶，每次回覆都會看到', '關於自己'],
  ['human', '她對你的筆記', '核心記憶：她記得的你', '關於你', '她對對方的筆記'],
  ['relationship', '你們之間的筆記', '核心記憶：你們的關係', '你們之間'],
  ['archival', '長期記憶', '每行一件：「[類型 重要度1–10] 內容」。刪掉一行＝讓她忘掉（標成已遺忘，不會真的刪）；新增一行＝讓她記住。類型：承諾、爭執、玩笑、事件、偏好、事實、感受、她的生活、舊筆記', '記得的事'],
  ['facts', '目前成立的事', '每行「代號：內容」。改內容＝這件事變了（舊的標成失效）；刪掉一行＝不再成立', '事實', '時間線'],
  ['grudges', '還在意的事', '每行「[在意程度 0–1] 內容」。刪掉一行＝氣消了', '還沒消氣的事', '記仇'],
  ['relation', '關係數值', '0–100：熟悉、信任、親近、火氣；心情寫文字', '關係'],
  ['impression', '她對你的印象', '一句話'],
];
const MEMORY_KEYS = MEMORY_FIELDS.map((f) => f[0]);
const REV_RE = /檔案版本[:：]\s*r([0-9a-z]+)/i;

// 一整行只有「【…】」（後面可以接括號說明）才算欄位標題
const HEADER_RE = /^[ \t\u3000]*【([^】\r\n]+)】[ \t\u3000]*(?:[（(].*[)）])?[ \t\u3000]*$/;
const DIVIDER_RE = /^[ \t\u3000]*━{2,}.*━{2,}[ \t\u3000]*$/;

function rowsOf(patch, scenarioLabels) {
  const rows = FIELDS.map(([key, group, label, hint]) => ({ key, group, label, hint }));
  for (const id of Object.keys(patch.scenarios || {})) rows.push({ key: `scenario:${id}`, group: '情境反應', label: SCENARIO_PREFIX + (scenarioLabels[id] || id), hint: '偵測到這個情況時額外提醒她的話' });
  return rows;
}

// 內容裡剛好有一行長得像欄位標題或分隔線時，存檔後會被讀成新欄位：前面補一個「\」，讀回來時再拿掉
const ESCAPED_RE = /^\\+(?=[ \t\u3000]*[【━])/;
function protect(value, isHeader) {
  return String(value).replace(/\r\n?/g, '\n').split('\n')
    .map((l) => (isHeader(l) || DIVIDER_RE.test(l) || ESCAPED_RE.test(l) ? '\\' + l : l)).join(EOL);
}

/**
 * 把編輯器的內容（同 companion:saveProfile 的 patch 格式）轉成一份 .txt。
 * scenarioLabels：{ id: 中文名稱 }，情境反應一個情境一個欄位。
 * memory：{ self, human, ... } 她記得的事（每欄一段文字）；有給才會寫進檔案。rev：檔案版本（App 用來比對改了哪幾行）。
 */
function toText(patch = {}, { scenarioLabels = {}, exportedAt = new Date(), stored = false, memory = null, rev = '' } = {}) {
  const idx = textIndex(scenarioLabels);
  const isHeader = (l) => { const m = HEADER_RE.exec(l); return !!m && idx.has(kit.norm(m[1])); };
  const name = String(patch.name || '陪伴角色');
  const out = [
    `# ${name}：${memory ? '角色、Prompt 與她記得的事' : '角色與 Prompt'}`,
    `# Codex Multi 陪伴角色設定檔（${FORMAT}）`,
    stored
      ? '# 這是 App 實際使用的角色設定檔。用記事本改好存檔，她的下一則回覆就會套用；在 App 的「編輯角色與 Prompt」按儲存時，也會寫回這個檔案。'
      : `# 在 Codex Multi 的「編輯角色與 Prompt」按「從 TXT 載入…」讀進來，按儲存才會生效。匯出時間：${exportedAt.toISOString()}`,
    '# 怎麼改：每個欄位從「【欄位名稱】」那一行開始，底下到下一個【…】之前都是內容，可以換行。',
    '#         【】後面括號裡的是說明，不用改；【】那一行本身不要改名。刪掉整個欄位，就維持原本的值。',
    '#         以 # 開頭的說明行（只限檔案開頭這幾行）和「━━ 分類 ━━」分隔線都會略過。',
  ];
  if (memory) {
    out.push('# 她記得的事（檔案最後面）：只會套用你改動的那幾行。你改檔案的同時她又聊了幾句，新記住的事也不會被洗掉。');
    if (rev) out.push(`# 檔案版本：r${rev}（App 用它比對你改了哪幾行，這一行請不要改）`);
  }
  let group = null;
  for (const r of rowsOf(patch, scenarioLabels)) {
    if (r.group !== group) { group = r.group; out.push('', `━━━━━━━━ ${group} ━━━━━━━━`); }
    out.push('', `【${r.label}】${r.hint ? `（${r.hint}）` : ''}`);
    const v = kit.valueOf(patch, r.key);
    if (v !== '') out.push(protect(v, isHeader));
  }
  if (memory) {
    out.push('', `━━━━━━━━ ${MEMORY_GROUP} ━━━━━━━━`);
    for (const [key, label, hint] of MEMORY_FIELDS) {
      out.push('', `【${label}】${hint ? `（${hint}）` : ''}`);
      const v = String(memory[key] == null ? '' : memory[key]);
      if (v !== '') out.push(protect(v, isHeader));
    }
  }
  return out.join(EOL) + EOL;
}

// ------------------------------------------------------------------ 讀回來
function textIndex(scenarioLabels = {}) {
  const idx = kit.labelIndex(scenarioLabels);
  for (const [id, label] of Object.entries(scenarioLabels)) for (const x of [label, id]) {
    idx.set(kit.norm(SCENARIO_PREFIX + x), `scenario:${id}`);
    idx.set(kit.norm('情境' + x), `scenario:${id}`);
  }
  // 分類和欄位同名的「作息」：寫成【作息：作息】也認得
  for (const [key, group, label] of FIELDS) idx.set(kit.norm(group + label), key);
  for (const [key, label, , ...aliases] of MEMORY_FIELDS) for (const a of [label, ...aliases]) idx.set(kit.norm(a), `memory:${key}`);
  return idx;
}

function trimBlock(lines) {
  let a = 0; let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).map((l) => l.replace(/[ \t]+$/, '').replace(ESCAPED_RE, (x) => x.slice(1))).join('\n');
}

/**
 * 解析 .txt，回傳 { patch, found: [欄位名稱], unknown: [對不上的標題], warnings: [], rev }。
 * patch 的格式與 companion:saveProfile 相同，只含檔案裡有的欄位；「她記得的事」放在 patch.memory。
 */
function fromText(text, { scenarioLabels = {} } = {}) {
  const idx = textIndex(scenarioLabels);
  const known = new Set(FIELDS.map((f) => f[0]));
  const patch = {}; const found = []; const unknown = []; const warnings = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  let preamble = true;
  let rev = '';
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    const key = m ? idx.get(kit.norm(m[1])) : null;
    if (key && (known.has(key) || key.startsWith('scenario:') || key.startsWith('memory:'))) {
      preamble = false;
      cur = { key, label: m[1].trim(), lines: [] };
      blocks.push(cur);
      continue;
    }
    if (m && !key) {
      // 長得像標題、但不是認得的欄位：當成上一欄的內容，並提醒（多半是欄位名稱打錯）
      unknown.push(m[1].trim().slice(0, 30));
    }
    if (DIVIDER_RE.test(line)) continue;
    if (preamble) {
      if (line.trim() && !/^\s*#/.test(line)) preamble = false;
      else { const r = REV_RE.exec(line); if (r) rev = r[1].toLowerCase(); continue; }
    }
    if (cur) cur.lines.push(line);
  }
  const seen = new Set();
  for (const b of blocks) {
    const mem = b.key.startsWith('memory:') ? b.key.slice(7) : null;
    const label = mem ? MEMORY_FIELDS.find((f) => f[0] === mem)[1] : kit.labelOf(b.key, scenarioLabels);
    if (seen.has(b.key)) warnings.push(`「${label}」出現兩次，用後面那一個`);
    seen.add(b.key);
    if (mem) {
      patch.memory = patch.memory || {};
      patch.memory[mem] = trimBlock(b.lines);
      if (!found.includes(label)) found.push(label);
      continue;
    }
    if (kit.assignField(patch, b.key, trimBlock(b.lines), label, warnings) && !found.includes(label)) found.push(label);
  }
  for (const u of unknown) warnings.push(`「【${u}】」不是認得的欄位名稱，已當成上一個欄位的內容`);
  if (patch.name !== undefined && !patch.name.trim()) { delete patch.name; warnings.push('名字是空白的，維持原本的名字'); }
  return { patch, found, unknown, warnings, rev };
}

/** 讀 .txt 的位元組：認 BOM；不是有效的 UTF-8 就當 Big5（舊版記事本存的「ANSI」） */
function decodeTextBytes(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) { const s = Buffer.from(b.slice(2)); s.swap16(); return s.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('big5').decode(b); } catch { return b.toString('utf8'); }
}

/** 匯入時用：看內容決定是 TXT 還是舊版的 HTML 表格。TXT 會連原文一起回傳（text），給全文編輯用。 */
function parseAny(buf, { scenarioLabels = {} } = {}) {
  const text = decodeTextBytes(buf);
  if (/^\s*</.test(text) || /<table\b[\s\S]*<tr\b/i.test(text)) {
    return { ...kit.fromHtml(kit.decodeHtmlBytes(buf), { scenarioLabels }), format: 'html' };
  }
  return { ...fromText(text, { scenarioLabels }), format: 'txt', text: text.replace(/^\uFEFF/, '') };
}

module.exports = { FORMAT, MEMORY_FIELDS, MEMORY_KEYS, toText, fromText, decodeTextBytes, parseAny };
