'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function availability(config = {}) {
  if (config.enabled === false) return { app: false, brave: false, primary: null, both: false };
  if (config.wangpinEnabled === true) return { app: false, brave: false, primary: 'wangpin', both: false, wangpin: true };
  const modern = Object.prototype.hasOwnProperty.call(config, 'appEnabled') || Object.prototype.hasOwnProperty.call(config, 'braveEnabled');
  const app = modern ? config.appEnabled === true : config.engine !== 'brave';
  const brave = modern ? config.braveEnabled === true : config.engine === 'brave';
  return { app, brave, primary: app ? 'app' : brave ? 'brave' : null, both: app && brave };
}

function migrateLegacy(config = {}) {
  if (Object.prototype.hasOwnProperty.call(config, 'appEnabled') || Object.prototype.hasOwnProperty.call(config, 'braveEnabled')) return { ...config };
  const active = config.enabled !== false;
  return { ...config, appEnabled: active && config.engine !== 'brave', braveEnabled: active && config.engine === 'brave' };
}

function toolGuidance(config = {}) {
  const active = availability(config);
  if (!active.primary) return '';
  if (active.wangpin) return '使用者選擇操作王品瀏覽器（Firefox）：工作台 app_browser MCP 的 browser_* 工具直接控制原本的王品 Firefox 與現有登入分頁；先呼叫 browser_tabs 列出既有分頁，依實際 tabId 操作。不要用官方 Browser runtime 的分頁清單判斷 Firefox 是否連線；不要改用 Brave、Chrome、官方 Chromium 擴充或只用 Shell 開網址。先 browser_snapshot 再點擊或輸入；只有成功工具結果才可聲稱完成。';
  if (active.both) return '你可以操作兩套彼此分開的瀏覽器：browser_* 是 App 右側的內建瀏覽器；brave_* 是 App 外的外部 Brave。使用者說「外部 Brave」「App 外」「在 Brave 裡」時，必須用 brave_*；說「內建瀏覽器」「右側面板」時用 browser_*。點擊或輸入前先取得該瀏覽器的 snapshot。';
  if (active.app) return '你可以用 browser_* 操作 App 右側的內建瀏覽器。使用者要開網頁、點擊、輸入或截圖時，直接使用工具；點擊或輸入前先用 browser_snapshot。';
  return '你可以用 browser_* 操作 App 外的外部 Brave。使用者要開網頁、點擊、輸入或截圖時，直接使用工具；點擊或輸入前先用 browser_snapshot。';
}

// 'claude-cli' 是走 Claude Code 帳號的 Claude（可用 --chrome 接 Brave 裡的 Claude 官方擴充）；
// 用 API 金鑰的 Claude 沒有擴充可用，仍走工作台的 CDP 瀏覽器。
const EXTENSION_PROVIDERS = new Set(['codex', 'claude-cli']);
function prefersBraveExtension(config = {}, provider = 'codex') {
  return EXTENSION_PROVIDERS.has(provider) && availability(config).brave && config.preferBraveExtension !== false;
}

function findBrowserClient(home) {
  const root = path.join(home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'browser');
  try {
    for (const version of fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const client = path.join(root, version, 'scripts', 'browser-client.mjs');
      if (fs.statSync(client, { throwIfNoEntry: false })?.isFile()) return fs.realpathSync(client).replace(/\\/g, '/');
    }
  } catch { /* Missing plugin: explain setup instead. */ }
  return null;
}

function nativeAvailability(config = {}, provider = 'codex') {
  const active = availability(config);
  if (!prefersBraveExtension(config, provider)) return active;
  // CDP tools must not masquerade as the official Brave extension.
  return { app: active.app, brave: false, primary: active.app ? 'app' : null, both: false };
}

