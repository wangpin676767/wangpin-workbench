'use strict';
// 本機 Anthropic Messages API → OpenAI 相容 /chat/completions 的轉譯代理。
//
// 為什麼需要：Zenith 的 worker／validator 只能透過 ACP 轉接器跑 Claude Code 或 Codex。
// 使用者對話選的是 Gemini、Grok 或 GPT API 時，原本只能退回 Claude Code 的訂閱，
// 等於「沒有沿用」。Claude Code 會尊重 ANTHROPIC_BASE_URL，所以在本機開一個只收
// 127.0.0.1、帶隨機權杖的端點，把它的 Messages 請求翻成 OpenAI 格式轉給使用者選的
// 供應商，worker 就真的在使用者選的模型上工作（工具呼叫、串流都照翻）。
//
// 模型一律用建立代理時指定的那一個：Claude Code 內部會另外用「小模型」做雜事，
// 那些請求也要落在同一個供應商，不能打到不存在的 claude-* ID。
const http = require('http');
const crypto = require('crypto');

const BODY_LIMIT = 64 * 1024 * 1024;
// 上游不接受某個參數時，把它拿掉重送。每個供應商對 max_tokens、reasoning_effort、
// stream_options 的支援都不太一樣，與其逐家寫死，不如依錯誤訊息退讓。
const DROPPABLE = ['max_completion_tokens', 'max_tokens', 'reasoning_effort', 'stream_options', 'temperature', 'top_p', 'stop', 'tool_choice', 'parallel_tool_calls'];
// Gemini 的 OpenAI 相容端點只吃 OpenAPI 子集的 JSON Schema，多餘的關鍵字會整個請求 400
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'anyOf', 'default', 'title']);

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');
const newToolId = () => `toolu_${crypto.randomBytes(12).toString('hex')}`;

