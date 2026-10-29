// API 模型（GPT / DeepSeek）在這台電腦上能用的工具：專案檔案、指令，以及操作 Brave 瀏覽器。
// 權限模式沿用 Codex 的講法：chat（僅聊天）／read-only（唯讀）／workspace-write（工作區寫入）／danger-full-access（完全存取）。
const fs = require('fs').promises;
const path = require('path');
const commandExecution = require('./commandExecution');

const spec = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required: required || [], additionalProperties: false } } });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const tab = () => ({ tabId: str('分頁 ID；省略時操作目前的分頁（可用 browser_tabs 查看）') });

// 預設瀏覽器工具：只開內建時控制內建瀏覽器；只開 Brave 時控制 Brave；兩者都開時控制內建瀏覽器。
const BROWSER_TOOLS = [
  spec('browser_open', '在所選瀏覽器開啟網址；如果給的是關鍵字，會直接搜尋。', { url: str('網址或搜尋關鍵字'), newTab: bool('true 表示開在新分頁'), browser: str('依對話指定模式可填 browser_list 回傳的 ID；同時選擇本段對話的瀏覽器') }, ['url']),
  spec('browser_snapshot', '列出目前頁面可以互動的元素（按鈕、連結、輸入框）與它們的編號與文字，並附上頁面文字。要點擊或輸入之前先用這個取得 index。', { ...tab() }),
  spec('browser_read', '讀取目前頁面的標題、網址與文字內容。', { maxChars: num('最多回傳幾個字元，預設 6000'), ...tab() }),
  spec('browser_click', '點擊頁面上的元素。優先用 browser_snapshot 拿到的 index。', { index: num('browser_snapshot 給的編號'), selector: str('CSS 選擇器'), text: str('用元素上的文字找（部分符合即可）'), ...tab() }),
  spec('browser_type', '在輸入框打字，可選擇送出（按 Enter）。', { index: num('browser_snapshot 給的編號'), selector: str('CSS 選擇器'), text: str('要輸入的文字'), submit: bool('輸入後按 Enter'), ...tab() }, ['text']),
  spec('browser_press', '按下鍵盤按鍵，例如 Enter、Tab、Escape、ArrowDown、PageDown。', { key: str('按鍵名稱'), ...tab() }, ['key']),
  spec('browser_scroll', '捲動頁面。', { deltaY: num('往下捲幾像素，負數往上'), deltaX: num('往右捲幾像素'), ...tab() }),
  spec('browser_back', '回到上一頁。', { ...tab() }),
  spec('browser_forward', '前進到下一頁。', { ...tab() }),
  spec('browser_wait', '等待頁面出現某段文字，或單純等一段時間。', { text: str('要等出現的文字'), ms: num('要等幾毫秒'), ...tab() }),
  spec('browser_tabs', '列出目前可操作的分頁；王品 Firefox 包含原本開啟的分頁，其他瀏覽器依本段對話範圍列出。', {}),
  spec('browser_screenshot', '把目前頁面截圖存成 PNG 檔，回傳檔案路徑（可以給使用者點開看）。', { full: bool('true 表示整頁截圖'), ...tab() }),
  spec('browser_close_tab', '關閉分頁。', { ...tab() }),
];

const BROWSER_EVAL = spec('browser_eval', '在目前頁面執行 JavaScript。只有在完全存取模式才提供。', { expression: str('要執行的 JavaScript'), ...tab() }, ['expression']);
const BROWSER_CHOICE_TOOLS = [spec('browser_list','列出實際安裝的瀏覽器及本段對話選擇，不開啟瀏覽器。',{}),spec('browser_select','依使用者指定選擇本段對話使用的瀏覽器；不會開啟瀏覽器。',{browser:str('browser_list 回傳的瀏覽器 ID；不能傳入路徑或指令')},['browser'])];

function braveAlias(tool) {
  const fn = tool.function;
  return { type: 'function', function: { ...fn, name: fn.name.replace(/^browser_/, 'brave_'), description: `在 App 外的外部 Brave 執行：${fn.description}` } };
}
const BRAVE_TOOLS = BROWSER_TOOLS.map(braveAlias);
const BRAVE_EVAL = braveAlias(BROWSER_EVAL);

const SHORTEN = 300;
const shorten = (value) => { const text = String(value || ''); return text.length > SHORTEN ? `${text.slice(0, SHORTEN)}…` : text; };