function codexGuidance(config = {}, home) {
  if (!prefersBraveExtension(config)) return toolGuidance(config);
  const client = findBrowserClient(home);
  let setup;
  if (client) {
    const fileUrl = require('url').pathToFileURL(client).href;
    setup = `若提供 node_repl 的 js 工具，可在該工具初始化官方 runtime：var {setupBrowserRuntime} = await import(${JSON.stringify(fileUrl)} /* 來源：${JSON.stringify(client)} */); globalThis.agent = await setupBrowserRuntime(); console.log(await agent.browsers.list()); 依傳回清單選 type 為 extension、名稱／id 明確屬於 Brave 的瀏覽器，使用 await agent.browsers.get(實際傳回的id)，先讀取該瀏覽器的 documentation() 再操作。只初始化一次，續用既有 runtime。`;
  } else {
    setup = '如果官方 Browser runtime 或工具未安裝，請明確說明需要在官方 ChatGPT／Codex 桌面 App 的 Computer Use 設定啟用 Brave 與官方擴充。';
  }
  return [
    '本回合使用者已勾選「使用外部 Brave」，並選擇 Codex 優先使用 Brave 的官方 ChatGPT／Codex 擴充。這是持續有效的瀏覽器選擇；遇到需要網頁互動、已登入網站或檢查頁面的任務，主動調用擴充工具完成，不要只提供手動步驟，也不用再等使用者重複指定。',
    '優先使用目前實際提供的官方 cua_repl／Browser 工具，明確選擇 Brave（不可選 Chrome 或 Edge，也不要依系統預設瀏覽器猜測）。有 cua API 時按該工具文件選 Brave；只有 node_repl 時使用以下初始化方式。',
    setup,
    '先以列出分頁等輕量操作確認連線。使用 Brave 中裝有官方擴充的設定檔與既有登入；不可另開工作台的隔離 Brave 設定檔。點擊、輸入與頁面讀取都遵守官方 runtime 文件與網站權限。',
    '若使用者要求在 Brave 開啟網頁或分頁，且工作台提供了 brave_open_visible 工具，優先直接呼叫 brave_open_visible 在使用者的 Brave 視窗開啟分頁，不要拒絕操作或要求手動步驟。',
    '若工具未提供、Brave 未列出或擴充連線失敗，清楚回報實際原因及官方桌面 App／Brave 的必要設定。不得聲稱已用擴充，不得繞過拒絕或自動改用 CDP、Playwright、Shell 或其他瀏覽器。',
    ...(availability(config).app ? ['使用者明確指定「App 內建瀏覽器／右側面板」時才改用 app_browser 的 browser_* 工具；一般網頁任務沿用上面的 Brave 擴充選擇。'] : []),
  ].join('\n');
}

const CHROME_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'navigate', 'read_page', 'get_page_text', 'find', 'computer', 'form_input', 'list_connected_browsers', 'select_browser', 'switch_browser'].map((n) => `mcp__claude-in-chrome__${n}`);

function claudeGuidance(config = {}) {
  if (!prefersBraveExtension(config, 'claude-cli')) return toolGuidance(config);
  return [
    '本回合使用者已勾選「使用外部 Brave」：請用 Brave 裡已安裝的 Claude 官方擴充（mcp__claude-in-chrome__* 工具）操作使用者自己的 Brave。這是使用者平常的設定檔，帶著既有的 Google、Blogger 等登入；遇到需要網頁互動、已登入網站或檢查頁面的任務，主動使用這些工具完成，不要只提供手動步驟。',
    `這些工具是延遲載入的：第一次使用前先呼叫 ToolSearch，query 用 "select:${CHROME_TOOLS.join(',')}"（其他工具再用 query "claude-in-chrome" 搜尋）。`,
    '選擇瀏覽器：工具回報「多個瀏覽器已連線、尚未選擇」時，先呼叫 list_connected_browsers；若剛好一個名稱含 Brave（不分大小寫），使用者已在設定指定 Brave，直接用 select_browser 選它。否則呼叫 switch_browser，並告訴使用者到 Brave 的 Claude 擴充按「Connect」、把它命名為 Brave，之後就會自動選中。不要選名稱明顯是 Chrome、Edge 等其他瀏覽器的項目。',
    '分頁：先呼叫 tabs_context_mcp；需要分頁時用 tabs_create_mcp 開新分頁再 navigate，新分頁與使用者的分頁共用同一份登入。使用者要你處理他已開著的頁面時，請他把那個分頁拖進 Claude 的分頁群組，或在你的分頁開同一個網址。',
    '不要改用 WebFetch、scrapling、Playwright、工作台的隔離瀏覽器，或派子 agent 代為操作需要登入的網站；它們都沒有使用者的登入。若擴充工具不存在或連不上，清楚回報實際錯誤，並提醒：Brave 要開著、Claude 擴充要登入與這次相同的 Claude 帳號。',
    '若使用者只要求在 Brave 開啟某個網頁給他看，且工作台提供了 brave_open_visible，可直接用它開分頁。',
    ...(availability(config).app ? ['使用者明確指定「App 內建瀏覽器／右側面板」時才改用 app_browser 的 browser_* 工具。'] : []),
  ].join('\n');
}

function cleanTranscriptText(text) {
  if (typeof text !== 'string') return text;
  // Only the known 1.9.42/43 generated prefix at the start of a native user
  // message. Preserve quotes, assistant replies and unrelated user content.
  const normalized = text.replace(/\r\n/g, '\n');
  const marker = '（本回合瀏覽器設定）\n';
  if (!normalized.startsWith(marker)) return text;
  const body = normalized.slice(marker.length);
  if (!/^(本回合使用者已勾選「使用外部 Brave」|你可以用 browser_\* 操作 App |你可以操作兩套彼此分開的瀏覽器|使用者選擇操作王品瀏覽器（Firefox）)/.test(body)) return text;
  const end = body.indexOf('\n\n');
  return end === -1 ? text : body.slice(end + 2);
}

module.exports = { availability, migrateLegacy, toolGuidance, prefersBraveExtension, nativeAvailability, codexGuidance, claudeGuidance, findBrowserClient, cleanTranscriptText };
