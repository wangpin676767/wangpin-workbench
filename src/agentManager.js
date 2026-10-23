// 跨模型子 agent：每個 agent 是一段獨立的 app 對話（自己的歷史、模型、權限、執行狀態），
// 由同一套 handleSend 執行，所以 Codex / GPT / Claude / DeepSeek / Gemini 都能當主 agent 或子 agent。
const PROVIDERS = ['codex', 'gpt', 'claude', 'deepseek', 'gemini', 'grok', 'meta', 'ablit', 'lmstudio'];
const LEVELS = ['chat', 'read-only', 'workspace-write', 'danger-full-access'];
const ACTIVE = new Set(['queued', 'running']);
const RESULT_CHARS = 12000;

const {clip} = require('./agentResultSummary');

// 子 agent 的權限 = 主 agent 的權限（和 Codex 子代理一樣繼承），換算成各家的設定值
function optionsFor(provider, level, providerSettings = {}) {
  const s = providerSettings[provider] || {};
  if (provider === 'codex') return { sandbox: level === 'chat' ? 'read-only' : level, effort: s.effort || 'default' };
  // 網頁版開了「模仿 Codex 架構」才能自己呼叫工具，子 agent 留在網頁版；否則改走 Codex 帳號
  if (provider === 'gpt') return { via: s.via === 'api' ? 'api' : s.via === 'web' && s.webAgent === true ? 'web' : 'codex', permission: level, reasoningEffort: s.reasoningEffort || 'default' };
  if (provider === 'deepseek') return { permission: level, thinking: s.thinking || 'default' };
  if (provider === 'grok' || provider === 'meta') return { permission: level, reasoningEffort: s.reasoningEffort || 'default' };
  if (provider === 'ablit' || provider === 'lmstudio') return { permission: level };
  if (provider === 'gemini') return { permission: level, reasoningEffort: s.reasoningEffort || 'default' };
  return { via: s.via || 'claudecode', effort: s.effort || 'default', permission: level,
    claudePermission: { chat: 'chat', 'read-only': 'plan', 'workspace-write': 'default', 'danger-full-access': 'bypassPermissions' }[level] };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
const TOOLS = [
  fn('spawn_agent', '建立一個平行執行的子 agent 處理可獨立完成的子任務，可指定不同模型（codex / gpt / claude / deepseek / gemini / grok / meta / ablit / lmstudio）。子 agent 在同一個專案資料夾工作、權限與你相同，看不到你的對話，所以 task 要寫清楚完整需求與驗收條件。回傳 agent_id；之後用 wait_agents 取得結果。只在任務能拆成獨立部分，或使用者要求多 agent 時使用；多個 agent 不要同時修改同一個檔案。',
    obj({ task: { type: 'string', description: '給子 agent 的完整任務說明' }, name: { type: 'string', description: '簡短名稱，例如「前端檢查」' }, provider: { type: 'string', enum: PROVIDERS, description: '使用哪個模型供應商；省略則與你相同' }, model: { type: 'string', description: '模型 ID；省略則用該供應商的預設模型' } }, ['task'])),
  fn('wait_agents', '等待子 agent 完成並取得結果。mode=all 等全部完成，any 等任一完成；逾時會回傳目前狀態，可再呼叫一次繼續等。',
    obj({ agent_ids: { type: 'array', items: { type: 'string' }, description: '要等的 agent_id；省略表示你建立的所有執行中 agent' }, timeout_seconds: { type: 'number', description: '最多等幾秒，預設 120，上限 600' }, mode: { type: 'string', enum: ['all', 'any'] } })),
  fn('send_agent_message', '傳送後續指示給子 agent。它正在執行時會排在本輪之後處理，已完成則立刻開始新一輪。',
    obj({ agent_id: { type: 'string' }, message: { type: 'string' } }, ['agent_id', 'message'])),
  fn('list_agents', '列出你建立的子 agent 與它們的狀態、模型和結果摘要。', obj({})),
  fn('cancel_agent', '停止一個子 agent（包含排隊中的後續訊息）。', obj({ agent_id: { type: 'string' } }, ['agent_id'])),
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const TOOL_LABELS = { spawn_agent: '建立子 agent', wait_agents: '等待子 agent', send_agent_message: '傳訊息給子 agent', list_agents: '列出子 agent', cancel_agent: '停止子 agent' };

function createAgentManager(deps) {
  // deps: run(req, sink), cancelRun(reqId), readChat(id), writeChat(chat),
  //       listChatMetadata() (preferred) or readAllChats(), newId(prefix),
  //       settings() -> 目前設定, forward(ev) 轉送串流給畫面, notify(parentKey), checkProvider(provider) -> 錯誤訊息或 null
  const agents = new Map();
  const maxConcurrent = () => Math.max(1, Math.min(8, Number(deps.settings().agents?.maxConcurrent) || 4));
  const maxChildren = () => Math.max(1, Math.min(16, Number(deps.settings().agents?.maxChildren) || 8));
  const runningCount = () => [...agents.values()].filter((a) => a.status === 'running').length;

  function view(a) {
    return { id: a.id, key: a.key, parentKey: a.parentKey, name: a.name, provider: a.provider, model: a.model || '', level: a.level,
      status: a.status, result: a.result ? clip(a.result, 1200) : '', error: a.error || '', queued: a.queue.length,
      lastText: clip(a.lastText, 400), tools: a.tools, createdAt: a.createdAt, finishedAt: a.finishedAt || null };
  }

  async function persist(a) {
    const chat = await deps.readChat(a.id);
    if (!chat) return;
    chat.agent = { parentKey: a.parentKey, name: a.name, provider: a.provider, model: a.model, level: a.level, task: a.task, status: a.status,
      result: a.result ? clip(a.result, RESULT_CHARS) : '', error: a.error || '', spawnedBy: a.spawnedBy || null, finishedAt: a.finishedAt || null };
    await deps.writeChat(chat, { keepTime: true });
  }

  function settle(a) {
    for (const w of [...a.waiters]) w();
  }

  function pump() {
    for (const a of agents.values()) {
      if (runningCount() >= maxConcurrent()) return;
      if (a.status === 'queued' && a.pending && !a.starting) startRun(a).catch(() => {});
    }
  }

  async function startRun(a) {
    a.starting = true;
    const text = a.pending; a.pending = null;
    a.status = 'running'; a.error = ''; a.lastText = ''; a.tools = 0;
    a.reqId = deps.newId('agentrun');
    try { await persist(a); } catch { /* 狀態寫入失敗不影響執行 */ }
    a.starting = false;
    if (a.cancelled) { finish(a, 'cancelled'); return; }
    deps.notify(a.parentKey);
    const reqId = a.reqId;
    const sink = {
      isDestroyed: () => false,
      send: (channel, ev) => {
        if (channel !== 'stream' || ev.reqId !== reqId) return;
        if (ev.type === 'delta') a.lastText += ev.text || '';
        if (ev.type === 'item' && ev.item?.status === 'in_progress') a.tools += 1;
        deps.forward({ ...ev, agent: { id: a.id, parentKey: a.parentKey, name: a.name, provider: a.provider, model: a.model } });
        if (ev.type === 'done') onRunEnd(a, reqId, ev.cancelled ? 'cancelled' : 'completed', '');
        if (ev.type === 'error' || ev.type === 'locked') onRunEnd(a, reqId, 'failed', ev.message || '子 agent 執行失敗');
      },
    };
    deps.run({ reqId, key: a.key, provider: a.provider, model: a.model, text, options: optionsFor(a.provider, a.level, deps.settings().providers), agentCtx: { child: true, agentId: a.id } }, sink);
  }

  async function onRunEnd(a, reqId, status, error) {
    if (a.reqId !== reqId) return;
    a.reqId = null;
    try {
      const chat = await deps.readChat(a.id);
      const last = [...(chat?.messages || [])].reverse().find((m) => m.role === 'assistant' && m.text);
      a.result = last ? last.text : a.lastText;
    } catch { a.result = a.lastText; }
    if (a.cancelled) status = 'cancelled';
    if (status !== 'cancelled' && a.queue.length) {
      a.pending = a.queue.splice(0).join('\n\n---\n\n');
      a.status = 'queued';
      await persist(a).catch(() => {});
      pump();
      return;
    }
    finish(a, status, error);
  }

  function finish(a, status, error = '') {
    a.status = status; a.error = error; a.finishedAt = Date.now();
    persist(a).catch(() => {});
    settle(a);
    deps.notify(a.parentKey);
    pump();
  }

  async function spawn({ parentKey, task, name, provider, model, level, cwd, spawnedBy, extensions }) {
    task = String(task || '').trim();
    if (!task) throw new Error('請提供子 agent 的任務內容');
    if (!PROVIDERS.includes(provider)) throw new Error(`不支援的模型供應商：${provider}`);
    if (!LEVELS.includes(level)) level = 'chat';
    const problem = deps.checkProvider(provider);
    if (problem) throw new Error(problem);
    const active = [...agents.values()].filter((a) => a.parentKey === parentKey && ACTIVE.has(a.status)).length;
    if (active >= maxChildren()) throw new Error(`同一段對話最多同時 ${maxChildren()} 個子 agent，請先等待或停止其中幾個`);
    const id = deps.newId('agent');
    const label = String(name || '').trim().slice(0, 40) || task.replace(/\s+/g, ' ').slice(0, 30);
    const a = { id, key: `app:${id}`, parentKey, name: label, provider, model: String(model || '').trim(), level, task, cwd: cwd || '', spawnedBy: spawnedBy || null, extensions: Array.isArray(extensions) ? [...extensions] : null,
      status: 'queued', queue: [], waiters: new Set(), result: '', error: '', lastText: '', tools: 0, createdAt: Date.now(), cancelled: false };
    const brief = `你是由主 agent 建立的子 agent「${label}」。只完成下面的任務；完成後用精簡文字回報：做了什麼、關鍵發現、修改了哪些檔案、還沒完成的事項。不要再建立其他 agent。\n工作專案：${cwd || '未指定（只能聊天或分析）'}\n\n任務：\n${task}`;
    a.pending = brief;
    // 子 agent 沿用主對話勾選的能力擴充，但各自建立連線，不會共用同一個外部程序
    await deps.writeChat({ id, origin: 'app', title: `🤖 ${label}`, cwd: cwd || '', codexThreadId: null, messages: [], createdAt: new Date().toISOString(), lastProvider: provider,
      extensions: a.extensions,
      agent: { parentKey, name: label, provider, model: a.model, level, task, status: 'queued', spawnedBy: a.spawnedBy } });
    agents.set(id, a);
    deps.notify(parentKey);
    pump();
    return view(a);
  }

  async function list(parentKey) {
    const out = new Map();
    // Listing status must not load every conversation's complete history.
    const chats = await (deps.listChatMetadata ? deps.listChatMetadata() : deps.readAllChats());
    for (const chat of chats) {
      if (!chat.agent || chat.agent.parentKey !== parentKey) continue;
      const g = chat.agent;
      out.set(chat.id, { id: chat.id, key: `app:${chat.id}`, parentKey, name: g.name, provider: g.provider, model: g.model || '', level: g.level,
        status: ACTIVE.has(g.status) ? 'interrupted' : g.status, result: g.resultSummary ?? clip(g.result, 1200), error: g.error || '', queued: 0, lastText: '', tools: 0,
        createdAt: Date.parse(chat.createdAt) || 0, finishedAt: g.finishedAt || null });
    }
    for (const a of agents.values()) if (a.parentKey === parentKey) out.set(a.id, view(a));
    return [...out.values()].sort((x, y) => x.createdAt - y.createdAt);
  }

  async function revive(id, parentKey) {
    let a = agents.get(id);
    if (a) return a.parentKey === parentKey || parentKey === undefined ? a : null;
    const chat = await deps.readChat(id);
    const g = chat?.agent;
    if (!g || (parentKey !== undefined && g.parentKey !== parentKey)) return null;
    a = { id, key: `app:${id}`, parentKey: g.parentKey, name: g.name, provider: g.provider, model: g.model || '', level: g.level, task: g.task, cwd: chat.cwd || '',
      status: ACTIVE.has(g.status) ? 'interrupted' : g.status, queue: [], waiters: new Set(), result: g.result || '', error: g.error || '', lastText: '', tools: 0,
      createdAt: Date.parse(chat.createdAt) || Date.now(), cancelled: false, spawnedBy: g.spawnedBy || null };
    agents.set(id, a);
    return a;
  }

  async function message(id, text, parentKey) {
    text = String(text || '').trim();
    if (!text) throw new Error('訊息不能是空的');
    const a = await revive(id, parentKey);
    if (!a) throw new Error('找不到這個子 agent（只能操作這段對話建立的 agent）');
    if (a.status === 'running' || a.status === 'queued') { a.queue.push(text); deps.notify(a.parentKey); return { ...view(a), note: '已排入佇列，本輪結束後處理' }; }
    const problem = deps.checkProvider(a.provider);
    if (problem) throw new Error(problem);
    a.cancelled = false; a.status = 'queued'; a.pending = text; a.finishedAt = null;
    deps.notify(a.parentKey);
    pump();
    return view(a);
  }

  async function cancel(id, parentKey) {
    const a = await revive(id, parentKey);
    if (!a) throw new Error('找不到這個子 agent');
    a.queue.length = 0;
    if (!ACTIVE.has(a.status)) return view(a);
    a.cancelled = true;
    if (a.reqId && a.status === 'running' && !a.starting) deps.cancelRun(a.reqId);
    else if (a.status === 'queued' && !a.starting) { a.pending = null; finish(a, 'cancelled'); }
    return view(a);
  }

  function cancelSpawnedBy(reqId) {
    for (const a of agents.values()) if (a.spawnedBy === reqId && ACTIVE.has(a.status)) cancel(a.id).catch(() => {});
  }

  function wait(parentKey, ids, timeoutMs, mode = 'all', signal) {
    const pick = [...agents.values()].filter((a) => a.parentKey === parentKey && (ids?.length ? ids.includes(a.id) : ACTIVE.has(a.status)));
    const missing = (ids || []).filter((id) => !pick.some((a) => a.id === id));
    const doneOf = () => pick.filter((a) => !ACTIVE.has(a.status));
    const ready = () => !pick.length || (mode === 'any' ? doneOf().length > 0 : doneOf().length === pick.length);
    const report = (timedOut) => ({
      timed_out: timedOut && !ready(),
      agents: pick.map((a) => ({ agent_id: a.id, name: a.name, provider: a.provider, model: a.model, status: a.status,
        ...(ACTIVE.has(a.status) ? { progress: clip(a.lastText, 600) } : { result: clip(a.result, RESULT_CHARS), error: a.error || undefined }) })),
      ...(missing.length ? { unknown_ids: missing } : {}),
    });
    if (ready()) return Promise.resolve(report(false));
    return new Promise((resolve) => {
      let timer;
      const check = () => { if (ready()) end(false); };
      const end = (timedOut) => { clearTimeout(timer); for (const a of pick) a.waiters.delete(check); signal?.removeEventListener?.('abort', abort); resolve(report(timedOut)); };
      const abort = () => end(true);
      for (const a of pick) a.waiters.add(check);
      timer = setTimeout(() => end(true), timeoutMs);
      signal?.addEventListener?.('abort', abort, { once: true });
    });
  }

  // 模型呼叫協作工具的入口；ctx 綁定呼叫者所在的對話，模型不能跨對話操作 agent
  async function handleTool(name, args = {}, ctx) {
    if (!TOOL_NAMES.has(name)) throw new Error(`不認識的工具：${name}`);
    const { parentKey } = ctx;
    let result;
    if (name === 'spawn_agent') {
      const provider = args.provider || ctx.provider;
      const model = args.model || (provider === ctx.provider ? ctx.model : '');
      const a = await spawn({ parentKey, task: args.task, name: args.name, provider, model, level: ctx.level, cwd: ctx.cwd, spawnedBy: ctx.reqId, extensions: ctx.extensions });
      result = { agent_id: a.id, name: a.name, provider: a.provider, model: a.model || '（預設）', status: a.status };
    } else if (name === 'wait_agents') {
      const secs = Math.max(1, Math.min(600, Number(args.timeout_seconds) || 120));
      result = await wait(parentKey, Array.isArray(args.agent_ids) ? args.agent_ids.map(String) : [], secs * 1000, args.mode === 'any' ? 'any' : 'all', ctx.signal);
    } else if (name === 'send_agent_message') {
      const a = await message(String(args.agent_id || ''), args.message, parentKey);
      result = { agent_id: a.id, status: a.status, note: a.note || '已送出' };
    } else if (name === 'cancel_agent') {
      const a = await cancel(String(args.agent_id || ''), parentKey);
      result = { agent_id: a.id, status: a.status };
    } else {
      result = { agents: (await list(parentKey)).map((a) => ({ agent_id: a.id, name: a.name, provider: a.provider, model: a.model, status: a.status, summary: a.result || a.error || a.lastText })) };
    }
    return JSON.stringify(result, null, 1);
  }

  return { spawn, list, message, cancel, cancelSpawnedBy, wait, handleTool, live: agents };
}

module.exports = { createAgentManager, TOOLS, TOOL_NAMES, TOOL_LABELS, optionsFor, LEVELS };