function definitions(mode, ctx = {}) {
  const tools = [];
  if (mode !== 'chat') tools.push(
    spec('read_file', '讀取專案內的 UTF-8 文字檔（最大 1MB）。', { path: str('相對於專案的檔案路徑') }, ['path']),
    spec('list_directory', '列出專案內的資料夾內容。', { path: str('相對於專案的資料夾路徑') }, ['path']),
  );
  if (mode === 'workspace-write' || mode === 'danger-full-access') tools.push(spec('write_file', '在專案內寫入 UTF-8 文字檔（最大 1MB）。', { path: str('相對於專案的檔案路徑'), content: str('完整檔案內容') }, ['path', 'content']));
  const timeout = num('逾時秒數，預設 120，上限 900；長時間的建置或測試請調高');
  if (mode === 'danger-full-access') tools.push(spec('run_command', '執行 PowerShell 指令（使用者已選擇完全存取）。', { command: str('要執行的指令'), timeout_seconds: timeout }, ['command']));
  else if (mode === 'workspace-write' && ctx.approval !== 'never') tools.push(spec('run_command', '執行 PowerShell 指令。工作目錄固定在專案內，而且每次執行前會先請使用者同意。', { command: str('要執行的指令'), timeout_seconds: timeout }, ['command']));
  if (ctx.browser) tools.push(...BROWSER_TOOLS);
  if (ctx.browser?.conversationChoice) tools.push(...BROWSER_CHOICE_TOOLS);
  if (ctx.braveBrowser) tools.push(...BRAVE_TOOLS);
  if (ctx.browser && mode === 'danger-full-access') tools.push(BROWSER_EVAL);
  if (ctx.braveBrowser && mode === 'danger-full-access') tools.push(BRAVE_EVAL);
  return tools;
}

async function scoped(root, target, write = false) {
  if (!root) throw new Error('請先選擇專案資料夾');
  if (typeof target !== 'string' || target.includes('\0') || (process.platform === 'win32' && target.replace(/^[a-z]:/i, '').includes(':'))) throw new Error('無效的檔案路徑');
  const base = await fs.realpath(root);
  const dest = path.resolve(base, target || '.');
  const inside = (p) => { const rel = path.relative(base, p); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  if (!inside(dest)) throw new Error('超出專案資料夾');
  let probe = dest;
  while (true) {
    try { const real = await fs.realpath(probe); if (!inside(real)) throw new Error('連結指向專案外'); break; }
    catch (e) { if (e.code !== 'ENOENT' || !write || probe === base) throw e; probe = path.dirname(probe); }
  }
  return dest;
}

// 工作區寫入模式下的指令不該碰專案外的路徑（真正的關卡是使用者的同意視窗）
async function checkCommandPaths(command, root) {
  const tokens = String(command).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (!token || token.startsWith('-')) continue;
    if (/^\\\\|^\/\//.test(token)) throw new Error('指令不能存取網路共享位置');
    const looksLikePath = /^[a-z]:[\\/]/i.test(token) || token.startsWith('/') || token.includes('\\') || token.startsWith('..');
    if (!looksLikePath) continue;
    const resolved = path.resolve(root, token);
    const rel = path.relative(root, resolved);
    const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
    if (outside) throw new Error(`指令只能存取專案內的檔案，這個路徑在專案外：${token}`);
  }
}

async function runBrowserTool(name, args, ctx) {
  const browser = ctx.browser;
  if (!browser) throw new Error('瀏覽器工具目前是關閉的。請在輸入區的權限選單開啟「操作瀏覽器」再試。');
  switch (name) {
    case 'browser_list': return JSON.stringify(await browser.list(),null,2);
    case 'browser_select': {const result=await browser.select({browser:args.browser});return `已選擇：${result.label}（${result.id}）。${result.note}\n尚未開啟瀏覽器。`;}
    case 'browser_open': {
      if(args.browser&&!browser.conversationChoice)throw Error('目前使用固定瀏覽器；請在權限選單改為「依對話指定瀏覽器」。');
      const r = await browser.open({ url: args.url, newTab: !!args.newTab, ...(args.browser?{browser:args.browser}:{}) });
      return `已開啟：${shorten(r.url)}\n標題：${r.title || '（沒有標題）'}\n分頁 ID：${r.tabId}`;
    }
    case 'browser_snapshot': {
      const s = await browser.snapshot({ tabId: args.tabId });
      const lines = (s.elements || []).map((el) => `[${el.idx}] ${el.tag}${el.type ? `(${el.type})` : ''} ${el.label || '（沒有文字）'}`);
      return `標題：${s.title}\n網址：${shorten(s.url)}\n\n可互動元素：\n${lines.join('\n') || '（沒有找到可互動的元素）'}\n\n頁面文字（節錄）：\n${String(s.text || '').slice(0, 1500)}`;
    }
    case 'browser_read': {
      const r = await browser.read({ tabId: args.tabId, maxChars: args.maxChars });
      return `標題：${r.title}\n網址：${shorten(r.url)}\n${r.truncated ? '（內容太長，只取前面一部分）\n' : ''}\n${r.text}`;
    }
    case 'browser_click': {
      const r = await browser.click({ tabId: args.tabId, index: args.index, selector: args.selector, text: args.text });
      return `已點擊「${r.desc}」。目前頁面：${r.title || '（沒有標題）'} ${shorten(r.url)}`;
    }
    case 'browser_type': {
      const r = await browser.type({ tabId: args.tabId, index: args.index, selector: args.selector, text: args.text, submit: !!args.submit });
      return `已輸入 ${r.length} 個字元${r.submitted ? '並按下 Enter' : ''}。`;
    }
    case 'browser_press': {
      await browser.press({ key: args.key, tabId: args.tabId });
      return `已按下 ${args.key}。`;
    }
    case 'browser_scroll': {
      const r = await browser.scroll({ tabId: args.tabId, deltaY: args.deltaY, deltaX: args.deltaX });
      return `已捲動，目前位置 ${r.scrollY}。`;
    }
    case 'browser_back': { const r = await browser.back({ tabId: args.tabId }); return `已回到上一頁：${r.title || ''} ${shorten(r.url)}`; }
    case 'browser_forward': { const r = await browser.forward({ tabId: args.tabId }); return `已前進：${r.title || ''} ${shorten(r.url)}`; }
    case 'browser_wait': {
      const r = await browser.wait({ tabId: args.tabId, text: args.text, ms: args.ms });
      return r.found === undefined ? `已等待 ${r.waited} 毫秒。` : r.found ? '頁面上已經出現該文字。' : '等不到該文字（已等 20 秒）。';
    }
    case 'browser_tabs': {
      const list = await browser.tabs();
      return list.map((t) => `${t.active ? '* ' : '  '}${t.tabId} ${t.title || '（沒有標題）'} - ${shorten(t.url)}`).join('\n') || '目前沒有分頁。';
    }
    case 'browser_screenshot': {
      const r = await browser.screenshot({ tabId: args.tabId, full: !!args.full });
      return `截圖已存到：${r.path}（${r.bytes} bytes）`;
    }
    case 'browser_close_tab': { await browser.closeTab({ tabId: args.tabId }); return '已關閉分頁。'; }
    case 'browser_eval': {
      const value = await browser.evalRaw(String(args.expression), { tabId: args.tabId });
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
    default: throw new Error(`不認識的瀏覽器工具：${name}`);
  }
}

// Cancellation cannot depend on an approval UI eventually resolving its promise.
function waitApproval(work, signal) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>finish(Object.assign(Error('已停止'),{name:'AbortError'}));
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(signal?.aborted)throw Object.assign(Error('已停止'),{name:'AbortError'});return work();}).then(value=>finish(null,value),error=>finish(error));
  });
}