function cleanSchema(schema, strict) {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, strict));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$id' || k === '$comment') continue;
    if (strict && !SCHEMA_KEYS.has(k)) {
      if (k === 'exclusiveMinimum' && typeof v === 'number') out.minimum = v;
      else if (k === 'exclusiveMaximum' && typeof v === 'number') out.maximum = v;
      else if (k === 'oneOf' && Array.isArray(v)) out.anyOf = v.map((s) => cleanSchema(s, strict));
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, cleanSchema(s, strict)]));
    } else if (k === 'type' && Array.isArray(v) && strict) {
      // ["string","null"] 這種寫法 Gemini 不收，改成單一型別加 nullable
      const types = v.filter((t) => t !== 'null');
      out.type = types[0] || 'string';
      if (types.length !== v.length) out.nullable = true;
    } else out[k] = (v && typeof v === 'object') ? cleanSchema(v, strict) : v;
  }
  if (strict && out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => b.type === 'text' ? b.text : b.type === 'image' ? '[圖片]' : '').filter(Boolean).join('\n');
};
const imagePart = (b) => {
  const s = b.source || {};
  if (s.type === 'base64') return { type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data}` } };
  if (s.type === 'url') return { type: 'image_url', image_url: { url: s.url } };
  return null;
};

/**
 * Anthropic 請求 → OpenAI 請求。memory 記住上游給過的 tool call 附加資料
 * （Gemini 的 thought_signature），下一輪 Claude Code 送回 tool_use 時原封不動補回去。
 */
function toOpenAI(req, { provider, model, memory = new Map() }) {
  const messages = [];
  const system = Array.isArray(req.system) ? req.system.map((b) => b.text || '').join('\n\n') : String(req.system || '');
  if (system.trim()) messages.push({ role: 'system', content: system });
  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => {
        const call = { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } };
        const extra = memory.get(b.id);
        if (extra) call.extra_content = extra;
        return call;
      });
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }
    // user：tool_result 要先以 tool 角色緊接在 assistant 的 tool_calls 後面，其餘內容再成為一則 user 訊息
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content : [];
        let text = typeof b.content === 'string' ? b.content : textOf(inner);
        if (b.is_error) text = `［工具執行失敗］${text}`;
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || '(no output)' });
        // tool 角色只能放文字；工具回傳的圖片改附在後面的 user 訊息裡
        for (const img of inner.filter((x) => x.type === 'image')) { const p = imagePart(img); if (p) parts.push(p); }
      } else if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
      else if (b.type === 'document') parts.push({ type: 'text', text: '[文件附件：此模型無法直接讀取 PDF]' });
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const strict = provider === 'gemini';
  const body = { model, messages, stream: !!req.stream };
  const tools = (req.tools || []).filter((t) => t && t.name && (t.input_schema || !t.type || t.type === 'custom'));
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema || { type: 'object', properties: {} }, strict) } }));
    const choice = req.tool_choice;
    if (choice?.type === 'any') body.tool_choice = 'required';
    else if (choice?.type === 'tool' && choice.name) body.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice?.type === 'none') body.tool_choice = 'none';
  }
  if (req.max_tokens) body[provider === 'gpt' ? 'max_completion_tokens' : 'max_tokens'] = req.max_tokens;
  if (typeof req.temperature === 'number' && provider !== 'gpt') body.temperature = req.temperature;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) body.stop = req.stop_sequences.slice(0, 4);
  if (req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive') {
    const budget = Number(req.thinking.budget_tokens) || 16000;
    body.reasoning_effort = budget <= 4096 ? 'low' : budget <= 16384 ? 'medium' : 'high';
  }
  if (body.stream) body.stream_options = { include_usage: true };
  return body;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const ERROR_TYPE = (status) => status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
  : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : 'api_error';

/** 非串流回應 → Anthropic message。 */
function fromOpenAI(json, { model, memory = new Map() }) {
  const choice = (json.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  for (const call of msg.tool_calls || []) {
    const id = call.id || newToolId();
    if (call.extra_content) memory.set(id, call.extra_content);
    let input = {};
    try { input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { input = { _raw: call.function?.arguments }; }
    content.push({ type: 'tool_use', id, name: call.function?.name || '', input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content,
    stop_reason: hasTools ? 'tool_use' : (STOP[choice.finish_reason] || 'end_turn'), stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 },
  };
}

/**
 * OpenAI 串流 → Anthropic SSE 事件。回傳 { feed(chunkJson), finish() }，
 * 每個呼叫都把要送出的事件交給 write(eventName, data)。
 */
function streamTranslator({ model, memory = new Map(), write }) {
  let index = -1;
  let open = null; // { kind:'text' } 或 { kind:'tool', key }
  const tools = new Map(); // key -> { id, blockIndex }
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finish = null;
  let started = false;
  const start = () => {
    if (started) return; started = true;
    write('message_start', { type: 'message_start', message: { id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const close = () => { if (open) { write('content_block_stop', { type: 'content_block_stop', index }); open = null; } };
  return {
    feed(chunk) {
      start();
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
      for (const choice of chunk.choices || []) {
        const d = choice.delta || {};
        if (d.content) {
          if (open?.kind !== 'text') { close(); index += 1; open = { kind: 'text' }; write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); }
          write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: d.content } });
        }
        for (const call of d.tool_calls || []) {
          // 有些供應商（Gemini）平行呼叫時不給 index，或每個呼叫一次整包給完；用 id 分辨
          let key = call.index != null ? `i${call.index}` : call.id ? `id${call.id}` : open?.kind === 'tool' ? open.key : `n${tools.size}`;
          const known = tools.get(key);
          if (known && call.id && known.upstreamId && call.id !== known.upstreamId) key = `id${call.id}`;
          let entry = tools.get(key);
          if (!entry) {
            close();
            index += 1;
            entry = { id: call.id || newToolId(), upstreamId: call.id || '', blockIndex: index };
            tools.set(key, entry);
            open = { kind: 'tool', key };
            write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: entry.id, name: call.function?.name || '', input: {} } });
          } else if (open?.key !== key) {
            // 交錯送來的參數片段：Anthropic 的區塊必須連續，只能接在自己後面
            continue;
          }
          if (call.extra_content) memory.set(entry.id, { ...(memory.get(entry.id) || {}), ...call.extra_content });
          const args = call.function?.arguments;
          if (args) write('content_block_delta', { type: 'content_block_delta', index: entry.blockIndex, delta: { type: 'input_json_delta', partial_json: args } });
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    },
    finish() {
      start();
      close();
      const stop = tools.size ? 'tool_use' : (STOP[finish] || 'end_turn');
      write('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens } });
      write('message_stop', { type: 'message_stop' });
    },
  };
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > BODY_LIMIT) throw new Error('請求太大'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 啟動代理。opts: { provider, model, baseUrl, apiKey, fetchImpl, label }
 * 回傳 { url, token, close(), env() }；env() 是要交給 Claude Code 的環境變數。
 */
async function start({ provider, model, baseUrl, apiKey, fetchImpl = fetch, label = '' }) {
  if (!model) throw new Error('轉譯代理需要指定模型');
  if (!apiKey) throw new Error(`沒有 ${label || provider} 的 API 金鑰，無法讓 Zenith 沿用這個模型`);
  const token = crypto.randomBytes(24).toString('hex');
  const memory = new Map();
  const upstream = `${trimBase(baseUrl)}/chat/completions`;
  const sockets = new Set();

  const callUpstream = async (body, signal) => {
    let tries = 0;
    for (;;) {
      const res = await fetchImpl(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal });
      if (res.ok || res.status !== 400 || tries >= 4) return res;
      const text = await res.text();
      const drop = DROPPABLE.find((k) => k in body && new RegExp(k.replace(/_/g, '[_ ]?'), 'i').test(text));
      if (!drop) return new Response(text, { status: res.status, headers: res.headers });
      delete body[drop];
      tries += 1;
    }
  };

  const server = http.createServer(async (req, res) => {
    const sendJson = (status, obj) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const fail = (status, message) => sendJson(status, { type: 'error', error: { type: ERROR_TYPE(status), message } });
    const auth = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== token || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return fail(401, 'invalid proxy token');
    const route = String(req.url || '').split('?')[0];
    try {
      if (req.method === 'GET' && route === '/v1/models') return sendJson(200, { data: [{ type: 'model', id: model, display_name: `${label || provider} / ${model}`, created_at: new Date(0).toISOString() }], has_more: false, first_id: model, last_id: model });
      if (req.method !== 'POST') return fail(404, 'not found');
      const input = JSON.parse(await readBody(req) || '{}');
      if (route === '/v1/messages/count_tokens') {
        // 上游沒有對應的計算介面；粗估字元數，只給 Claude Code 決定何時收納上下文用
        const chars = JSON.stringify(input.messages || []).length + JSON.stringify(input.system || '').length + JSON.stringify(input.tools || []).length;
        return sendJson(200, { input_tokens: Math.ceil(chars / 3) });
      }
      if (route !== '/v1/messages') return fail(404, 'not found');
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      const body = toOpenAI(input, { provider, model, memory });
      const up = await callUpstream(body, abort.signal);
      if (!up.ok) {
        const text = await up.text().catch(() => '');
        let message = text;
        try { const j = JSON.parse(text); const e = Array.isArray(j) ? j[0]?.error : j.error; message = e?.message || j.message || text; } catch { /* 原文 */ }
        return fail(up.status, `[${label || provider} ${up.status}] ${String(message).slice(0, 1500)}`);
      }
      if (!body.stream) return sendJson(200, fromOpenAI(await up.json(), { model, memory }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const tr = streamTranslator({ model, memory, write });
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk; try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) { write('error', { type: 'error', error: { type: 'api_error', message: String(chunk.error.message || JSON.stringify(chunk.error)).slice(0, 1500) } }); res.end(); return; }
          tr.feed(chunk);
        }
      }
      tr.finish();
      res.end();
    } catch (e) {
      if (e?.name === 'AbortError') { res.destroy(); return; }
      if (res.headersSent) { if (!res.writableEnded) { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })}\n\n`); res.end(); } return; }
      fail(502, `轉譯代理連不到 ${label || provider}：${e.message}`);
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token,
    env: () => ({
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }),
    close() { for (const s of sockets) s.destroy(); server.close(); },
  };
}

module.exports = { start, toOpenAI, fromOpenAI, streamTranslator, cleanSchema };
