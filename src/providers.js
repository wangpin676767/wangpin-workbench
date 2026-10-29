// GPT / DeepSeek / Claude 的串流呼叫
const PROVIDERS = {
  gpt: { label: 'GPT', defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-6-sol', models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] },
  deepseek: { label: 'DeepSeek', defaultBase: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  claude: { label: 'Claude', defaultBase: 'https://api.anthropic.com', defaultModel: 'claude-opus-5', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] },
  // Gemini 走 Google 官方的 OpenAI 相容端點，因此沿用同一套串流／工具呼叫／重試流程
  // Grok（xAI）也提供 OpenAI 相容的 /v1/chat/completions，同樣走共用流程
  // Meta（Model API，Muse Spark）同樣是 OpenAI 相容端點
  meta: { label: 'Meta', defaultBase: 'https://api.meta.ai/v1', defaultModel: 'muse-spark-1.3', models: ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'] },
  // Abliteration.ai 也是 OpenAI 相容端點（/v1/chat/completions）；沒有 reasoning_effort
  ablit: { label: 'Abliteration', defaultBase: 'https://api.abliteration.ai/v1', defaultModel: 'abliterated-model-large-v2', models: ['abliterated-model-large-v2', 'abliterated-model-large', 'abliterated-model'] },
  // LM Studio：使用者電腦上的本機伺服器（OpenAI 相容），不需要金鑰；模型清單直接問 LM Studio
  lmstudio: { label: 'LM Studio', defaultBase: 'http://localhost:1234/v1', defaultModel: '', models: [], local: true },
  grok: { label: 'Grok', defaultBase: 'https://api.x.ai/v1', defaultModel: 'grok-4.6', models: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-latest'] },
  gemini: { label: 'Gemini', defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'] },
};

function trimBase(u) { return String(u || '').trim().replace(/\/+$/, ''); }

// 伺服器沒斷線但一直不送資料時，不要無限等待：逾時後當成可重試的中斷
const SSE_IDLE_MS = Number(process.env.CODEX_MULTI_SSE_IDLE_MS) || 180000;

async function* sseLines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* */ } return; }
    let timer;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`伺服器 ${Math.round(SSE_IDLE_MS / 1000)} 秒沒有回應`); e.retryable = true; reject(e); }, SSE_IDLE_MS); });
    let chunk;
    try { chunk = await Promise.race([reader.read(), idle]); }
    catch (err) { reader.cancel().catch(() => {}); throw err; }
    finally { clearTimeout(timer); }
    const { done, value } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf) yield buf;
}

async function httpError(res) {
  let body = '';
  try { body = await res.text(); } catch { /* */ }
  const code = res.status;
  const tag = (e) => { e.status = code; e.retryable = code === 408 || code >= 500 || (code === 429 && !/credit|quota|billing|balance|insufficient/i.test(body)); return e; };
  return tag(describeHttpError(code, body));
}

function describeHttpError(code, body) {
  if (/^\s*</.test(body)) {
    return new Error(`連線被導到一般網頁，不是 API 伺服器（HTTP ${code}）。通常是這把金鑰的「API 網址」填錯了：到「API 設定」按「修改」，把 API 網址清空後再試。`);
  }
  let msg = body;
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error.type)) || j.message || body; } catch { /* */ }
  msg = String(msg).slice(0, 500);
  if (/API[ _]?key not valid|API_KEY_INVALID|api key expired/i.test(body)) return new Error(`金鑰無效或已過期（HTTP ${code}）。Gemini 金鑰請到 Google AI Studio 重新建立，再到「API 設定」按「修改」貼上。
${msg}`);
  if (code === 403 && /PERMISSION_DENIED|SERVICE_DISABLED|not enabled/i.test(body)) return new Error(`這把金鑰沒有權限使用這個模型或服務（HTTP 403）。請確認金鑰所屬的 Google 專案已啟用 Generative Language API。
${msg}`);
  if (code === 401) return new Error(`金鑰無效或已被刪除（HTTP 401）。請到官網重新建立一把，再到「API 設定」按「修改」貼上。\n${msg}`);
  if (code === 429 || code === 402) {
    if (/credit|quota|billing|balance|insufficient/i.test(body)) {
      return new Error(`這個 API 帳戶沒有餘額了（HTTP ${code}），跟 App 設定無關。API 是另外計費的，ChatGPT 或 Claude 的月費訂閱不包含 API 額度，要到官網的 Billing 頁面儲值才能用。\n原始訊息：${msg}`);
    }
    if (code === 429) return new Error(`請求太頻繁（HTTP 429），等一分鐘再試。\n${msg}`);
    return new Error(`帳戶餘額不足（HTTP 402），請到官網儲值。\n${msg}`);
  }
  if (code === 404) return new Error(`找不到這個模型或網址（HTTP 404）。請確認模型名稱是否正確。\n${msg}`);
  return new Error(`HTTP ${code}：${msg}`);
}

