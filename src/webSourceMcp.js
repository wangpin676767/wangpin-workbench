'use strict';
// One invocation belongs to exactly one website conversation. The caller owns
// its fixed browser tab, MCP session, permission gates and cancellation signal.
const bridge = require('./webToolBridge');
function combine(parts) { return parts.filter(Boolean).join('\n\n'); }
function quotedProtocol(text) {
  const marker = /\[\[(?:HOST_TOOL|CODEX_MULTI_TOOL)\]\]|<(?:host_tool|codex_multi_tool)>/i.exec(text);
  if (!marker) return false;
  // A protocol example inside a fenced code block is answer data, not a call.
  const before = text.slice(0, marker.index);
  if ((before.match(/^\s*(?:```|~~~)/gm) || []).length % 2 === 1) return true;
  return (before.slice(before.lastIndexOf('\n') + 1).match(/(?<!\\)`/g) || []).length % 2 === 1;
}
async function run(options = {}) {
  if (typeof options.ask !== 'function') throw new Error('網頁工具缺少 ask 回呼');
  const parts = [];
  let current = '';
  let lastVisible = '';
  let done = false;
  const aborted = () => !!options.signal?.aborted;
  if (aborted()) return { text: '', cancelled: true };
  const visible = () => combine([...parts, bridge.visibleText(current)]);
  const publish = () => {
    if (done || aborted()) return;
    const text = visible();
    if (text === lastVisible) return;
    if (text.startsWith(lastVisible)) options.onDelta?.(text.slice(lastVisible.length));
    else options.onReplace?.(text);
    lastVisible = text;
  };
  try {
    const result = await bridge.run({
      text: options.text,
      tools: options.tools || [],
      signal: options.signal,
      maxTurns: Math.max(1, Math.min(24, Number(options.maxTurns) || 24)),
      execute: async (name, args) => {
        if (aborted()) throw new Error('已停止');
        if (typeof options.execute !== 'function') throw new Error('網頁工具缺少 execute 回呼');
        return options.execute(name, args, { signal: options.signal });
      },
      ask: async (prompt, meta) => {
        if (aborted()) return { text: '', cancelled: true };
        current = '';
        let settled = false;
        try {
          const response = await options.ask(prompt, {
            ...meta,
            signal: options.signal,
            onDelta: delta => { if (!settled && !done && !aborted()) { current += String(delta || ''); publish(); } },
            onReplace: text => { if (!settled && !done && !aborted()) { current = String(text || ''); publish(); } },
          });
          settled = true;
          if (typeof response?.text === 'string') current = response.text;
          publish();
          const safe = bridge.visibleText(current);
          parts.push(safe);
          current = '';
          // Never dispatch a tool-looking code example. Tool results themselves
          // enter only the next ask's prompt and are never parsed as calls.
          return { ...(response || {}), text: quotedProtocol(String(response?.text || '')) ? safe : String(response?.text || ''), ...(aborted() ? { cancelled: true } : {}) };
        } catch (error) {
          settled = true;
          if (typeof error?.partial === 'string') current = error.partial;
          throw error;
        }
      },
    });
    const text = visible();
    done = true;
    return { ...(result || {}), text, ...(aborted() ? { cancelled: true } : {}) };
  } catch (error) {
    const partial = visible();
    done = true;
    const out = error instanceof Error ? error : new Error(String(error));
    out.partial = partial;
    if (aborted()) { out.cancelled = true; return { text: partial, cancelled: true }; }
    throw out;
  }
}
function stableGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com') return false;
    const match = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/.exec(url.pathname);
    if (match) return !/^WEB[:_-]/i.test(decodeURIComponent(match[1]));
    return url.pathname === '/' && url.searchParams.get('temporary-chat') === 'true';
  } catch { return false; }
}
module.exports = { run, stableGptUrl };
