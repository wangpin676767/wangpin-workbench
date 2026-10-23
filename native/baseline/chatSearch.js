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
function searchMessages(messages, terms, { perChat = 5 } = {}) {
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

module.exports = { parseQuery, snippet, searchMessages, titleMatches, fold };
