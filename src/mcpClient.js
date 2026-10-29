'use strict';
// 讓這個 App 自己當 MCP 用戶端，去連外部的 MCP 伺服器（例如 Scrapling）。
// 每次執行都開自己的連線，結束就關掉，所以不同對話、不同 agent 不會互相干擾。
const { spawnCli } = require('./codexRunner');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 120000;

function jsonRpc(id, method, params) {
  return JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
}

// ---- stdio ----
function stdioTransport({ command, args = [], env = {}, cwd }) {
  // spawnCli 會處理 Windows 的 .cmd／.bat 包裝（例如 npx）與含空白的路徑
  const child = spawnCli(command, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let closed = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    // MCP stdio 規定只用 \n 分隔，JSON 內容本身不會有裸換行
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP 伺服器回報錯誤'));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const fail = (err) => {
    closed = closed || err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  child.on('error', (e) => fail(new Error(`無法啟動 ${command}：${e.message}`)));
  child.on('exit', (code) => fail(new Error(`MCP 伺服器已結束（代碼 ${code}）${stderr ? `\n${stderr.trim().slice(-800)}` : ''}`)));

  let seq = 0;
  return {
    kind: 'stdio',
    get lastError() { return stderr; },
    notify(method, params) {
      if (closed) return;
      try { child.stdin.write(jsonRpc(undefined, method, params) + '\n'); } catch { /* 伺服器已關閉 */ }
    },
    request(method, params, { timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
      if (closed) return Promise.reject(closed);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應`)); }, timeoutMs);
        const done = (fn) => (v) => { clearTimeout(timer); onAbort && signal?.removeEventListener('abort', onAbort); fn(v); };
        const onAbort = signal ? () => { pending.delete(id); clearTimeout(timer); reject(new Error('已取消')); } : null;
        if (onAbort) signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        try { child.stdin.write(jsonRpc(id, method, params) + '\n'); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(new Error(`無法送出請求：${e.message}`)); }
      });
    },
    close() {
      fail(new Error('連線已關閉'));
      try { child.stdin.end(); } catch { /* 已關閉 */ }
      try { child.kill(); } catch { /* 已結束 */ }
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* 已結束 */ } }, 2000).unref?.();
    },
  };
}

// ---- streamable http ----
function httpTransport({ url, headers = {} }) {
  const target = new URL(url);
  const mod = target.protocol === 'https:' ? https : http;
  let seq = 0;
  let sessionId = null;
  const send = (body, { timeoutMs = DEFAULT_TIMEOUT, signal } = {}) => new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const req = mod.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': payload.length,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        if (res.statusCode === 202 || !text.trim()) { resolve(null); return; }
        // SSE 格式時取出 data: 行
        const raw = /^event:|^data:/m.test(text)
          ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
          : text;
        let msg;
        try { msg = JSON.parse(raw); } catch { reject(new Error(`回應不是 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`)); return; }
        if (msg.error) reject(new Error(msg.error.message || 'MCP 伺服器回報錯誤'));
        else resolve(msg.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應`)));
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    req.end(payload);
  });
  return {
    kind: 'http',
    notify(method, params) { send(jsonRpc(undefined, method, params)).catch(() => {}); },
    request(method, params, opts) { return send(jsonRpc(++seq, method, params), opts); },
    close() { /* HTTP 沒有常駐連線 */ },
  };
}

/**
 * 連上一台 MCP 伺服器，回傳工具清單與呼叫函式。
 * spec: { transport:'stdio'|'http', command, args, env, cwd, url, headers, startupMs, callMs }
 */
async function connect(spec) {
  const transport = spec.transport === 'http' ? httpTransport(spec) : stdioTransport(spec);
  try {
    await transport.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'CodexMulti', version: spec.version || '0' },
    }, { timeoutMs: spec.startupMs || 60000 });
    transport.notify('notifications/initialized', {});
    const listed = await transport.request('tools/list', {}, { timeoutMs: spec.startupMs || 60000 });
    const tools = (listed?.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].filter(key => typeof t.annotations?.[key] === 'boolean').map(key => [key, t.annotations[key]])),
    }));
    return {
      tools,
      async call(name, args, opts = {}) {
        const r = await transport.request('tools/call', { name, arguments: args || {} }, { timeoutMs: opts.timeoutMs || spec.callMs || 300000, signal: opts.signal });
        const text = (r?.content || [])
          .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '［圖片］' : JSON.stringify(c)))
          .join('\n');
        if (r?.isError) throw new Error(text || '工具執行失敗');
        return text || JSON.stringify(r?.structuredContent ?? r ?? {});
      },
      close: () => transport.close(),
    };
  } catch (e) {
    transport.close();
    throw e;
  }
}

module.exports = { connect };
