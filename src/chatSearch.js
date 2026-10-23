'use strict';
// 對話內容搜尋：在所有對話（App 對話＋Codex 執行緒）的訊息全文裡找關鍵字。
// 多個關鍵字用空白隔開＝同一則訊息裡都要出現；用引號包起來＝整句比對。
// 不分大小寫、也不分全形半形（「ＡＰＩ」找得到「API」）。

const MAX_SNIPPET = 160;

function fold(text) {
  return String(text || '').normalize('NFKC').toLowerCase();
}

/** 把查詢字串拆成關鍵字：「"整句 比對" 其他」→ ['整句 比對', '其他'] */
function parseQuery(query) {
  const terms = [];
  const re = /"([^"]+)"|“([^”]+)”|「([^」]+)」|(\S+)/g;
  let m;
  while ((m = re.exec(String(query || '')))) {
    const t = fold((m[1] || m[2] || m[3] || m[4] || '').trim());
    if (t) terms.push(t);
  }
  return [...new Set(terms)];
}

/** 取第一個命中的關鍵字附近的一段文字，並回報命中位置（給畫面標亮用）。 */
function snippet(text, terms) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = fold(raw);
  // NFKC 可能改變長度（例如全形轉半形不會，但合字會）；長度不同時退回不做對齊的比對
  const aligned = lower.length === raw.length;
  let at = -1, hit = '';
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) { at = i; hit = t; } }
  if (at < 0) return { text: raw.slice(0, MAX_SNIPPET), marks: [] };
  const start = Math.max(0, at - 50);
  const end = Math.min(raw.length, start + MAX_SNIPPET);
  const piece = raw.slice(start, end);
  const marks = [];
  if (aligned) {
    const pl = lower.slice(start, end);
    for (const t of terms) { let i = pl.indexOf(t); while (i >= 0 && marks.length < 20) { marks.push([i + (start ? 1 : 0), t.length]); i = pl.indexOf(t, i + t.length); } }
  }
  return { text: (start ? '…' : '') + piece + (end < raw.length ? '…' : ''), marks: marks.sort((a, b) => a[0] - b[0]), hit };
}

/**
 * 在一段對話的訊息裡找。messages 的順序要跟畫面一樣（chat:open 的 mergedMessages），
 * 回傳的 index 才能直接拿來捲到那則訊息。
 */
function searchMessagesLegacy(messages, terms, { perChat = 5 } = {}) {
  const hits = [];
  let total = 0;
  (messages || []).forEach((m, index) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
    const body = fold(m.text);
    if (!body || !terms.every((t) => body.includes(t))) return;
    total += 1;
    if (hits.length < perChat) hits.push({ index, role: m.role, provider: m.provider || (m.source === 'codex' ? 'codex' : ''), ts: m.ts || '', ...snippet(m.text, terms) });
  });
  return { hits, total };
}

/** 標題或資料夾名稱也算命中（但排在內文命中之後）。 */
function titleMatches(item, terms) {
  const hay = fold(`${item.title || ''} ${item.cwd || ''}`);
  return terms.length > 0 && terms.every((t) => hay.includes(t));
}

const { getNative } = require('./nativeAccelerator');
const indexes = new Map();
const CACHE_BUDGET = 32 * 1024 * 1024;
let cacheBytes = 0;

function indexedMessages(messages) {
  let entry = indexes.get(messages);
  let unchanged = Boolean(entry && entry.texts.length === messages.length);
  if (unchanged) for (let i = 0; i < messages.length; i++) {
    if (entry.texts[i] !== messages[i]?.text || entry.roles[i] !== messages[i]?.role) { unchanged = false; break; }
  }
  if (entry && !unchanged) {
    indexes.delete(messages); cacheBytes -= entry.bytes; entry = null;
  }
  if (entry) { indexes.delete(messages); indexes.set(messages, entry); return entry; }
  const texts = [], roles = [], bodies = [];
  let chars = 0;
  let sourceChars = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]; texts[i] = m?.text; roles[i] = m?.role;
    const body = m && (m.role === 'user' || m.role === 'assistant') ? fold(m.text) : '';
    bodies.push(body); chars += body.length;
    sourceChars += typeof m?.text === 'string' ? m.text.length : 0;
  }
  const bytes = sourceChars * 2 + chars * 4 + messages.length * 192;
  entry = { texts, roles, bodies, bytes, native: null };
  const native = chars >= 65536 && bytes <= CACHE_BUDGET && getNative();
  if (native) { try { entry.native = new native.SearchIndex(bodies.map(body => Buffer.from(body, 'utf16le'))); } catch { /* JS fallback */ } }
  if (bytes <= CACHE_BUDGET) {
    while (indexes.size && (cacheBytes + bytes > CACHE_BUDGET || indexes.size >= 128)) {
      const key = indexes.keys().next().value;
      cacheBytes -= indexes.get(key).bytes; indexes.delete(key);
    }
    indexes.set(messages, entry); cacheBytes += bytes;
  }
  return entry;
}

function searchMessages(messages, terms, { perChat = 5 } = {}) {
  if (!Array.isArray(messages) || !Array.isArray(terms) || !terms.every(t => typeof t === 'string')
      || typeof perChat !== 'number' || !Number.isFinite(perChat)
      || messages.some(m => m && m.text && typeof m.text !== 'string'))
    return searchMessagesLegacy(messages, terms, { perChat });
  // Oversized histories keep the original streaming-per-message scan rather
  // than allocate an uncached second full copy on every query.
  let estimate = messages.length * 192;
  for (const m of messages) {
    estimate += typeof m?.text === 'string' ? m.text.length * 8 : 0;
    if (estimate > CACHE_BUDGET) return searchMessagesLegacy(messages, terms, { perChat });
  }
  const entry = indexedMessages(messages);
  let found;
  if (entry.native && getNative()) {
    try { found = entry.native.search(terms.map(t => Buffer.from(t, 'utf16le')), Math.min(messages.length, Math.max(0, Math.ceil(perChat)))); }
    catch { entry.native = null; }
  }
  if (!found) {
    const indices = [];
    let total = 0;
    entry.bodies.forEach((body, index) => {
      if (!body || !terms.every(t => body.includes(t))) return;
      total++;
      if (indices.length < perChat) indices.push(index);
    });
    found = { indices, total };
  }
  return { total: found.total, hits: found.indices.map(index => {
    const m = messages[index];
    return { index, role: m.role, provider: m.provider || (m.source === 'codex' ? 'codex' : ''),
      ts: m.ts || '', ...snippet(m.text, terms) };
  }) };
}
function clearIndexCache() { indexes.clear(); cacheBytes = 0; }
function indexStats() { return { entries: indexes.size, bytes: cacheBytes,
  nativeEntries: [...indexes.values()].filter(e => e.native).length, budget: CACHE_BUDGET }; }

module.exports = { parseQuery, snippet, searchMessages, titleMatches, fold, clearIndexCache, indexStats };
