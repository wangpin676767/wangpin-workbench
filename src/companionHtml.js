'use strict';
// 陪伴角色的人物設定與 Prompt ⇄ HTML 表格。
// 匯出：一列一個欄位（分類｜欄位｜內容｜說明），用瀏覽器、Word、Excel 或文字編輯器都能改。
// 載入：先認 <tr data-key>；手改過或別的軟體另存、沒有 data-key 的表格，就用欄位名稱對。
// 只回傳「表格裡有的欄位」，沒列到的欄位維持原樣。

const FORMAT = 'codex-multi-companion/1';
const TRAIT_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

// [key, 分類, 欄位名稱, 說明, 別名...]
const FIELDS = [
  ['name', '人物', '名字', '最多 20 字'],
  ['age', '人物', '年齡', ''],
  ['identity', '人物', '身分、生活與人際關係', '每行一件事', '身分', '背景', '背景與人際關係'],
  ['facets', '人物', '個性面向', '', '個性'],
  ['cognitiveStyle', '人物', '想事情的方式', '', '思考方式'],
  ['speech', '人物', '講話方式', '', '說話方式', '口吻'],
  ['values', '人物', '在乎的事', '每行一項', '價值觀'],
  ['likes', '人物', '喜歡', '每行一項'],
  ['dislikes', '人物', '討厭', '每行一項'],
  ['habits', '人物', '習慣', '每行一項'],
  ['boundaries', '人物', '界線', '每行一項'],
  ['lifeEpisodes', '人物', '刻在心裡的事', '每行一件，開頭 [1–10] 是重要程度', '難忘的往事', '人生經歷'],
  ['trait:openness', '性格數值', '開放性', '0–1（也可以寫 0–100）', '開放性（好奇、愛嘗鮮）', 'openness'],
  ['trait:conscientiousness', '性格數值', '盡責性', '0–1', '盡責性（有條理）', 'conscientiousness'],
  ['trait:extraversion', '性格數值', '外向性', '0–1', 'extraversion'],
  ['trait:agreeableness', '性格數值', '親和性', '0–1', '親和性（好相處、順著人）', 'agreeableness'],
  ['trait:neuroticism', '性格數值', '情緒起伏', '0–1', '情緒起伏（容易急躁上火）', 'neuroticism'],
  ['schedule', '作息', '作息', '留空＝內建作息。每行：「哪幾天 開始-結束 在做什麼 | 狀態」', '生活作息'],
  ['prompt:intro', 'Prompt', '開場定位', '{name} 會換成名字'],
  ['prompt:principles', 'Prompt', '做人原則', '每行一條'],
  ['prompt:mind', 'Prompt', '心聲規則（角色內推理）', '', '心聲規則'],
  ['prompt:reply', 'Prompt', '回覆規則', ''],
  ['prompt:extra', 'Prompt', '額外指示', '預設空白'],
];

const norm = (s) => String(s || '').replace(/[\s:：*＊]/g, '').replace(/（.*?）|\(.*?\)/g, '').toLowerCase();

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function valueOf(patch, key) {
  if (key.startsWith('trait:')) { const v = (patch.traits || {})[key.slice(6)]; return v == null ? '' : String(v); }
  if (key.startsWith('prompt:')) return (patch.prompt || {})[key.slice(7)] || '';
  if (key.startsWith('scenario:')) return (patch.scenarios || {})[key.slice(9)] || '';
  return patch[key] == null ? '' : String(patch[key]);
}

/**
 * 把編輯器的內容（同 companion:saveProfile 的 patch 格式）轉成一份獨立的 HTML 檔。
 * scenarioLabels：{ id: 中文名稱 }，情境反應一個情境一列。
 */
