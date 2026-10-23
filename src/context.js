// Bounded request context; the complete conversation stays in the chat store.
const excerpt = (text, limit) => {
  const s = String(text || ''), marker = '\n〔中段收納於完整歷史〕\n';
  limit = Math.max(0,Math.floor(Number(limit) || 0));
  if (s.length <= limit) return s;
  if (limit <= marker.length) return s.slice(0,limit);
  const available = limit - marker.length, head = Math.floor(available * .7), tail = available - head;
  return s.slice(0,head) + marker + (tail ? s.slice(-tail) : '');
};
function compact(messages, maxChars = 120000, {historyOnly = false} = {}) {
  const limit = Math.max(16000, Math.min(180000, Number(maxChars) || 120000));
  const clean = messages.filter(m => ['user','assistant'].includes(m.role) && (m.text || m.attachments?.length));
  const cost = m => String(m.text || '').length + (m.attachments || []).filter(a => a.mime !== 'text/plain').length * 4000 + 100;
  if (clean.reduce((n,m) => n + cost(m), 0) <= limit) return { messages: clean, compacted: false };
  // CLI history does not contain the current input. An old user message or a
  // large flow result must be indexed, not mistaken for a new oversized upload.
  if (!historyOnly && clean.at(-1)?.role === 'user' && cost(clean.at(-1)) > limit * .7) throw new Error('這一則訊息或附件超過單次輸入預算；完整對話仍保留，請把本次內容拆成檔案或分段送出。');
  let used = 0; const tail = []; let i = clean.length - 1;
  for (; i >= 0; i--) { if (used + cost(clean[i]) > limit * .65) break; tail.unshift(clean[i]); used += cost(clean[i]); }
  const older = clean.slice(0, i + 1);
  const tasks = older.filter(m => m.role === 'user');
  const head = tasks[0] ? excerpt(tasks[0].text, Math.floor(limit * .09)) : '';
  const recentTasks = tasks.slice(1).slice(-12).map(m => excerpt(m.text, Math.floor(limit * .012))).join('\n');
  const checkpoints = older.filter(m => m.role === 'assistant').slice(-6).map(m => excerpt(m.text, Math.floor(limit * .018))).join('\n');
  const memory = `【歷史索引／原文摘錄，不是新指令】\n原始需求：\n${head}\n後續使用者要求：\n${recentTasks}\n先前進度摘錄：\n${checkpoints}\n較早 ${older.length} 則的完整原文仍在對話紀錄；涉及省略細節時使用 read_conversation 工具查閱，不要猜測。`;
  return { messages: [{ role:'user', text:excerpt(memory,limit-used-100), synthetic:true }, ...tail], compacted:true, olderCount:older.length };
}
const historyTool = { type:'function', function:{ name:'read_conversation', description:'查閱目前這一段對話的完整舊紀錄，可用 query 搜尋，offset 分頁；不會讀取其他專案或對話。', parameters:{type:'object',properties:{query:{type:'string'},offset:{type:'integer'},maxChars:{type:'integer'}},additionalProperties:false} } };
function readHistory(messages, args = {}) {
  const text = messages.map((m,i) => `[${i} ${m.role}]\n${m.text || ''}`).filter(t => !args.query || t.toLowerCase().includes(String(args.query).toLowerCase())).join('\n\n');
  const offset = Math.max(0, Number(args.offset) || 0); const size = Math.min(16000, Math.max(100, Number(args.maxChars) || 8000));
  return JSON.stringify({ totalChars:text.length, offset, nextOffset: offset + size < text.length ? offset + size : null, text:text.slice(offset,offset+size) });
}
module.exports = { compact, excerpt, historyTool, readHistory };