async function execute(name, args, modeOrCtx, cwdIn, signalIn) {
  const ctx = modeOrCtx && typeof modeOrCtx === 'object' ? modeOrCtx : {mode:modeOrCtx,cwd:cwdIn,signal:signalIn};
  if(name!=='run_command')return executeInner(name,args,ctx);
  const progress=commandExecution.tracker(ctx.onCommand);
  progress.update('received');
  try{return await executeInner(name,args,{...ctx,commandProgress:progress});}
  catch(error){progress.update('result_ready',{reason:ctx.signal?.aborted?'cancelled':'failed',termination:'not_started_or_unknown'});throw error;}
}

async function executeInner(name, args, modeOrCtx, cwdIn, signalIn) {
  const ctx = modeOrCtx && typeof modeOrCtx === 'object' ? modeOrCtx : { mode: modeOrCtx, cwd: cwdIn, signal: signalIn };
  const { mode, cwd, signal } = ctx;
  const input = args || {};
  const isBrave = name.startsWith('brave_');
  const browserName = isBrave ? `browser_${name.slice(6)}` : name;
  const selectedBrowser = isBrave ? ctx.braveBrowser : ctx.browser;
  if (signal && signal.aborted) throw new Error('已停止');
  if ((name.startsWith('browser_') || isBrave) && !selectedBrowser) throw new Error(`${isBrave ? '外部 Brave' : '瀏覽器'}工具目前是關閉的。請在輸入區的權限選單勾選後再試。`);
  if (!definitions(mode, ctx).some((t) => t.function.name === name)) throw new Error('目前權限禁止此工具');
  if (name.startsWith('browser_') || isBrave) return runBrowserTool(browserName, input, { ...ctx, browser: selectedBrowser });
  if (name === 'run_command') {
    // 「禁止刪除檔案，除非經我授權」：不論權限多高，刪除都要另外問一次，而且不吃「本回合都允許」
    if (ctx.noDelete) {
      const reason = require('./deleteGuard').detect(input.command);
      if (reason) {
        ctx.commandProgress?.update('awaiting_approval');
        const ok = typeof ctx.approveDelete === 'function' && await waitApproval(() => ctx.approveDelete({ reason, detail: String(input.command), cwd }), signal);
        if (!ok) throw new Error(`使用者設定了「禁止刪除檔案，除非經我授權」，這次${reason}沒有得到授權，已被擋下。不要改用其他方式繞過；真的需要刪除時，先向使用者說明要刪哪些檔案與原因。`);
      }
    }
    if (mode === 'workspace-write') {
      await checkCommandPaths(input.command, cwd);
      if (typeof ctx.approve !== 'function') throw new Error('目前權限禁止此工具（需要使用者同意才能執行指令）');
      ctx.commandProgress?.update('awaiting_approval');
      const ok = await waitApproval(() => ctx.approve({ kind: 'command', detail: String(input.command), cwd }), signal);
      if (!ok) throw new Error('使用者拒絕執行這個指令，請改用其他方式或先詢問使用者。');
    }
    if (signal?.aborted) throw new Error('已停止');
    return commandExecution.run(input.command, { cwd, signal, timeoutSeconds: input.timeout_seconds, progress: ctx.commandProgress });
  }

  const file = await scoped(cwd, input.path, name === 'write_file');
  if (name === 'list_directory') return (await fs.readdir(file, { withFileTypes: true })).slice(0, 2000).map((x) => `${x.isDirectory() ? 'dir' : 'file'} ${x.name}`).join('\n');
  if (name === 'read_file') { if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('檔案超過 1 MB'); return fs.readFile(file, 'utf8'); }
  if (name === 'write_file') {
    if (Buffer.byteLength(input.content) > 1024 * 1024) throw new Error('內容超過 1 MB');
    try { if ((await fs.stat(file)).nlink > 1) throw new Error('不允許寫入硬連結'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.content, 'utf8');
    return '已寫入 ' + input.path;
  }
  throw new Error(`不認識的工具：${name}`);
}

const TOOL_LABELS = {
  read_file: '讀取檔案',
  list_directory: '列出資料夾',
  write_file: '寫入檔案',
  run_command: '執行指令',
  browser_open: '開啟網頁',
  browser_list: '列出瀏覽器',
  browser_select: '選擇瀏覽器',
  browser_snapshot: '看頁面元素',
  browser_read: '讀取頁面',
  browser_click: '點擊',
  browser_type: '輸入文字',
  browser_press: '按鍵',
  browser_scroll: '捲動頁面',
  browser_back: '上一頁',
  browser_forward: '下一頁',
  browser_wait: '等待頁面',
  browser_tabs: '列出分頁',
  browser_screenshot: '頁面截圖',
  browser_close_tab: '關閉分頁',
  browser_eval: '頁面指令',
  brave_open: '外部 Brave：開啟網頁',
  brave_snapshot: '外部 Brave：看頁面元素',
  brave_read: '外部 Brave：讀取頁面',
  brave_click: '外部 Brave：點擊',
  brave_type: '外部 Brave：輸入文字',
  brave_press: '外部 Brave：按鍵',
  brave_scroll: '外部 Brave：捲動',
  brave_back: '外部 Brave：上一頁',
  brave_forward: '外部 Brave：下一頁',
  brave_wait: '外部 Brave：等待',
  brave_tabs: '外部 Brave：列出分頁',
  brave_screenshot: '外部 Brave：頁面截圖',
  brave_close_tab: '外部 Brave：關閉分頁',
  brave_eval: '外部 Brave：頁面指令',
};

function label(name) { return TOOL_LABELS[name] || name; }

// 給訊息泡泡上的工具列一行簡短說明
function brief(name, args = {}) {
  if (name.startsWith('brave_')) name = `browser_${name.slice(6)}`;
  const first = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  switch (name) {
    case 'read_file':
    case 'list_directory':
    case 'write_file': return first(args.path);
    case 'run_command': return first(args.command);
    case 'browser_open': return first(args.url);
    case 'browser_select': return first(args.browser);
    case 'browser_click': return args.text ? `「${first(args.text)}」` : args.selector || (args.index !== undefined ? `#${args.index}` : '');
    case 'browser_type': return `${args.selector || (args.index !== undefined ? `#${args.index}` : '')} ← ${first(args.text).slice(0, 60)}`;
    case 'browser_press': return first(args.key);
    case 'browser_read':
    case 'browser_snapshot':
    case 'browser_screenshot': return first(args.tabId);
    default: return first(args.tabId || '');
  }
}

module.exports = { definitions, execute, scoped, checkCommandPaths, label, brief, TOOL_LABELS, BROWSER_TOOLS, BROWSER_CHOICE_TOOLS, BROWSER_EVAL, BRAVE_TOOLS, BRAVE_EVAL };