function toHtml(patch = {}, { scenarioLabels = {}, exportedAt = new Date(), stored = false } = {}) {
  const rows = FIELDS.map(([key, group, label, hint]) => [key, group, label, hint]);
  const scIds = Object.keys(patch.scenarios || {});
  for (const id of scIds) rows.push([`scenario:${id}`, '情境反應', scenarioLabels[id] || id, '偵測到這個情況時額外提醒她的話']);
  const name = String(patch.name || '陪伴角色');
  const body = rows.map(([key, group, label, hint]) => `      <tr data-key="${esc(key)}">
        <td class="group">${esc(group)}</td>
        <th scope="row">${esc(label)}</th>
        <td class="value">${esc(valueOf(patch, key))}</td>
        <td class="hint">${esc(hint)}</td>
      </tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="generator" content="Codex Multi">
<title>${esc(name)}：角色與 Prompt</title>
<style>
  body { font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif; margin: 24px; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; text-align: left; }
  thead th { background: #eee; }
  td.value { white-space: pre-wrap; min-width: 40em; }
  td.group, td.hint { color: #666; font-size: 90%; }
  p.note { color: #666; font-size: 90%; }
</style>
</head>
<body>
<h1>${esc(name)}：角色與 Prompt</h1>
<p class="note">${stored
    ? '這是 Codex Multi 實際使用的角色設定檔。只要改「內容」那一欄；一格裡的換行會照原樣保留。存檔後，她的下一則回覆就會套用。刪掉的列會維持原本的值；在 App 的「編輯角色與 Prompt」按儲存時，也會寫回這個檔案。'
    : `只要改「內容」那一欄；一格裡的換行會照原樣保留。存檔後在 Codex Multi 的「編輯角色與 Prompt」按「從 HTML 載入…」。刪掉的列會維持 App 裡原本的值。匯出時間：${esc(exportedAt.toISOString())}`}</p>
<table id="companion-profile" data-format="${FORMAT}">
  <thead><tr><th>分類</th><th>欄位</th><th>內容</th><th>說明</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>
</body>
</html>
`;
}

// ------------------------------------------------------------------ 讀回來
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 儲存格的 HTML → 純文字，保留換行 */
function cellText(html) {
  let s = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  // 有 <br>／<p> 等標記時，原始碼裡的換行只是排版（Word 另存的 HTML 會在句中斷行），當成空白
  if (/<(br|p|div|li)\b/i.test(s)) s = s.replace(/\s*\r?\n\s*/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  s = decode(s).replace(/ /g, ' ').replace(/\r\n?/g, '\n');
  return s.split('\n').map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/, '')).join('\n').replace(/^\n+|\n+$/g, '');
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function labelIndex(scenarioLabels) {
  const idx = new Map();
  for (const [key, , label, , ...aliases] of FIELDS) for (const a of [key, label, ...aliases]) idx.set(norm(a), key);
  for (const [id, label] of Object.entries(scenarioLabels || {})) { idx.set(norm(label), `scenario:${id}`); idx.set(norm(id), `scenario:${id}`); }
  return idx;
}

function labelOf(key, scenarioLabels = {}) {
  const field = FIELDS.find((f) => f[0] === key);
  return field ? field[2] : (scenarioLabels[key.slice(9)] || key.slice(9));
}

/** 把一個欄位的文字寫進 patch（HTML 與 TXT 共用）。空白的性格數值＝不改，回傳 false。 */
function assignField(patch, key, value, label, warnings) {
  if (key.startsWith('trait:')) {
    if (!value.trim()) return false; // 空白＝不改
    const raw = value.replace(/[%％\s]/g, '');
    let n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(n)) { warnings.push(`「${label}」不是數字：${value.slice(0, 20)}`); return false; }
    if (n > 1) n /= 100;
    if (n < 0 || n > 1) { warnings.push(`「${label}」要在 0–1 之間`); return false; }
    (patch.traits = patch.traits || {})[key.slice(6)] = Math.round(n * 100) / 100;
  } else if (key.startsWith('prompt:')) (patch.prompt = patch.prompt || {})[key.slice(7)] = value;
  else if (key.startsWith('scenario:')) (patch.scenarios = patch.scenarios || {})[key.slice(9)] = value;
  else patch[key] = value;
  return true;
}

/**
 * 解析 HTML 表格，回傳 { patch, found: [欄位名稱], unknown: [對不上的列], warnings: [] }。
 * patch 的格式與 companion:saveProfile 相同，只含表格裡有的欄位。
 */
function fromHtml(html, { scenarioLabels = {} } = {}) {
  const src = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const idx = labelIndex(scenarioLabels);
  const known = new Set(FIELDS.map((f) => f[0]));
  const patch = {}; const found = []; const unknown = []; const warnings = [];
  const rowRe = /<tr\b([^>]*)>([\s\S]*?)(?=<tr\b|<\/tbody>|<\/table>|$)/gi;
  let m;
  while ((m = rowRe.exec(src))) {
    const trAttrs = m[1];
    const cells = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)(?:<\/\1>|(?=<t[dh]\b)|$)/gi;
    let c;
    while ((c = cellRe.exec(m[2]))) cells.push({ tag: c[1].toLowerCase(), attrs: c[2], html: c[3], text: cellText(c[3]) });
    if (!cells.length) continue;
    let key = attr(`<tr ${trAttrs}>`, 'data-key');
    let labelAt = -1;
    if (!key) {
      for (let i = 0; i < cells.length && !key; i++) { const k = idx.get(norm(cells[i].text)); if (k) { key = k; labelAt = i; } }
      // 分類和欄位同名（例如「作息｜作息｜內容」）：欄位名稱取最後一個同名的格子
      while (key && labelAt + 1 < cells.length - 1 && idx.get(norm(cells[labelAt + 1].text)) === key) labelAt++;
    }
    const header = cells.every((x) => x.tag === 'th') && !key;
    if (!key) { if (!header && cells.some((x) => x.text)) unknown.push(cells.map((x) => x.text).filter(Boolean)[0].slice(0, 30)); continue; }
    if (!known.has(key) && !key.startsWith('scenario:')) { unknown.push(key); continue; }
    let cell = cells.find((x) => /\bvalue\b/i.test(attr(`<x ${x.attrs}>`, 'class')));
    if (!cell) {
      if (labelAt < 0) labelAt = cells.findIndex((x) => idx.get(norm(x.text)) === key);
      cell = labelAt >= 0 ? cells[labelAt + 1] : cells[cells.length - 1];
    }
    if (!cell) { warnings.push(`「${key}」這一列沒有內容欄`); continue; }
    const label = labelOf(key, scenarioLabels);
    if (assignField(patch, key, cell.text, label, warnings)) found.push(label);
  }
  if (patch.name !== undefined && !patch.name.trim()) { delete patch.name; warnings.push('名字是空白的，維持原本的名字'); }
  return { patch, found, unknown, warnings };
}

/** 讀 HTML 檔的位元組：認 BOM 與 <meta charset>，Word／Excel 另存的 Big5 也讀得懂 */
function decodeHtmlBytes(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) { const s = Buffer.from(b.slice(2)); s.swap16(); return s.toString('utf16le'); }
  const head = b.slice(0, 2048).toString('latin1');
  const cs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  if (cs && !/^utf-?8$/i.test(cs)) { try { return new TextDecoder(cs.toLowerCase()).decode(b); } catch { /* 不認得的編碼就當 UTF-8 */ } }
  return b.toString('utf8');
}

module.exports = { FORMAT, FIELDS, TRAIT_KEYS, norm, valueOf, labelIndex, labelOf, assignField, toHtml, fromHtml, cellText, decodeHtmlBytes };
