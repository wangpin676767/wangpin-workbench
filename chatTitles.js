function keys(chat) {
  return [`app:${chat.id}`, ...[chat.codexThreadId, chat.codexActiveThreadId].filter(Boolean).map(id=>`codex:${id.toLowerCase()}`)];
}
function apply(chat, overrides = {}) {
  if (!chat) return chat;
  const record = keys(chat).map(key=>overrides[key]).filter(value=>value && typeof value.title==='string').sort((a,b)=>(b.at||0)-(a.at||0))[0];
  if (record) chat.title = record.title;
  return chat;
}
module.exports = {keys,apply};