function networkError(err) {
  const cause = err && err.cause && (err.cause.code || err.cause.message);
  const e = new Error(`連不到伺服器${cause ? `（${cause}）` : ''}。請檢查網路，或暫時關掉 VPN、防火牆、防毒軟體的網頁防護後再試。`);
  e.retryable = true;
  return e;
}

async function doFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw networkError(err);
  }
}

// 將混合來源的對話整理成 API 需要的格式（只保留文字，合併連續同角色）
function buildHistory(messages, maxChars, provider = 'gpt') {
  const context = require('./context').compact(messages, maxChars);
  const clean = context.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim())
    .map((m) => ({ role: m.role, content: require('./attachments').content(m.text, m.attachments || [], provider) }));
  const merged = [];
  for (const m of clean) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) { const parts = c => Array.isArray(c) ? c : [{ type: 'text', text: c }]; last.content = [...parts(last.content), ...parts(m.content)]; }
    else merged.push({ ...m });
  }
  const kept = merged;
  const truncated = context.compacted;
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return { history: kept, truncated };
}

// OpenAI 相容（GPT API、DeepSeek）：一律串流，工具呼叫、長度截斷接續、斷線重試都在這個迴圈處理，
// 避免長任務跑到一半因為輸出上限或網路抖動就停在「回覆未完成」。
const MAX_TOOL_TURNS = 150;
const MAX_CONTINUATIONS = 6;
const MAX_RETRIES = 8;
const RETRY_CAP_MS = 60000;
// 每輪工具結果都會累積在請求裡；超過預算就把較舊的工具輸出收納成摘錄，避免跑到一半撞上下文上限
const LOOP_BUDGET_CHARS = Number(process.env.CODEX_MULTI_LOOP_BUDGET) || 360000;
const KEEP_RECENT_TOOLS = 6;
const CONTEXT_ERROR = /context length|context window|maximum context|reduce the length|too many tokens|prompt is too long|input is too long/i;
const DEEPSEEK_MAX_TOKENS = 64000;
const CONTINUE_PROMPT = '上一段輸出被截斷了（若包含未完成的工具呼叫，已被捨棄）。請從中斷處直接繼續，不要重複前文；需要工具時請重新完整呼叫。';

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

function mergeUsage(total, u) {
  if (!u) return total;
  if (!total) return { ...u };
  for (const [k, v] of Object.entries(u)) if (typeof v === 'number') total[k] = (total[k] || 0) + v;
  return total;
}

function contentChars(m) {
  const c = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  return c + (m.reasoning_content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}
const totalChars = (messages) => messages.reduce((n, m) => n + contentChars(m), 0);

// 由舊到新收納，最近的工具輸出與最後一則使用者訊息盡量保留原文；思考內容不動（DeepSeek 工具回合需要原樣回傳）
function shrinkMessages(messages, budget, loopStart) {
  const { excerpt } = require('./context');
  let total = totalChars(messages);
  if (total <= budget) return false;
  const tools = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(tools.slice(-KEEP_RECENT_TOOLS));
  const passes = [
    (m, i) => m.role === 'tool' && !recent.has(i) ? 600 : 0,
    (m, i) => m.role === 'tool' ? 2000 : 0,
    (m, i) => i >= loopStart && m.role === 'assistant' && i < messages.length - 2 ? 1500 : 0,
    (m, i) => m.role !== 'system' && typeof m.content === 'string' && i < loopStart - 1 ? 3000 : 0,
  ];
  let changed = false;
  for (const limitOf of passes) {
    for (let i = 0; i < messages.length && total > budget; i++) {
      const m = messages[i];
      const limit = limitOf(m, i);
      if (!limit || typeof m.content !== 'string' || m.content.length <= limit) continue;
      const before = m.content.length;
      m.content = excerpt(m.content, limit) + (m.role === 'tool' ? '\n〔較舊的工具輸出已收納；需要細節請重新呼叫工具〕' : '');
      total -= before - m.content.length;
      changed = true;
    }
    if (total <= budget) break;
  }
  return changed;
}

/** 合併供應商自帶的 extra_content（Gemini 的 thought_signature 就放在這裡），只做一層淺合併。 */
function mergeExtra(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] || {}), ...v } : v;
  }
  return out;
}

