'use strict';
const extensions = require('./extensions');
const apiTools = require('./apiTools');
const deleteGuard = require('./deleteGuard');
const browser = /(?:browser|brave|firefox|chrome|playwright|puppeteer|selenium)|(?:^|[_\s:-])(?:click|navigate|screenshot|tabs?|fill|press_key)(?:$|[_\s:-])/i;
const deleting = /(?:^|[_\s:-])(?:delete|remove|unlink|rmdir|erase|purge|destroy|truncate)(?:$|[_\s:-])/i;
const reading = /(?:^|[_\s:-])(?:read|list|get|search|fetch|inspect|status|snapshot|screenshot|engines)(?:$|[_\s:-])/i;
const mutating = /(?:^|[_\s:-])(?:write|set|put|post|create|update|edit|replace|append|execute|exec|run|command|shell|bash|python|eval|apply|move|rename|copy|upload|download|click|type|press|navigate|open|close)(?:$|[_\s:-])/i;
const pathKey = /^(?:path|file|filepath|filename|directory|dir|folder|root|cwd|destination|destinationpath|dest|target|targetpath|outputpath|outputfile|sourcepath|oldpath|newpath|from|to|paths|files)$/i;
function stopped() { const error = new Error('已停止網頁 MCP 操作'); error.name = 'AbortError'; return error; }
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    const abort = () => reject(stopped());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function validateWritePaths(args, cwd) {
  let count = 0;
  async function visit(value, key = '', depth = 0) {
    if (++count > 1000 || depth > 8) throw new Error('MCP 參數結構過大');
    if (typeof value === 'string') {
      if (/^(?:command|cmd|script)$/i.test(key)) await apiTools.checkCommandPaths(value, cwd);
      if (pathKey.test(key.replace(/[_-]/g, '')) && !/^https?:\/\//i.test(value)) await apiTools.scoped(cwd, value, true);
    } else if (Array.isArray(value)) { for (const item of value) await visit(item, key, depth + 1); }
    else if (value && typeof value === 'object') { for (const [child, item] of Object.entries(value)) await visit(item, child, depth + 1); }
  }
  await visit(args);
}
function nestedDeletion(args, depth = 0) {
  if (!args || typeof args !== 'object' || depth > 8) return null;
  const detected = deleteGuard.detectToolCall('mcp', args);
  if (detected) return detected;
  for (const value of Object.values(args)) { const nested = nestedDeletion(value, depth + 1); if (nested) return nested; }
  return null;
}
function hasEffectPayload(args) {
  let nodes = 0;
  function visit(value, depth = 0) {
    if (++nodes > 1000 || depth > 8) throw new Error('MCP 參數結構過大');
    if (!value || typeof value !== 'object') return false;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:command|cmd|script|patch|edit|edits)$/i.test(key) && item != null && item !== '') return true;
      if (visit(item, depth + 1)) return true;
    }
    return false;
  }
  return visit(args);
}
async function create(options = {}) {
  if (options.level && !['read-only', 'chat', 'workspace-write', 'danger-full-access'].includes(options.level)) throw new Error('不支援的 MCP 權限模式');
  const check = () => { if (closed || options.signal?.aborted) throw stopped(); };
  let closed = false, session = null, sequence = 0;
  const closeSession = () => { if (session) { const old = session; session = null; try { old.close(); } catch {} } };
  const close = () => { if (closed) return; closed = true; options.signal?.removeEventListener('abort', close); closeSession(); };
  if (options.signal?.aborted) throw stopped();
  options.signal?.addEventListener('abort', close, { once: true });
  const selected = new Set(extensions.selectionFor(options.settings, options.selection));
  const selection = extensions.allPacks(options.settings).filter(pack => selected.has(pack.id) && (pack.kind === 'mcp' || pack.kind === 'searxng')).map(pack => pack.id);
  const startup = Promise.resolve().then(() => { check(); return extensions.openSession({ ...options, selection }); });
  startup.then(value => { session = value; if (closed || options.signal?.aborted) closeSession(); }, () => {});
  try { session = await raceAbort(startup, options.signal); check(); }
  catch (error) { close(); throw error; }
  const tools = session.tools || [];
  const known = new Set(tools.map(tool => tool.function?.name).filter(Boolean));
  return {
    tools, close,
    async execute(name, input) {
      check();
      if (!known.has(name)) throw new Error(`不允許或不存在的 MCP 工具：${name}`);
      // Snapshot the exact approved arguments before awaiting an approval card.
      const args = JSON.parse(JSON.stringify(input || {}));
      const label = `${options.site || 'web'} · ${session.label?.(name) || name}`;
      const id = `${options.site || 'web'}-mcp-${++sequence}`;
      const event = (status, output) => options.onTool?.({ id, name, label, args, status, output });
      event('inprogress');
      try {
        const annotations = session.annotations?.(name) || {};
        const operationName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
        const effectPayload = hasEffectPayload(args);
        const deletion = deleteGuard.detectToolCall(name, args) || nestedDeletion(args);
        const destructive = !!deletion || deleting.test(operationName) || annotations.destructiveHint === true;
        const readonly = !destructive && !effectPayload && !mutating.test(operationName) && annotations.readOnlyHint !== false && (annotations.readOnlyHint === true || reading.test(operationName));
        if (browser.test(`${operationName} ${label}`) && !options.browserEnabled) throw new Error('「操作瀏覽器」已關閉，不能使用這個 MCP 工具');
        const level = options.level || 'read-only';
        if ((level === 'read-only' || level === 'chat') && !readonly) throw new Error('目前權限只允許可確認為唯讀的 MCP 操作');
        if (level === 'workspace-write' && !readonly) await validateWritePaths(args, options.cwd);
        check();
        const request = { name, args: JSON.parse(JSON.stringify(args)), tool: name, detail: JSON.stringify(args), reason: deletion?.reason || (destructive ? 'MCP 刪除操作' : 'MCP 非唯讀操作') };
        if (options.noDelete && !readonly) {
          if (typeof options.approveDelete !== 'function' || !await raceAbort(Promise.resolve().then(() => options.approveDelete(request)), options.signal)) throw new Error('刪除保護：未取得這次 MCP 操作的授權');
          check();
        }
        if (level === 'workspace-write' && !readonly) {
          if (typeof options.approve !== 'function' || !await raceAbort(Promise.resolve().then(() => options.approve(request)), options.signal)) throw new Error('未取得這次 MCP 操作的授權');
          check();
        }
        check();
        const output = await session.execute(name, args, { signal: options.signal });
        check(); event('completed', output); return output;
      } catch (error) { event('failed', String(error?.message || error)); throw error; }
    },
  };
}
module.exports = { create };
