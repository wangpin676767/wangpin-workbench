'use strict';
function retainText(previous, next) {
  previous = typeof previous === 'string' ? previous : '';
  next = typeof next === 'string' ? next : '';
  return !next || (previous.length > next.length && previous.startsWith(next)) ? previous : next;
}
function create() {
  const items = new Map(); const startedAt = new Date().toISOString();
  const capture = item => {
    if (!item?.id) return;
    const old = items.get(item.id);
    const value = {...old,...item};
    if (['agent_message','reasoning'].includes(value.type)) value.text = retainText(old?.text,item.text);
    items.set(item.id,value);
  };
  function snapshot() {
    const all = [...items.values()];
    const text = all.filter(i => i.type === 'agent_message' && !['commentary','analysis'].includes(i.phase)).map(i => i.text).filter(Boolean).join('\n\n');
    const reasoning = all.filter(i => i.type === 'reasoning' || (i.type === 'agent_message' && ['commentary','analysis'].includes(i.phase))).map(i => i.text).filter(Boolean).join('\n\n');
    const tools = all.filter(i => !['agent_message','reasoning','error'].includes(i.type)).map(i => ({ name: i.label || i.name || i.type, status:i.status, commandLifecycle:i.commandLifecycle, args: String(i.args || i.command || i.query || JSON.stringify(i.changes || i.tool || '')).slice(0,4000) }));
    return { text, reasoning, tools, codexSnapshot: { startedAt } };
  }
  return { capture, snapshot };
}
function reconcile(snapshot, native) {
  if (!snapshot.codexSnapshot) return snapshot;
  const since = Date.parse(snapshot.codexSnapshot.startedAt);
  const until = Date.parse(snapshot.ts);
  const relevant = native.filter(m => m.role === 'assistant' && Date.parse(m.ts) >= since && Date.parse(m.ts) <= until);
  const has = text => relevant.some(m => String(m.text || '').trim() === text.trim());
  const remaining = value => has(String(value || '')) ? '' : String(value || '').split('\n\n').filter(t => t && !has(t)).join('\n\n');
  const text = remaining(snapshot.text);
  const reasoning = remaining(snapshot.reasoning);
  // Native transcript already includes its tool records. The snapshot fills missing streamed prose.
  const nativeTools = relevant.flatMap(m=>m.tools || []);
  const tools = (snapshot.tools || []).filter(tool=>!nativeTools.some(native=>native.name === tool.name && native.args === tool.args));
  if (!text && !reasoning && !tools.length && relevant.length) return null;
  return { ...snapshot, text, reasoning, tools };
}
module.exports = { create, reconcile, retainText };