// Gemini 3 的思考簽章：上一輪的 functionCall 必須帶著原本的 thought_signature 回去。
// 萬一還是被退件（例如歷史被收納過、或簽章跨模型不通用），就把舊的工具回合改寫成純文字紀要再重送。
const THOUGHT_SIGNATURE_ERROR = /thought_signature|thought signature/i;

function flattenToolHistory(messages, loopStart) {
  let changed = false;
  for (let i = loopStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const summary = m.tool_calls.map((c) => `${c.function?.name}(${String(c.function?.arguments || '').slice(0, 300)})`).join('\n');
      messages[i] = { role: 'assistant', content: `${m.content ? `${m.content}\n\n` : ''}［先前已呼叫的工具］\n${summary}` };
      changed = true;
    } else if (m.role === 'tool') {
      messages[i] = { role: 'user', content: `［先前的工具結果］\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` };
      changed = true;
    }
  }
  return changed;
}

async function openAITurn({ url, apiKey, body, signal, onDelta, onReasoning }) {
  const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res);
  if (!res.body || typeof res.body.getReader !== 'function') {
    // 有些代理服務會忽略 stream，直接回整包 JSON
    const result = await res.json();
    if (result.error) throw new Error(result.error.message || 'API 錯誤');
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error('API 沒有回傳訊息');
    if (message.reasoning_content) onReasoning(message.reasoning_content);
    if (message.content) onDelta(message.content);
    return { content: message.content || '', reasoning: message.reasoning_content || '', toolCalls: message.tool_calls || [], finishReason: result.choices[0].finish_reason || 'stop', usage: result.usage, model: result.model };
  }
  let content = ''; let reasoning = ''; let finishReason = null; let ended = false; let usage = null; let model = null;
  const calls = [];
  try {
    for await (const line of sseLines(res, signal)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { ended = true; continue; }
      if (!data) continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) { const e = new Error(j.error.message || JSON.stringify(j.error)); e.retryable = /overload|busy|timeout|server/i.test(e.message); throw e; }
      if (j.model && !model) model = j.model;
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (d.reasoning_content) { reasoning += d.reasoning_content; onReasoning(d.reasoning_content); }
      if (d.content) { content += d.content; onDelta(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        const c = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        const name = tc.function?.name;
        if (name && c.function.name !== name) c.function.name += name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        // Gemini 3 會把 thought_signature 夾在 extra_content 裡，下一輪必須原封不動送回去，
        // 否則伺服器會回 400「Function call is missing a thought_signature」。
        if (tc.extra_content && typeof tc.extra_content === 'object') c.extra_content = mergeExtra(c.extra_content, tc.extra_content);
      }
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return { aborted: true, content, reasoning, toolCalls: [], usage, model };
    if (err.retryable === undefined) err.retryable = true; // 例如 undici 的 terminated / ECONNRESET
    err.partial = { content, reasoning };
    throw err;
  }
  if (signal?.aborted) return { aborted: true, content, reasoning, toolCalls: [], usage, model };
  if (!ended && !finishReason) {
    const e = new Error('串流連線提前結束');
    e.retryable = true; e.partial = { content, reasoning };
    throw e;
  }
  return { content, reasoning, toolCalls: calls.filter(Boolean), finishReason: finishReason || 'stop', usage, model };
}

