function extract(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : c.text || '').filter(Boolean).join('\n');
  if (content && Array.isArray(content.parts)) return extract(content.parts);
  return '';
}
function parseImport(raw, filename = '匯入對話') {
  raw = raw.replace(/^\uFEFF/, '');
  let root;
  try { root = JSON.parse(raw); if (/\.jsonl$/i.test(filename) && !Array.isArray(root)) root = [root]; }
  catch {
    if (/\.jsonl$/i.test(filename)) root = raw.split(/\r?\n/).filter(s => s.trim()).map((s, i) => { try { return JSON.parse(s); } catch { throw new Error(`JSONL 第 ${i + 1} 行格式錯誤`); } });
    else if (/\.(txt|md)$/i.test(filename)) return [{ title: filename, messages: [{ role: 'user', text: raw }], cwd: '' }];
    else throw new Error('無法解析 JSON，請選擇 JSON、JSONL、TXT 或 Markdown 對話匯出檔。');
  }
  const conversations = Array.isArray(root) && root.some(x => x.mapping || x.chat_messages || Array.isArray(x.messages)) ? root : [root];
  return conversations.map(c => {
    let rows = Array.isArray(c) ? c : c.messages || c.chat_messages;
    if (c.mapping) {
      rows = []; let id = c.current_node; const visited = new Set();
      while (id && c.mapping[id] && !visited.has(id)) { visited.add(id); const n = c.mapping[id]; if (n.message) rows.unshift(n.message); id = n.parent; }
      if (!rows.length) rows = Object.values(c.mapping).map(n => n.message).filter(Boolean);
    }
    if (!rows) throw new Error('找不到可辨識的對話訊息');
    const messages = []; const seen = new Set(); let cwd = '';
    for (const row of rows) {
      if (row.isSidechain || row.isMeta) continue;
      if (row.cwd) cwd = row.cwd;
      if (row.type === 'session_meta') { cwd = row.payload?.cwd || cwd; continue; }
      let m = row.message || (row.type === 'response_item' ? row.payload : row);
      // Codex event_msg mirrors response_item. Prefer the canonical response items.
      if (row.type === 'event_msg') continue;
      let role = m.role || m.sender || m.author?.role;
      if (role === 'human') role = 'user';
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extract(m.content ?? m.text);
      const attachments = [...(Array.isArray(m.attachments) ? m.attachments.map(a => ({ name: a?.name || '附件', mime: a?.mime || 'application/octet-stream' })) : []),
        ...(Array.isArray(m.content) ? m.content.filter(c => ['image', 'document', 'input_image', 'input_audio', 'video'].includes(c?.type)).map(c => ({ name: c.type, mime: c.type === 'image' || c.type === 'input_image' ? 'image/unknown' : 'application/octet-stream' })) : [])];
      const meta = {};
      for (const field of ['partial', 'error', 'isApiErrorMessage', 'status', 'phase', 'channel']) if (m[field] != null || row[field] != null) meta[field] = m[field] ?? row[field];
      if (!text.trim() && !attachments.length && !Object.keys(meta).length) continue;
      const id = row.uuid || m.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      messages.push({ role, text, model: m.model, ts: row.timestamp || m.ts || m.created_at, ...meta, ...(attachments.length ? { attachments } : {}) });
    }
    if (!messages.length) throw new Error('檔案中沒有使用者或助手訊息');
    return { title: c.title || c.name || filename, cwd, messages };
  });
}
module.exports = { parseImport };