async function streamOpenAI({ provider, cfg, model, system, history, options = {}, signal, onDelta, onReasoning, onStatus = () => {} }) {
  const url = `${trimBase(cfg.baseUrl || PROVIDERS[provider].defaultBase)}/chat/completions`;
  const messages = [...(system && system.trim() ? [{ role: 'system', content: system }] : []), ...history];
  const tools = options.tools?.length ? options.tools : null;
  let maxTokens = provider === 'deepseek' ? (Number(options.maxTokens) || DEEPSEEK_MAX_TOKENS) : 0;
  let usage = null; let servedModel = null;
  let continuations = 0; let retries = 0; let turns = 0; let contextRetries = 0; let signatureRetried = false;
  let budget = Number(options.loopBudgetChars) || LOOP_BUDGET_CHARS;
  const loopStart = messages.length;
  while (turns < MAX_TOOL_TURNS) {
    if (signal?.aborted) return { cancelled: true, usage, servedModel };
    if (shrinkMessages(messages, budget, loopStart)) onStatus('上下文空間整理完成（正常處理）：較舊工具輸出改用摘錄，本次任務繼續執行。');
    const body = { model, messages, stream: true };
    if (tools) body.tools = tools;
    if ((provider === 'gpt' || provider === 'gemini' || provider === 'grok' || provider === 'meta') && options.reasoningEffort && options.reasoningEffort !== 'default') body.reasoning_effort = options.reasoningEffort;
    if (provider === 'deepseek' && options.deepseekThinking && options.deepseekThinking !== 'default') body.thinking = { type: options.deepseekThinking };
    if (provider === 'deepseek') body.stream_options = { include_usage: true };
    if (maxTokens) body.max_tokens = maxTokens;
    let r;
    try {
      r = await openAITurn({ url, apiKey: cfg.apiKey, body, signal, onDelta, onReasoning });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return { cancelled: true, usage, servedModel };
      // 超過模型上下文：依錯誤訊息的上限縮小輸出保留量與輸入預算，收納後重送
      if (err.status === 400 && CONTEXT_ERROR.test(err.message) && contextRetries < 4) {
        contextRetries += 1;
        const m = /(?:context length|context window)[^\d]{0,20}(\d{4,})/i.exec(err.message) || /(\d{5,})\s*tokens/i.exec(err.message);
        const ctx = m ? Number(m[1]) : 0;
        if (ctx && maxTokens > ctx / 4) maxTokens = Math.max(4096, Math.floor(ctx / 4));
        const fit = ctx ? Math.floor((ctx - (maxTokens || ctx / 4)) * 0.85) : Infinity;
        budget = Math.max(12000, Math.min(Math.floor(totalChars(messages) * 0.6), fit));
        shrinkMessages(messages, budget, loopStart);
        onStatus(`內容超過模型上下文，已收納較舊內容後重送（第 ${contextRetries} 次）…`);
        continue;
      }
      // Gemini 的思考簽章沒帶回去：把舊的工具回合攤平成純文字再重送，保住整段工作不中斷
      if (err.status === 400 && THOUGHT_SIGNATURE_ERROR.test(err.message) && !signatureRetried) {
        signatureRetried = true;
        if (flattenToolHistory(messages, loopStart)) {
          onStatus('Gemini 需要思考簽章才能延續先前的工具呼叫；已把稍早的工具紀錄改成文字後重送…');
          continue;
        }
      }
      // 模型不接受這個 max_tokens：改用錯誤訊息給的上限，找不到就交給伺服器預設
      if (err.status === 400 && body.max_tokens && /max_tokens/i.test(err.message)) {
        const range = /\[\s*1\s*,\s*(\d+)\s*\]/.exec(err.message);
        maxTokens = range && Number(range[1]) < maxTokens ? Number(range[1]) : 0;
        continue;
      }
      if (err.retryable && retries < MAX_RETRIES) {
        retries += 1;
        const delay = Math.min(RETRY_CAP_MS, 2000 * 2 ** (retries - 1));
        if (err.partial?.content) {
          messages.push({ role: 'assistant', content: err.partial.content }, { role: 'user', content: CONTINUE_PROMPT });
          onDelta('\n');
        }
        onStatus(`連線中斷（${String(err.message).slice(0, 60)}），${Math.round(delay / 1000)} 秒後自動重試（第 ${retries}/${MAX_RETRIES} 次）…`);
        await sleep(delay, signal);
        continue;
      }
      if (err.retryable) err.message = `${err.message}（已自動重試 ${retries} 次仍失敗；內容已保留，可按「繼續」）`;
      throw err;
    }
    retries = 0;
    usage = mergeUsage(usage, r.usage);
    servedModel = servedModel || r.model || null;
    if (r.aborted) return { cancelled: true, usage, servedModel };
    if (r.finishReason === 'length') {
      if (continuations >= MAX_CONTINUATIONS) return { usage, servedModel, incomplete: true };
      continuations += 1;
      messages.push({ role: 'assistant', content: r.content || '（上一段在思考中被截斷）' }, { role: 'user', content: CONTINUE_PROMPT });
      onStatus('輸出達到長度上限，自動接續中…');
      continue;
    }
    const calls = tools ? r.toolCalls.filter((c) => c.function?.name) : [];
    if (!calls.length) return { usage, servedModel, incomplete: false };
    turns += 1;
    const assistant = { role: 'assistant', content: r.content || '', tool_calls: calls.map((c, i) => ({ id: c.id || `call_${turns}_${i}`, type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' }, ...(c.extra_content ? { extra_content: c.extra_content } : {}) })) };
    if (provider === 'deepseek' && r.reasoning) assistant.reasoning_content = r.reasoning;
    messages.push(assistant);
    if (r.content) onDelta('\n\n');
    for (const call of assistant.tool_calls) {
      if (signal?.aborted) return { cancelled: true, usage, servedModel };
      let output;
      try {
        if (!tools.some((t) => t.function.name === call.function.name)) throw new Error('目前權限禁止此工具');
        let input;
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('工具參數不是有效的 JSON，請重新呼叫'); }
        output = await options.executeTool(call.function.name, input);
      } catch (e) { output = `工具失敗：${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: require('./context').excerpt(output, 8000) });
    }
  }
  const e = new Error(`已連續執行 ${MAX_TOOL_TURNS} 輪工具；內容已保留，請按「繼續」執行下一輪。`);
  e.limit = true;
  throw e;
}

async function streamAnthropic({ cfg, model, system, history, options, signal, onDelta, onReasoning }) {
  const base = trimBase(cfg.baseUrl || PROVIDERS.claude.defaultBase);
  const url = `${base}/v1/messages`;
  const messages = [...history];
  let continuations = 0;
  for (let round = 0; round < 80; round++) {
  if (signal?.aborted) return { cancelled:true };
  const body = { model, max_tokens: Number(options.maxTokens) || 16000, messages, stream: true };
  if (options.tools?.length) body.tools = options.tools.map(t => ({ name:t.function.name, description:t.function.description, input_schema:t.function.parameters }));
  if (system && system.trim()) body.system = system;
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  let usage = null;
  let servedModel = null;
  const blocks = []; let stopReason = null; let ended = false;
  for await (const line of sseLines(res, signal)) {
    if (!line.startsWith('data:')) continue;
    let j;
    try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (j.type === 'error') throw new Error((j.error && j.error.message) || 'Claude API 回傳錯誤');
    if (j.type === 'message_start' && j.message && j.message.model) servedModel = j.message.model;
    if (j.type === 'content_block_start') blocks[j.index] = { ...j.content_block };
    if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta') onDelta(j.delta.text);
      else if (j.delta.type === 'thinking_delta') onReasoning(j.delta.thinking);
      const block = blocks[j.index];
      if (block) {
        if (j.delta.type === 'text_delta') block.text = (block.text || '') + j.delta.text;
        if (j.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + j.delta.thinking;
        if (j.delta.type === 'signature_delta') block.signature = (block.signature || '') + j.delta.signature;
        if (j.delta.type === 'input_json_delta') block._json = (block._json || '') + j.delta.partial_json;
      }
    }
    if (j.type === 'message_delta' && j.usage) usage = j.usage;
    if (j.type === 'message_delta') stopReason = j.delta?.stop_reason || stopReason;
    if (j.type === 'message_stop') ended = true;
  }
  if (signal?.aborted) return { cancelled:true };
  if (!ended) throw new Error('Claude 串流連線提前結束；已保留內容，可按繼續。');
  const content = blocks.filter(Boolean).map(block => { const b={...block}; if (b._json) b.input=JSON.parse(b._json); delete b._json; return b; });
  if (stopReason === 'tool_use') {
    const calls=content.filter(b => b.type === 'tool_use');
    if (!calls.length) throw new Error('Claude 工具回覆不完整，已停止以免重複執行');
    messages.push({ role:'assistant', content });
    const results=[];
    for (const b of calls) {
      if (signal?.aborted) return {cancelled:true};
      try {
        if (!options.tools?.some(t => t.function.name === b.name)) throw new Error('目前權限禁止此工具');
        const result = await options.executeTool(b.name,b.input);
        results.push({type:'tool_result',tool_use_id:b.id,content:require('./context').excerpt(result,8000)});
      } catch(e) { if(signal?.aborted) return {cancelled:true}; results.push({type:'tool_result',tool_use_id:b.id,content:e.message,is_error:true}); }
    }
    messages.push({role:'user',content:results});
    continue;
  }
  if (stopReason === 'max_tokens' && continuations++ < 3 && !content.some(b=>b.type==='tool_use')) {
    messages.push({role:'assistant',content},{role:'user',content:'接續剛才因輸出長度中斷的回答，從停止處繼續，不要重複前文。'}); continue;
  }
  return { usage, servedModel, incomplete:stopReason === 'max_tokens' };
  }
  throw new Error('已執行 80 輪工具；內容已保留，請按繼續執行下一輪。');
}

async function streamChat(args) {
  if (args.provider === 'deepseek') {
    const selected = args.model || args.cfg?.model || PROVIDERS.deepseek.defaultModel;
    if (/^deepseek-v4\.1(?:-flash)?(?:-1017)?$/i.test(selected)) {
      const error = new Error(`「${selected}」不是 DeepSeek 官方 API 模型 ID。DeepSeek 4.1 Flash 請選 deepseek-flash，或從 API 更新模型清單後選擇；原設定未自動更換。`);
      error.code = 'DEEPSEEK_MODEL_ID';
      throw error;
    }
    args = { ...args, model: selected };
  }
  if (args.provider === 'lmstudio') args = { ...args, cfg: { ...(args.cfg || {}), apiKey: (args.cfg && args.cfg.apiKey) || 'lm-studio' } };
  if (!args.cfg || !args.cfg.apiKey) throw new Error(`還沒有 ${PROVIDERS[args.provider].label} 的金鑰。請按左下角「API 設定」新增。`);
  if (args.provider === 'claude') return streamAnthropic(args);
  return streamOpenAI(args);
}

// LM Studio 的原生 /api/v0/models 會標示哪些模型「已載入」；舊版沒有這個端點時退回 /v1/models
function lmstudioRoot(cfg) { return trimBase((cfg && cfg.baseUrl) || PROVIDERS.lmstudio.defaultBase).replace(/\/v1$/i, ''); }
async function lmstudioModels(cfg) {
  const root = lmstudioRoot(cfg);
  const headers = cfg && cfg.apiKey && cfg.apiKey !== 'lm-studio' ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  let res;
  try { res = await doFetch(`${root}/api/v0/models`, { headers }); }
  catch (e) { throw new Error(`連不到 LM Studio（${root}）。請在 LM Studio 的「Developer」頁按 Start Server（或執行 lms server start），再試一次。`); }
  let list;
  if (res.ok) {
    const j = await res.json();
    list = (j.data || []).filter((m) => m && m.id).map((m) => ({ id: m.id, type: m.type || 'llm', loaded: m.state === 'loaded', tools: Array.isArray(m.capabilities) && m.capabilities.includes('tool_use'), context: m.loaded_context_length || m.max_context_length || 0 }));
  } else {
    const r2 = await doFetch(`${root}/v1/models`, { headers });
    if (!r2.ok) throw await httpError(r2);
    const j = await r2.json();
    list = (j.data || []).filter((m) => m && m.id).map((m) => ({ id: m.id, type: /embed/i.test(m.id) ? 'embeddings' : 'llm', loaded: null, tools: null, context: 0 }));
  }
  list = list.filter((m) => m.type !== 'embeddings');
  list.sort((a, b) => (b.loaded === true) - (a.loaded === true) || a.id.localeCompare(b.id));
  return list;
}
/** 沒指定模型時：用 LM Studio 目前載入的第一個；都沒載入就挑第一個（LM Studio 會自動載入）。 */
async function lmstudioPickModel(cfg) {
  const list = await lmstudioModels(cfg);
  const pick = list.find((m) => m.loaded) || list[0];
  if (!pick) throw new Error('LM Studio 裡還沒有任何語言模型。請先在 LM Studio 下載並載入一個模型。');
  return pick.id;
}

/**
 * 確認記住的模型還在 LM Studio 裡。「qwen3-4b@q5_k_xl」這種帶 @ 的 ID 只在那個量化版本載入時存在，
 * 卸載或檔案被刪後就再也載不回來，送出只會得到「No models loaded」。
 * 找不到時：先試同一個模型（去掉 @ 之後的部分），再用已載入的，最後用清單第一個。
 * 回傳 { model, changed, reason }；連不到 LM Studio 時原樣回傳，交給送出時的錯誤訊息處理。
 */
async function lmstudioResolveModel(cfg, wanted) {
  const id = String(wanted || '').trim();
  let list;
  try { list = await lmstudioModels(cfg); } catch { return { model: id, changed: false }; }
  if (!list.length) throw new Error('LM Studio 裡沒有任何語言模型。請先在 LM Studio 下載並載入一個模型。');
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (id && list.some((m) => same(m.id, id))) return { model: list.find((m) => same(m.id, id)).id, changed: false };
  const base = id.replace(/@.*$/, '');
  const pick = (base && list.find((m) => same(m.id.replace(/@.*$/, ''), base) && m.loaded))
    || (base && list.find((m) => same(m.id, base)))
    || list.find((m) => m.loaded) || list[0];
  return { model: pick.id, changed: true, reason: id ? `LM Studio 裡已經沒有「${id}」（可能已卸載或檔案被刪），這次改用「${pick.id}」。` : '' };
}

async function listModels(provider, cfg) {
  if (provider === 'lmstudio') return (await lmstudioModels(cfg)).map((m) => m.id);
  if (!cfg || !cfg.apiKey) throw new Error('請先填入 API 金鑰');
  const base = trimBase(cfg.baseUrl || PROVIDERS[provider].defaultBase);
  let url; let headers;
  if (provider === 'claude') {
    url = `${base}/v1/models?limit=100`;
    headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  } else {
    url = `${base}/models`;
    headers = { Authorization: `Bearer ${cfg.apiKey}` };
  }
  const res = await doFetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const ids = (j.data || []).map((m) => m.id).filter(Boolean);
  if (provider === 'gemini') {
    return ids.map((id) => id.replace(/^models\//, ''))
      .filter((id) => /^gemini/i.test(id) && !/(embedding|tts|live|audio|transcribe|robotics|image|veo|imagen)/i.test(id))
      .sort().reverse();
  }
  if (provider === 'ablit') return ids.filter((id) => !/(image|voice|tts|speech|embedding)/i.test(id)).sort().reverse();
  if (provider === 'meta') return ids.filter((id) => !/(image|voice|transcribe|tts|speech|embedding)/i.test(id)).sort().reverse();
  if (provider === 'grok') return ids.filter((id) => /^grok/i.test(id) && !/(imagine|image|video|voice|tts|stt|speech|embedding)/i.test(id)).sort().reverse();
  if (provider === 'gpt') return ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation|live)/i.test(id)).sort().reverse();
  return ids;
}

async function deepseekBalance(cfg) {
  const base = trimBase(cfg.baseUrl || PROVIDERS.deepseek.defaultBase).replace(/\/v1$/, '');
  const res = await doFetch(`${base}/user/balance`, { headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  return {
    available: j.is_available !== false,
    balances: (j.balance_infos || []).map((b) => ({ currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance })),
  };
}

const BILLING_PAGES = {
  gpt: 'https://platform.openai.com/settings/organization/billing/overview',
  claude: 'https://console.anthropic.com/settings/billing',
  deepseek: 'https://platform.deepseek.com/usage',
  gemini: 'https://aistudio.google.com/app/apikey',
  grok: 'https://console.x.ai',
  meta: 'https://ai.developer.meta.com/',
  ablit: 'https://abliteration.ai/',
  lmstudio: 'https://lmstudio.ai/docs/developer',
};

module.exports = {
  shrinkMessages, PROVIDERS, streamChat, listModels, lmstudioModels, lmstudioPickModel, lmstudioResolveModel, buildHistory, deepseekBalance, BILLING_PAGES,
  mergeExtra, flattenToolHistory };
