// 攔截程式（刪除保護 hook）用工作台本體以 Node 模式執行。萬一呼叫端沒帶 ELECTRON_RUN_AS_NODE，
// 這裡會被當成一般 App 啟動：開出一整個工作台視窗、觸發 second-instance 把主視窗叫到前景，
// 而且 hook 本身沒跑、等於放行。所以最前面先攔下來，改用 Node 模式重跑一次、原樣接上 stdio。
if (process.argv.slice(1).some((a) => /deleteGuardHook\.js$/i.test(String(a)))) {
  const { spawnSync } = require('child_process');
  const script = process.argv.slice(1).find((a) => /deleteGuardHook\.js$/i.test(String(a)));
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme, Menu, clipboard } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const codexStore = require('./codexStore');
const providers = require('./providers');
const codexRunner = require('./codexRunner');
const claudeCode = require('./claudeCode');
const claudeDesktopAuth = require('./claudeDesktopAuth');
const os = require('os');
const attachments = require('./attachments');
const { parseImport } = require('./importChat');
const chatBackup = require('./chatBackup');
const apiTools = require('./apiTools');
const { registerRun } = require('./runControl');
const chatLinks = require('./chatLinks');
const chatWorkspace = require('./chatWorkspace');
const antigravity = require('./antigravityCli');
const sidebarMirrorKit = require('./sidebarMirror');
const browserControl = require('./browserControl');
const browserPolicy = require('./browserPolicy');
const claudeHistory = require('./claudeHistory');
const agentKit = require('./agentManager');
const codexAccountsKit = require('./codexAccounts');
const extensionsKit = require('./extensions');
const deleteGuardKit = require('./deleteGuard');
const chatSearch = require('./chatSearch');
const grokBotBridgeKit = require('./grokBotBridge');
const grokBuild = require('./grokBuild');
// 內容搜尋的訊息快取：key -> { stamp(更新時間), messages }；對話有新內容時 stamp 會變
const searchCache = require('./historyCache').create();
let searchGeneration = 0;
let claudeHistoryCache = { sessions: [], errors: [] };
let claudeHistoryAt = 0;
let claudeHistoryPending = null;
function localClaudeHistory(force = false) {
  if (!force && Date.now() - claudeHistoryAt < 5000) return Promise.resolve(claudeHistoryCache);
  if (!claudeHistoryPending) claudeHistoryPending = claudeHistory.list([
    settings.providers.claude.configDir,
    ...(settings.claudeAccounts || []).map(a => a.configDir),
    process.env.CLAUDE_CONFIG_DIR,
    path.join(os.homedir(), '.claude'),
  ]).then(r => { claudeHistoryCache = r; claudeHistoryAt = Date.now(); return r; }).finally(() => { claudeHistoryPending = null; });
  return claudeHistoryPending;
}
const stagedAttachments = new Map();
const contextManager = require('./context');
const browserScopes = new Map();
const useAppBrowser = () => browserPolicy.availability(settings.browser || {}).app;
let appBrowserHost = null;
function appBrowser() {
  if (!appBrowserHost) {
    const electron = require('electron');
    appBrowserHost = new (require('./appBrowser').AppBrowserHost)({
      electron,
      getWindow: () => win,
      screenshotDir: path.join(userDir(), 'browser-shots'),
      openExternal: (url) => shell.openExternal(url),
      onChange: (scope) => { if (win && !win.isDestroyed()) win.webContents.send('appBrowser:changed', { scope }); },
      onReveal: (scope) => { if (win && !win.isDestroyed()) win.webContents.send('appBrowser:reveal', { scope }); },
      beforeLoad: () => syncBraveLogin({ reason: 'open' }),
    });
  }
  return appBrowserHost;
}
// 內建瀏覽器自動沿用使用者 Brave 的登入：啟動時、開網頁前（距上次同步超過 10 分鐘）
// 從開著除錯埠的 Brave 讀 cookie 匯入。手動按鈕（force）才會在 Brave 沒開時用背景方式讀。
const LOGIN_SYNC_EVERY = 10 * 60 * 1000;
const loginSync = { at: 0, running: null, last: null };
function syncBraveLogin({ force = false, reason = '' } = {}) {
  if (!force && (settings.browser || {}).syncBraveLogin === false) return Promise.resolve(loginSync.last);
  if (loginSync.running) return loginSync.running;
  if (!force && loginSync.at && Date.now() - loginSync.at < LOGIN_SYNC_EVERY) return Promise.resolve(loginSync.last);
  loginSync.running = (async () => {
    const braveLogin = require('./braveLogin');
    try {
      const { cookies, via } = await braveLogin.readUserCookies({ bravePath: (settings.browser || {}).path || '', liveOnly: !force });
      const r = await braveLogin.importInto(require('electron').session.fromPartition(require('./appBrowser').PARTITION), cookies);
      loginSync.last = { ok: true, via, ...r, reason, at: new Date().toISOString() };
    } catch (e) {
      loginSync.last = { ok: false, code: e.code || '', message: String(e.message || e), reason, at: new Date().toISOString() };
    }
    loginSync.at = Date.now();
    loginSync.running = null;
    return loginSync.last;
  })();
  return loginSync.running;
}
// 外部 Brave（工作台自己的設定檔）：每段對話各自一個瀏覽情境，開好時把使用者 Brave 的登入 cookie 帶進去。
// 只讀開著除錯埠的 Brave，讀一次快取 10 分鐘。
const braveCookieCache = { at: 0, cookies: null };
async function loginIntoBraveContext(conn, browserContextId) {
  if ((settings.browser || {}).syncBraveLogin === false) return;
  if (!braveCookieCache.cookies || Date.now() - braveCookieCache.at > LOGIN_SYNC_EVERY) {
    const { cookies } = await require('./braveLogin').readUserCookies({ bravePath: (settings.browser || {}).path || '', liveOnly: true });
    braveCookieCache.cookies = cookies; braveCookieCache.at = Date.now();
  }
  const list = braveCookieCache.cookies.map(browserControl.toCookieParam).filter(Boolean);
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    // 一整批裡只要有一個不被接受，整批都會失敗：那就改成一個一個設
    try { await conn.send('Storage.setCookies', { cookies: batch, browserContextId }); }
    catch { for (const c of batch) { try { await conn.send('Storage.setCookies', { cookies: [c], browserContextId }); } catch { /* 跳過這個 */ } } }
  }
}
// 畫面上的對話 key → 瀏覽器分頁群組（chat.id）；Codex 執行緒還沒有 App 紀錄時建立一筆
async function browserScopeForKey(key, create = false) {
  if (!key) return null;
  let { chat, threadId } = await resolveChatRef(String(key));
  if (!chat && create && threadId) {
    chat = { id: newId('cx'), origin: 'codex', title: '', cwd: '', codexThreadId: threadId, messages: [], createdAt: new Date().toISOString(), lastProvider: 'codex' };
    await writeChat(chat, { keepTime: true });
  }
  return chat ? chat.id : null;
}
function braveBrowserForChat(key) {
  const base = browserControllerFor();
  let entry = browserScopes.get(key);
  if (!entry || entry.base !== base) { entry = { base, controller:browserControl.createController({ shared:base.browser }) }; browserScopes.set(key,entry); }
  return entry.controller;
}
const wangpinBrowsers = new Map();
function wangpinBrowserForChat(key, config) {
  const executable = require('./wangpinBrowserPaths').resolveExecutable(config.wangpinPath);
  let entry = wangpinBrowsers.get(executable);
  if (!entry) {
    const hash = crypto.createHash('sha256').update(executable.toLowerCase()).digest('hex').slice(0,12);
    const browser = new (require('./firefoxControl').FirefoxBrowser)({ executable, reuseProfile:!smokeData, profileDir:smokeData ? path.join(userDir(),'wangpin-firefox',hash) : require('./firefoxAttach').defaultProfile(executable), screenshotDir:path.join(userDir(),'browser-shots'), headless:!!smokeData });
    entry={browser,scopes:new Map()};wangpinBrowsers.set(executable,entry);
  }
  if (!entry.scopes.has(key)) entry.scopes.set(key,entry.browser.controller());
  return entry.scopes.get(key);
}
let browserChoiceManager = null;
function conversationBrowsers() {
  if(!browserChoiceManager)browserChoiceManager=require('./browserChoice').create({
    directory:path.join(userDir(),'browser-selection'),enabled:()=>settings.browser?.enabled!==false,
    inventory:()=>require('./browserChoice').discover({wangpinPath:settings.browser?.wangpinPath || ''}),
    createController:(item,scope)=>{
      if(item.id==='app')return {...appBrowser().controller(scope),stop:async()=>({stopped:true})};
      if(item.id==='wangpin')return {...wangpinBrowserForChat(scope,settings.browser || {}),stop:async()=>({stopped:true})};
      const hash=crypto.createHash('sha256').update(scope).digest('hex').slice(0,20);
      const profileDir=path.join(userDir(),'managed-browsers',item.id,hash);
      const screenshotDir=path.join(userDir(),'browser-shots');
      if(item.id==='firefox')return new(require('./firefoxControl').FirefoxBrowser)({executable:item.executable,profileDir,screenshotDir,reuseProfile:false,headless:!!smokeData}).controller();
      return browserControl.createController({bravePath:item.executable,strictExecutable:true,profileDir,stateFile:path.join(profileDir,'browser-state.json'),screenshotDir,userProfile:false,background:false,headless:!!smokeData,verifyEndpoint:require('./webTabCleanup').verifyReuse});
    }
  });
  return browserChoiceManager;
}
function browsersForChat(key, config = settings.browser || {}) {
  const active = browserPolicy.availability(config);
  if(active.conversation){const canonical=String(key).split(':web:')[0];return{browser:conversationBrowsers().forChat(canonical,String(key)),braveBrowser:null,app:null,brave:null,active};}
  if (active.wangpin) return { browser:wangpinBrowserForChat(key,config), braveBrowser:null, app:null, brave:null, active };
  const app = active.app ? appBrowser().controller(key) : null;
  const brave = active.brave ? braveBrowserForChat(key) : null;
  // 相容既有 browser_*：兩者都開時預設控制內建瀏覽器；只有 Brave 時 browser_* 就控制 Brave。
  return { browser: app || brave, braveBrowser: app && brave ? brave : null, app, brave, active };
}
function browserForChat(key) { return browsersForChat(key).browser; }
let desktopImport = null;
async function ensureClaudeConfig(cfg) {
  return cfg.configDir || path.join(userDir(), 'claude-desktop-profile');
}

const APP_TITLE = '王品工作台 開源版';
const APP_VERSION = require('../package.json').version;
const SHORTCUT_NAME = '王品工作台 開源版';
// Isolated packaged-app smoke checks never read or mutate the normal user profile.
const smokeData = process.env.CODEX_MULTI_SMOKE_DATA;
if (!smokeData) app.setPath('userData', path.join(app.getPath('appData'), 'Wangpin Workbench Open Source'));
if (smokeData) app.setPath('userData', path.resolve(smokeData));
fs.mkdirSync(path.join(app.getPath('userData'), 'session'), {recursive:true});
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));
let portableMode = null;
try { portableMode = require('./portableMode').configure(app, { smokeData }); }
catch (error) { dialog.showErrorBox('Portable 啟動失敗', String(error.message || error)); process.exit(1); }
const failureDiagnostics = require('./failureDiagnostics').create({directory:()=>app.getPath('userData'),version:APP_VERSION,metrics:()=>app.getAppMetrics()});
app.on('child-process-gone', (_event, details) => failureDiagnostics.record('child-process',details));
// Monitor the fault, retaining Node's default fatal termination.
process.on('uncaughtExceptionMonitor', (error, origin) => failureDiagnostics.record('main-fatal',{code:error.code,reason:origin}));

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('tw.wangpin.workbench.opensource');
nativeTheme.themeSource = 'dark';

let win = null;
function assertGptSender(event) {
  if (!win || event.sender !== win.webContents) throw new Error('Unauthorized ChatGPT view caller');
}
const running = new Map(); // reqId -> { cancel }

// ---------------- 跨模型子 agent ----------------
const claudeLevel = (perm) => ({ chat: 'chat', plan: 'read-only', bypassPermissions: 'danger-full-access' }[perm] || 'workspace-write');
// Codex 的 Auto-review 實際跑在工作區寫入沙盒；子 agent、瀏覽器與刪除保護都照工作區寫入處理
const codexLevel = (sandbox) => (!sandbox || sandbox === 'auto-review' ? 'workspace-write' : sandbox);
function defaultLevel(provider) {
  const c = settings.providers[provider] || {};
  if (provider === 'codex') return codexLevel(c.sandbox);
  if (provider === 'claude') return c.via === 'api' ? (c.apiPermission || 'chat') : claudeLevel(c.permission);
  return c.permission || 'chat';
}
function providerProblem(provider) {
  const c = settings.providers[provider] || {};
  if (provider === 'codex' || (provider === 'gpt' && c.via !== 'api') || (provider === 'claude' && c.via !== 'api')) return null;
  return activeKey(provider) ? null : `還沒有 ${providers.PROVIDERS[provider].label} 的 API 金鑰，無法建立這個子 agent。請到「API 設定」新增，或改用其他模型。`;
}
const agents = agentKit.createAgentManager({
  run: (req, sink) => handleSend(sink, req),
  cancelRun: (reqId) => { const r = running.get(reqId); if (r) r.cancel(); },
  readChat, writeChat, readAllChats, listChatMetadata: () => sidebarMetadata.list(), newId,
  settings: () => settings,
  checkProvider: providerProblem,
  forward: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('stream', ev); },
  notify: (parentKey) => { if (win && !win.isDestroyed()) win.webContents.send('agents:changed', { parentKey }); },
});

// ---------------- 設定 ----------------
const userDir = () => app.getPath('userData');
let gptAccountManager;
let gptLoginController = null;
let gptLoginAccountId = null;
function gptAccountStore() {
  if (!gptAccountManager) gptAccountManager = require('./gptWebAccounts').create({
    directory: userDir(),
    login: async opts => {
      if(settings.webWebsiteHttpOnly!==true)return require('./chatgptWeb').login({ ...opts, bravePath: settings.browser?.path || '' });
      const result=await loginWebsiteHttp('gpt',opts);
      if(result.ok)await fs.promises.writeFile(path.join(opts.profileDir,'chatgpt-login.json'),JSON.stringify({transport:'site-http'}));
      return result;
    },
    isBusy: (dir, id) => require('./chatgptWeb').isProfileBusy(dir) || [...running.values()].some(t => !t.finished && t.gptWebAccountId === id),
    closeProfile: async (dir,id) => {await require('./chatgptWeb').closeProfile(dir);await websiteHttpSessions().clearSession({site:'gpt',accountId:id});},
  });
  return gptAccountManager;
}
function syncGptAccountSelection(data) {
  const cfg = settings.providers.gpt;
  if ((cfg.webAccountId || null) !== data.activeId) {
    cfg.webAccountId = data.activeId;
    cfg.webModels = []; cfg.webModelsAt = ''; cfg.webEfforts = []; cfg.webEffortModel = '';
    saveSettings();
  }
  return data;
}
const settingsFile = () => path.join(userDir(), 'settings.json');
const chatsDir = () => path.join(userDir(), 'chats');

const DEFAULT_SETTINGS = {
  webWebsiteHttpOnly: false,
  webBrowserModeRestored: true,
  webHideWindow: true,
  providers: {
    codex: { path: '', model: '', sandbox: 'workspace-write', effort: 'default' },
    gpt: { keys: [], activeKeyId: null, via: 'web', webModel: '', webAgent: false, model: providers.PROVIDERS.gpt.defaultModel, reasoningEffort: 'default', permission: 'chat', approval: 'on-request' },
    deepseek: { keys: [], activeKeyId: null, model: providers.PROVIDERS.deepseek.defaultModel, thinking: 'default', permission: 'chat', approval: 'on-request', maxTokens: 64000 },
    gemini: { keys: [], activeKeyId: null, model: providers.PROVIDERS.gemini.defaultModel, reasoningEffort: 'default', permission: 'chat', approval: 'on-request', maxTokens: 0 },
    meta: { keys: [], activeKeyId: null, model: providers.PROVIDERS.meta.defaultModel, reasoningEffort: 'default', permission: 'chat', approval: 'on-request', maxTokens: 0 },
    grok: { keys: [], activeKeyId: null, model: providers.PROVIDERS.grok.defaultModel, reasoningEffort: 'default', permission: 'chat', approval: 'on-request', maxTokens: 0 },
    ablit: { keys: [], activeKeyId: null, model: providers.PROVIDERS.ablit.defaultModel, permission: 'chat', approval: 'on-request', maxTokens: 0 },
    // model 留空＝用 LM Studio 目前載入的模型
    lmstudio: { keys: [], activeKeyId: null, model: '', permission: 'chat', approval: 'on-request', maxTokens: 0 },
    claude: { keys: [], activeKeyId: null, via: 'claudecode', claudePath: '', configDir: '', permission: 'default', cliModel: '', effort: 'default', model: providers.PROVIDERS.claude.defaultModel, maxTokens: 16000 },
    // Google Antigravity：沿用 Antigravity App 已登入的帳號；model 是模型家族名稱（例如 Claude Opus 5.5），effort 選同家族的推理等級
    antigravity: { model: '', effort: 'default', permission: 'chat' },
    // Grok Bot：routine webhook 送出、ntfy 主題收回覆。webhookKey 跟 API 金鑰一樣用 safeStorage 加密保存
    grokbot: { webhookUrl: '', webhookKey: '', ntfyTopic: grokBotBridgeKit.DEFAULT_TOPIC, ntfyServer: grokBotBridgeKit.DEFAULT_SERVER, allowPublicReplies: false, permission: 'chat' },
    // Grok Build：xAI 官方 grok CLI（grok.com 帳號登入），經 ACP 接入；permission：read-only／ask／full
    grokbuild: { model: '', effort: 'default', permission: 'ask' },
  },
  // profile：isolated＝工作台自己的設定檔；mine＝沿用使用者電腦上 Brave 的登入。background：不搶焦點
  // syncBraveLogin：內建瀏覽器自動沿用使用者 Brave 的登入（啟動時與開網頁前同步 cookie）
  // revealPanel：模型開網頁時自動展開右側的內建瀏覽器面板（預設關：不打斷你正在看的畫面，只在按鈕上亮提示）
  browser: { enabled: true, selectionMode:'conversation', choiceMigration:1, engine: 'brave', appEnabled: false, braveEnabled: true, preferBraveExtension: true, path: '', headless: false, profile: 'isolated', background: true, syncBraveLogin: false, revealPanel: false },
  // 禁止刪除檔案，除非使用者在同意視窗按允許（所有模型通用）
  guard: { noDelete: false },
  agents: { maxConcurrent: 4, maxChildren: 8, modelSpawn: true },
  // 能力擴充：enabled 是全域預設要勾選哪些工具包；config 存每個工具包的路徑等設定；custom 是使用者自己加的 MCP 伺服器
  extensions: { enabled: [], config: {}, custom: [] },
  modelLists: {},
  codexHome: path.join(userDir(), 'codex-home'),
  systemPrompt: '除非使用者另有要求，請使用繁體中文回覆。',
  maxContextChars: 120000,
  lastProvider: 'codex',
  defaultCwd: '',
  showArchived: false,
  showSubagents: false,
  hiddenKeys: [],
  pinOverrides: {},
  sidebarProjects: [],   // 只顯示使用者手動加入的資料夾；空陣列表示側欄尚未載入專案
  sidebarSources: [],    // 使用者明確從「匯入／還原」載入的本機 Codex／Claude Code 專案樹
  sidebarSourceProjects: null, // null 僅供舊版「整個來源已載入」設定遷移；新版逐個專案選取
  sidebarSourceConversations: null, // null 保留舊版整個專案的顯示方式；新版逐則選取
  claudeAccounts: [],    // 各帳號只保存名稱與獨立設定資料夾，不複製登入憑證
  sidebarOrder: [],      // 側欄專案的自訂順序（長按拖曳排出來的），沒列到的排在後面
  threadOrder: [],       // 對話的自訂順序；只在所屬專案內比較，沒列到的照原本的時間排序
  removedProjects: [],   // 使用者從側欄移除的專案資料夾：不再列在側欄與「載入專案」清單，對話本身不動
  collapsedGroups: [],
  bounds: null,
  shortcutCreated: false,
};

let settings = null;

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function encryptKey(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decryptKey(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch { return ''; }
  return stored;
}

function loadSettings() {
  let raw = null;
  try {
    raw = require('./settingsStore').read(settingsFile()).value;
    settings = deepMerge(DEFAULT_SETTINGS, raw);
  } catch (error) {
    dialog.showErrorBox('設定檔無法讀取', '設定檔及備份無法讀取。原始資料已保留，請勿刪除資料夾；請聯絡維護者協助恢復。');
    throw error;
  }
  let migrated = false;
  if(raw?.browser?.choiceMigration!==1){settings.browser.selectionMode='conversation';settings.browser.choiceMigration=1;migrated=true;}
  if(settings.browser?.wangpinPath){
    const executable=require('./wangpinBrowserPaths').resolveExecutable(settings.browser.wangpinPath);
    if(executable!==settings.browser.wangpinPath){settings.browser.wangpinPath=executable;migrated=true;}
  }
  // User-requested browser rollback, including previously saved HTTP choices.
  if(settings.webWebsiteHttpOnly!==false || settings.webBrowserModeRestored!==true){
    settings.webWebsiteHttpOnly=false;settings.webBrowserModeRestored=true;migrated=true;
  }
  if(settings.providers.gpt.webEnsemble){
    const cfg=settings.providers.gpt.webEnsemble;
    if(['gpt','claude','gemini'].some(site=>cfg.connections?.[site]!=='account')){
      cfg.connections={gpt:'account',claude:'account',gemini:'account'};migrated=true;
    }
  }
  settings.extensions ||= {enabled:[],config:{},custom:[]};
  if (!settings.extensions.externalSkills) {
    settings.extensions.externalSkills = true;
    settings.extensions.loadedBuiltins = [];
    migrated = true;
  }
  if (raw && raw.browser && !Object.prototype.hasOwnProperty.call(raw.browser, 'appEnabled') && !Object.prototype.hasOwnProperty.call(raw.browser, 'braveEnabled')) {
    settings.browser = deepMerge(settings.browser, browserPolicy.migrateLegacy(raw.browser));
    migrated = true;
  }
  // 1.9.24 起側欄永遠採手動清單，不再提供「顯示全部專案」。舊版的 null 只保留當時正在使用的資料夾。
  if (!raw || !Array.isArray(raw.sidebarProjects)) {
    settings.sidebarProjects = settings.defaultCwd ? [normDir(settings.defaultCwd)] : [];
    migrated = true;
  }
  if (!raw || (!Object.prototype.hasOwnProperty.call(raw, 'sidebarSourceProjects') && !(raw.sidebarSources || []).length)) {
    settings.sidebarSourceProjects = { codex: [], claude: [] };
    migrated = true;
  }
  if (!raw || (!Object.prototype.hasOwnProperty.call(raw, 'sidebarSourceConversations') && !(raw.sidebarSources || []).length)) {
    settings.sidebarSourceConversations = { codex: [], claude: [] };
    migrated = true;
  }
  for (const p of API_PROVIDERS) {
    const c = settings.providers[p];
    if (!Array.isArray(c.keys)) { c.keys = []; migrated = true; }
    if (c.apiKey) {
      const id = newId('key');
      c.keys.push({ id, name: `${providers.PROVIDERS[p].label} 金鑰`, apiKey: c.apiKey, baseUrl: sanitizeBaseUrl(p, c.baseUrl || '') });
      if (!c.activeKeyId) c.activeKeyId = id;
      migrated = true;
    }
    if ('apiKey' in c || 'baseUrl' in c) { delete c.apiKey; delete c.baseUrl; migrated = true; }
    if (c.keys.length && !c.keys.some((k) => k.id === c.activeKeyId)) { c.activeKeyId = c.keys[0].id; migrated = true; }
  }
  // 1.9.14：使用者要求 GPT 改成 ChatGPT 網頁版（只切一次；之後想換回 Codex 帳號或 API 金鑰都會被保留）
  if (!settings.gptWebMigrated) { settings.gptWebMigrated = true; settings.providers.gpt.via = 'web'; migrated = true; }
  // The old API slug list did not match the current ChatGPT web picker.
  if (!settings.gptWebPickerMigrated) {
    settings.gptWebPickerMigrated = true;
    settings.providers.gpt.webModel = '';
    settings.providers.gpt.webModels = [];
    migrated = true;
  }
  if (settings.gptWebPickerVersion !== 2) {
    settings.gptWebPickerVersion = 2;
    settings.providers.gpt.webModels = [];
    settings.providers.gpt.webModel = '';
    settings.providers.gpt.webPickerVersion = 2;
    settings.providers.gpt.webEffort = 'default';
    if (settings.providers.gpt.via === 'codex') settings.providers.gpt.via = 'web';
    migrated = true;
  }
  // 1.9.37 用連結開啟「子代理」執行緒時會把整個「顯示子代理」打開，讓一整批子代理對話跑進側欄；修正一次
  if (!settings.linkSubagentFix1938) {
    settings.linkSubagentFix1938 = true;
    if (settings.showSubagents) {
      try {
        const linked = fs.readdirSync(chatsDir()).filter((f) => /^cx_.*\.json$/.test(f)).some((f) => {
          try { const c = JSON.parse(fs.readFileSync(path.join(chatsDir(), f), 'utf8')); return c.origin === 'codex' && c.sidebarProjectAssigned; } catch { return false; }
        });
        if (linked) settings.showSubagents = false;
      } catch { /* 還沒有對話資料夾 */ }
    }
    migrated = true;
  }
  if (migrated) saveSettings();
  return settings;
}
function saveSettings() {
  require('./settingsStore').write(settingsFile(), settings);
}
const API_PROVIDERS = ['gpt', 'claude', 'deepseek', 'gemini', 'grok', 'meta', 'ablit', 'lmstudio'];
const normDir = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
function showProjectInSidebar(dir) {
  const n = normDir(dir);
  const removed = settings.removedProjects || [];
  settings.removedProjects = removed.filter(d => normDir(d) !== n);
  if (Array.isArray(settings.sidebarProjects) && !settings.sidebarProjects.includes(n)) settings.sidebarProjects = [...settings.sidebarProjects, n];
  saveSettings();
}
let codexAccounts = null;
const accountStore = () => codexAccounts || (codexAccounts = codexAccountsKit.createStore({ dir: path.join(userDir(), 'codex-accounts'), encrypt: encryptKey, decrypt: decryptKey }));
let codexAccountChanges = 0;

// ---------------- Brave 瀏覽器（API 模型的瀏覽器工具） ----------------
// 用 CDP 控制真正的 Brave：使用者看得到視窗，模型可以真的點擊與輸入。
let browserController = null;
let browserKey = '';
let bravePrerequisites = null;
function prepareBrave(reason = '') {
  if (!bravePrerequisites) bravePrerequisites = require('./browserPrerequisites').create({
    detect: selected => browserControl.findBrave(selected),
    showMessageBox: opts => dialog.showMessageBox(win, opts),
    showOpenDialog: opts => dialog.showOpenDialog(win, opts),
    openDownload: url => shell.openExternal(url),
    savePath: selected => { settings.browser = {...settings.browser,path:selected}; saveSettings(); }
  });
  return bravePrerequisites.ensure({path:settings.browser?.path || '',reason});
}
async function requireBrave(reason = '') {
  const prepared = await prepareBrave(reason);
  if (!prepared.ready) throw Error('Brave 尚未安裝或指定；請完成 Brave 安裝指引後再使用外部瀏覽器。');
  return prepared.path;
}
async function openVisibleBrave(url, signal) {
  if (signal?.aborted) throw Error('已停止');
  const bravePath = await requireBrave('這次操作需要在 Brave 開啟分頁。');
  if (signal?.aborted) throw Error('已停止');
  return require('./braveVisible').open(url,{bravePath});
}

function browserControllerFor() {
  const cfg = settings.browser || {};
  const key = JSON.stringify([cfg.enabled, cfg.path || '', !!cfg.headless, cfg.profile === 'mine', cfg.background !== false]);
  if (!browserController || browserKey !== key) {
    if (browserController) { const old = browserController; old.stop().catch(() => { /* 已經關閉 */ }); }
    browserController = browserControl.createController({
      bravePath: cfg.path || '',
      profileDir: path.join(userDir(), 'browser-profile'),
      stateFile: path.join(userDir(), 'browser-state.json'),
      screenshotDir: path.join(userDir(), 'browser-shots'),
      headless: !!cfg.headless,
      userProfile: cfg.profile === 'mine',
      background: cfg.background !== false,
      prepareContext: loginIntoBraveContext,
      extraArgs: String(process.env.CODEX_MULTI_BROWSER_ARGS || '').split(' ').filter(Boolean),
      log: (message) => { if (process.env.CODEX_MULTI_DEBUG) console.log('[brave]', message); },
    });
    browserKey = key;
  }
  return browserController;
}

function browserEnabled() {
  const active = browserPolicy.availability(settings.browser || {});
  return active.app || active.brave;
}

// 使用者同意視窗：主行程問、renderer 顯示，答案再送回來
const pendingApprovals = new Map();
function resolveApproval(id, decision) {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  pendingApprovals.delete(id);
  pending(decision === 'always' ? { ok: true, always: true } : { ok: decision === 'allow' });
  return true;
}

function askApproval(emit, { kind, detail, cwd, signal, allowAlways = true }) {
  const id = newId('ap');
  return new Promise((resolve) => {
    let timer;
    const finish = answer => {
      clearTimeout(timer); pendingApprovals.delete(id);
      signal?.removeEventListener('abort', abort);
      resolve(answer);
    };
    const abort = () => finish({ ok: false, cancelled: true });
    if (signal?.aborted) return abort();
    timer = setTimeout(() => finish({ ok: false, timeout: true }), 120000);
    pendingApprovals.set(id, finish);
    signal?.addEventListener('abort', abort, { once: true });
    emit('approval', { id, kind, detail, cwd: cwd || '', allowAlways });
  });
}

// 常見的「貼錯網址」：官網後台或文件頁不是 API，會導致 403 網頁錯誤
const NOT_API_HOSTS = /^(platform\.openai\.com|chatgpt\.com|chat\.openai\.com|platform\.deepseek\.com|chat\.deepseek\.com|api-docs\.deepseek\.com|www\.deepseek\.com|deepseek\.com|console\.anthropic\.com|platform\.claude\.com|claude\.ai|docs\.anthropic\.com|aistudio\.google\.com|ai\.google\.dev|console\.cloud\.google\.com)$/i;

/** a 比 b 新（只比 x.y.z 三段數字） */
function newerVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function sanitizeBaseUrl(provider, raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = (provider === 'lmstudio' ? 'http://' : 'https://') + u;
  let parsed;
  try { parsed = new URL(u); } catch { return ''; }
  if (NOT_API_HOSTS.test(parsed.hostname)) return '';
  u = u.replace(/\/+$/, '');
  if (provider === 'claude') u = u.replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '');
  else u = u.replace(/\/chat\/completions$/i, '');
  // LM Studio 使用者常只填「localhost:1234」，補上 /v1
  if (provider === 'lmstudio' && !/\/v1$/i.test(u) && new URL(u).pathname.replace(/\/+$/, '') === '') u += '/v1';
  return u;
}

function activeKey(p) {
  const c = settings.providers[p] || {};
  const keys = c.keys || [];
  return keys.find((k) => k.id === c.activeKeyId) || keys[0] || null;
}
// ---------------- 側欄管理資料夾（App側欄／不在App側欄的對話） ----------------
let sidebarMirrorInst = null;
let sidebarMirrorWatch = null;
const sidebarMirror = () => sidebarMirrorInst || (sidebarMirrorInst = sidebarMirrorKit.create({ root: path.join(userDir(), '側欄管理') }));
async function applySidebarMirror(payload = {}) {
  const m = sidebarMirror();
  if (!sidebarMirrorWatch) sidebarMirrorWatch = m.watch(() => { if (win && !win.isDestroyed()) win.webContents.send('sidebar:mirrorChanged'); });
  const r = await m.sync({ shown: Array.isArray(payload.shown) ? payload.shown : [], others: Array.isArray(payload.others) ? payload.others : [] });
  if (!r.changed) return r;
  const { removedKeys, removedFolders, placed } = r.diff;
  const hidden = new Set(settings.hiddenKeys || []);
  const threadOf = async (key) => {
    if (key.startsWith('codex:')) return key.slice(6).toLowerCase();
    if (!key.startsWith('app:')) return null;
    const { chat } = await resolveChatRef(key);
    return chat && chat.codexThreadId ? chat.codexThreadId.toLowerCase() : null;
  };
  // 刪掉捷徑＝從側欄移除（跟右鍵「從側欄移除」一樣只隱藏，對話紀錄不動）
  for (const key of removedKeys) {
    hidden.add(key);
    const tid = await threadOf(key);
    if (tid) hidden.add(`codex:${tid}`);
  }
  const removedDirs = new Set(removedFolders.map(normDir));
  if (removedDirs.size) {
    settings.removedProjects = [...new Set([...(settings.removedProjects || []), ...removedDirs])];
    if (Array.isArray(settings.sidebarProjects)) settings.sidebarProjects = settings.sidebarProjects.filter((d) => !removedDirs.has(normDir(d)));
    settings.sidebarOrder = (settings.sidebarOrder || []).filter((d) => !removedDirs.has(normDir(d)));
  }
  let moved = 0;
  let skipped = 0;
  for (const { key, dir } of placed) {
    if (!/^(app|codex):/.test(key) || [...running.values()].some((x) => x.key === key)) { skipped++; continue; }
    try {
      await moveChatTo(key, dir);
      hidden.delete(key);
      const tid = await threadOf(key);
      if (tid) hidden.delete(`codex:${tid}`);
      moved++;
    } catch { skipped++; }
  }
  settings.hiddenKeys = [...hidden];
  saveSettings();
  return { changed: true, removed: removedKeys.length, removedProjects: removedDirs.size, placed: moved, skipped };
}
function providerCfg(p, keyId) {
  const c = settings.providers[p] || {};
  const k = keyId ? (c.keys || []).find((x) => x.id === keyId) : activeKey(p);
  // LM Studio 預設不驗證金鑰，沒設定時也能直接連本機伺服器
  const apiKey = k && k.apiKey ? decryptKey(k.apiKey) : '';
  return { ...c, keys: undefined, apiKey: apiKey || (p === 'lmstudio' ? 'lm-studio' : ''), baseUrl: k ? k.baseUrl : '', keyName: k ? k.name : '' };
}
/** 能力擴充（例如 Prime Agent）會用環境變數取得金鑰，這裡把 app 已存的金鑰解開給它。 */
function extensionApiKeys() {
  const out = {};
  for (const p of API_PROVIDERS) {
    if (p === 'lmstudio') continue;  // 本機伺服器，沒有要交給外部代理的金鑰
    try { const k = providerCfg(p).apiKey; if (k) out[p] = k; } catch { /* 沒有金鑰就略過 */ }
  }
  return out;
}
// Grok Bot 設定：解密後的完整設定只留在主程序；畫面只拿到網址、主題與金鑰末四碼
function grokBotConfig(source = settings) {
  const c = source.providers?.grokbot || {};
  return {...grokBotBridgeKit.normalizeConfig({ webhookUrl: c.webhookUrl, webhookKey: decryptKey(c.webhookKey || ''), ntfyTopic: c.ntfyTopic, ntfyServer: c.ntfyServer, allowPublicReplies: c.allowPublicReplies }), sendWorkspace:c.sendWorkspace===true};
}
function grokBotPublic() {
  const c = grokBotConfig();
  return { webhookUrl: c.webhookUrl, ntfyTopic: c.ntfyTopic, ntfyServer: c.ntfyServer, allowPublicReplies: c.allowPublicReplies, sendWorkspace:c.sendWorkspace, permission: 'chat', keySaved: !!c.webhookKey, keyHint: c.webhookKey ? `…${c.webhookKey.slice(-4)}` : '', hasKey: !!(c.webhookUrl && c.webhookKey && c.ntfyTopic) };
}
let grokBotBridgeInst = null;
const grokBotBridge = () => grokBotBridgeInst || (grokBotBridgeInst = grokBotBridgeKit.create({ log: (...a) => console.warn('[Grok Bot]', ...a) }));
function publicSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  for (const p of API_PROVIDERS) {
    const c = settings.providers[p];
    s.providers[p].keys = (c.keys || []).map((k) => {
      const key = decryptKey(k.apiKey);
      return { id: k.id, name: k.name, hint: key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '（無法讀取，請重新貼上）', baseUrl: k.baseUrl || '', lastTest: k.lastTest || null };
    });
    const ak = activeKey(p);
    s.providers[p].activeKeyId = ak ? ak.id : null;
    s.providers[p].hasKey = !!ak || p === 'lmstudio';
    if (p === 'gpt') s.providers.gpt.via = ['api', 'web'].includes(settings.providers.gpt.via) ? settings.providers.gpt.via : 'codex';
    if (p === 'claude') s.providers.claude.via = settings.providers.claude.via === 'api' ? 'api' : 'claudecode';
  }
  s.providers.grokbot = grokBotPublic();
  s.appVersion = APP_VERSION;
  s.catalog = Object.fromEntries(Object.entries(providers.PROVIDERS).map(([k, v]) => [k, { label: v.label, models: v.models, defaultBase: v.defaultBase }]));
  delete s.bounds;
  return s;
}

// ---------------- 對話儲存（本 App 自己的資料） ----------------
function chatPath(id) { return path.join(chatsDir(), `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`); }
let antigravityAccountChanging = false;
let antigravityAccountStore = null;
function antigravityAccounts() {
  if (!antigravityAccountStore) {
    antigravityAccountStore = require('./antigravityAccounts').create({
      directory: path.join(userDir(), 'antigravity-accounts'),
      verifySignedIn: () => new Promise(resolve => {
        const exe = antigravity.cliPath();
        if (!exe) return resolve(false);
        require('node:child_process').execFile(exe, ['models'], { windowsHide: true, timeout: 30000 }, error => resolve(!error));
      })
    });
  }
  return antigravityAccountStore;
}
const chatWrites = new Map();
const sidebarMetadata = require('./chatMetadata').create({directory:chatsDir,indexPath:()=>path.join(userDir(),'sidebar-metadata.json')});
function queueChatWrite(id, work) {
  const previous = chatWrites.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  chatWrites.set(id, next);
  next.finally(() => { if (chatWrites.get(id) === next) chatWrites.delete(id); }).catch(() => {});
  return next;
}
const chatReader = require('./chatReadCache').create();
async function readAllChats() {
  await fsp.mkdir(chatsDir(), { recursive: true });
  const files = (await fsp.readdir(chatsDir())).filter((f) => f.endsWith('.json'));
  const chats = [];
  for (const f of files) {
    try { chats.push(require('./chatTitles').apply(JSON.parse(await require('./budgetedRead').readText(path.join(chatsDir(), f))), settings.sidebarTitleOverrides)); } catch { /* 忽略壞檔 */ }
  }
  return chats;
}
async function readChat(id) {
  try { return require('./chatTitles').apply(await chatReader.read(chatPath(id)), settings.sidebarTitleOverrides); } catch { return null; }
}
async function writeChat(chat, { keepTime = false } = {}) {
  if(deletedChatIds.has(chat.id))throw Error('這段對話已刪除，拒絕稍晚完成的寫入');
  return queueChatWrite(chat.id, async () => {
    return persistChat(chat, { keepTime });
  });
}
async function persistChat(chat, { keepTime = false } = {}) {
  await fsp.mkdir(chatsDir(), { recursive: true });
  require('./chatTitles').apply(chat, settings.sidebarTitleOverrides);
  // 使用者在回合進行中才改的設定（擴充勾選等）以最新的為準；回合手上是開始時的舊副本，不能整份蓋回去
  require('./chatLive').apply(chat);
  if (!keepTime || !chat.updatedAt) chat.updatedAt = new Date().toISOString();
  const tmp = chatPath(chat.id) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(chat, null, 1), 'utf8');
  await require('./atomicRename').replace(tmp, chatPath(chat.id));
  chatReader.forget(chatPath(chat.id));
  sidebarMetadata.invalidate(chat.id);
}
async function findChatByThread(threadId) {
  if (!threadId) return null;
  const chats = await sidebarMetadata.list();
  const t = threadId.toLowerCase();
  const row=chats.find((c) => (c.codexThreadId && c.codexThreadId.toLowerCase() === t) || (c.codexActiveThreadId && c.codexActiveThreadId.toLowerCase() === t));
  return row ? readChat(row.id) : null;
}
function newId(prefix) { return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }

let lastCodexList = null;
let lastClaudeRateLimit = null;
let claudeModelsCache = null;
let claudeIdentity = 0;
let claudeAccountManager = null;
function clearClaudeCaches() { claudeIdentity++; claudeModelsCache = null; lastClaudeRateLimit = null; }
function claudeAccountStore() {
  if (!claudeAccountManager) claudeAccountManager = require('./claudeAccounts').createStore({
    getSettings: () => settings, saveSettings, userDir: userDir(), cli: claudeCode,
    runningProfiles: () => [...running.values()].map(task => task.claudeConfigDir).filter(Boolean), onChange: clearClaudeCaches,
  });
  return claudeAccountManager;
}
function sourceProjectKey(source, item) {
  return normDir(item.cwd || (source === 'claude' ? item.projectDir : '') || item.projectId || '') || 'none';
}

async function sourceRecords(source) {
  if (!['codex', 'claude'].includes(source)) throw new Error('未知的對話來源');
  if (source === 'claude') return (await localClaudeHistory(true)).sessions;
  const linked = new Set((await sidebarMetadata.list()).filter((c) => c.origin !== 'codex')
    .flatMap((c) => [c.codexThreadId, c.codexActiveThreadId].filter(Boolean).map((id) => id.toLowerCase())));
  return (await codexStore.listThreads({ codexHome: settings.codexHome })).threads
    .filter((t) => !t.missing && !t.empty && !t.subagent && !linked.has(t.id) &&
      (settings.showArchived || (!t.archived && !(settings.hiddenKeys || []).includes(`codex:${t.id}`))));
}

async function sourceProjectCandidates(source) {
  const records = await sourceRecords(source);
  const projects = new Map();
  for (const record of records) {
    const key = sourceProjectKey(source, record);
    const root = record.cwd || (source === 'claude' ? record.projectDir : '') || '';
    if (!projects.has(key)) projects.set(key, { key, name: path.win32.basename(root) || root || '未指定資料夾', path: root, count: 0, examples: [] });
    const project = projects.get(key);
    project.count++;
    if (project.examples.length < 2 && record.title) project.examples.push(record.title);
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

async function sourceConversationCandidates(source, projectKey) {
  if (typeof projectKey !== 'string' || !projectKey) throw new Error('請先選擇本機專案');
  const records = await sourceRecords(source);
  return records.filter((r) => sourceProjectKey(source, r) === projectKey).map((r) => ({
    key: source === 'claude' ? `localclaude:${r.id}` : `codex:${r.id}`,
    projectKey,
    title: r.title || '未命名對話',
    updatedAt: r.updatedAt || 0,
  })).sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh-Hant'));
}

async function materializeSourceProjects() {
  if (settings.sidebarSourceProjects && typeof settings.sidebarSourceProjects === 'object') return;
  const selected = { codex: [], claude: [] };
  for (const source of settings.sidebarSources || []) {
    if (['codex', 'claude'].includes(source)) selected[source] = (await sourceProjectCandidates(source)).map((p) => p.key);
  }
  settings.sidebarSourceProjects = selected;
}
async function materializeSourceConversations() {
  if (settings.sidebarSourceConversations && typeof settings.sidebarSourceConversations === 'object') return;
  const selected = { codex: [], claude: [] };
  const sidebar = await buildSidebar();
  for (const item of sidebar.items) {
    const source = item.source;
    if (!['codex', 'claude'].includes(source) || !(settings.sidebarSources || []).includes(source)) continue;
    if (settings.sidebarSourceProjects && !(settings.sidebarSourceProjects[source] || []).includes(item.sourceProjectKey)) continue;
    if (item.sourceConversationKey) selected[source].push(item.sourceConversationKey);
  }
  settings.sidebarSourceConversations = {
    codex: [...new Set(selected.codex)],
    claude: [...new Set(selected.claude)],
  };
}

async function buildSidebar() {
  const [codex, chats] = await Promise.all([
    codexStore.listThreads({ codexHome: settings.codexHome }).catch((e) => ({ available: false, threads: [], projects: [], error: String(e.message) })),
    sidebarMetadata.list().then(rows=>rows.map(row=>require('./chatTitles').apply(row,settings.sidebarTitleOverrides))),
  ]);
  lastCodexList = codex;
  const threadMap = new Map(codex.threads.map((t) => [t.id, t]));
  const items = [];
  const linked = new Set();

  for (const c of chats) {
    const tid = c.codexThreadId ? c.codexThreadId.toLowerCase() : null;
    const aid = c.codexActiveThreadId ? c.codexActiveThreadId.toLowerCase() : null;
    const t = tid ? threadMap.get(tid) : null;
    const at = aid ? threadMap.get(aid) : null;
    if (tid) linked.add(tid);
    if (aid) linked.add(aid);
    const updated = Math.max(Date.parse(c.updatedAt) || 0, t ? t.updatedAt : 0, at ? at.updatedAt : 0);
    const created = (c.origin === 'codex' && t && t.createdAt) || Date.parse(c.createdAt) || (t && t.createdAt) || updated;
    items.push({
      key: c.origin === 'codex' && tid ? `codex:${tid}` : `app:${c.id}`,
      kind: c.origin === 'codex' ? 'codex' : 'app',
      chatId: c.id,
      threadId: tid,
      title: c.title || (t && t.title) || '新對話',
      // Claude Code 紀錄載入後仍顯示在原本的專案下；執行用 cwd 仍為空，不能默許操作原資料夾。
      originalProject: c.originalProject ?? null,
      cwd: c.sidebarProjectAssigned ? (c.cwd || '') : (c.cwd || (c.localSource?.provider === 'claude' ? (c.importedCwd || c.localSource.projectDir) : '') || (t && t.cwd) || ''),
      projectId: c.originalProject == null && !c.sidebarProjectAssigned && c.origin === 'codex' && t && (!c.cwd || normDir(c.cwd) === normDir(t.cwd)) ? t.projectId : null,
      updatedAt: updated,
      // 使用者親自用連結／工作 ID 放進專案的對話：就算在 Codex 是封存或子代理，也只顯示這一則
      archived: c.sidebarProjectAssigned ? false : (t ? t.archived : false),
      pinned: t ? t.pinned : !!c.pinned,
      subagent: c.sidebarProjectAssigned ? false : (t ? t.subagent : false),
      empty: false,
      createdAt: created,
      lastProvider: c.lastProvider || null,
      source: c.sidebarProjectAssigned ? 'app' : (c.localSource?.provider || (c.origin === 'codex' ? 'codex' : 'app')),
      sourceProjectKey: c.localSource?.provider ? sourceProjectKey(c.localSource.provider, { cwd: c.importedCwd || c.cwd, projectDir: c.localSource.projectDir }) : (c.origin === 'codex' ? sourceProjectKey('codex', t || c) : ''),
      sourceConversationKey: c.localSource?.provider === 'claude' ? `localclaude:${c.localSource.id}` : (c.origin === 'codex' ? (tid ? `codex:${tid}` : `app:${c.id}`) : ''),
      parentKey: c.agent?.parentKey || null,
      agent: c.agent ? { name: c.agent.name, provider: c.agent.provider, status: agents.live.get(c.id)?.status || (['queued', 'running'].includes(c.agent.status) ? 'interrupted' : c.agent.status) } : null,
    });
  }
  for (const t of codex.threads) {
    if (linked.has(t.id)) continue;
    items.push({
      key: `codex:${t.id}`,
      kind: 'codex',
      source: 'codex',
      sourceProjectKey: sourceProjectKey('codex', t),
      sourceConversationKey: `codex:${t.id}`,
      chatId: null,
      threadId: t.id,
      title: settings.sidebarTitleOverrides?.[`codex:${t.id.toLowerCase()}`]?.title || t.title || '（未命名的 Codex 執行緒）',
      cwd: t.cwd,
      projectId: t.projectId,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt || t.updatedAt,
      archived: t.archived,
      pinned: t.pinned,
      subagent: t.subagent,
      empty: t.empty,
      lastProvider: 'codex',
    });
  }
  if ((settings.sidebarSources || []).includes('claude')) {
    const imported = new Set(chats.map(c => c.localSource?.id).filter(Boolean));
    const history = await localClaudeHistory();
    for (const s of history.sessions) {
      if (imported.has(s.id)) continue;
      items.push({ key: `localclaude:${s.id}`, kind: 'claude', source: 'claude', sourceProjectKey: sourceProjectKey('claude', s), sourceConversationKey: `localclaude:${s.id}`, title: s.title, cwd: s.cwd || s.projectDir, updatedAt: s.updatedAt, createdAt: s.updatedAt, lastProvider: 'claude' });
    }
  }
  const hidden = new Set(settings.hiddenKeys || []);
  const pins = settings.pinOverrides || {};
  const finalItems = [];
  for (const it of items) {
    const t = it.threadId ? threadMap.get(it.threadId) : null;
    if (it.kind === 'codex' && t && t.missing && !it.chatId) continue; // Codex 紀錄檔已不存在
    if (it.threadId && hidden.has(`codex:${it.threadId}`)) it.hidden = true;
    if (hidden.has(it.key)) it.hidden = true;
    if (Object.prototype.hasOwnProperty.call(pins, it.key)) it.pinned = !!pins[it.key];
    finalItems.push(it);
  }
  // 依建立時間排序：有新訊息時不會把舊對話移到最上面，側欄位置保持不動
  finalItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(a.key).localeCompare(String(b.key)));

  // 專案選單：Codex 的專案 + 最近用過的資料夾
  const recent = [];
  const seen = new Set();
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const pr of (codex.projects || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (!pr.root || seen.has(norm(pr.root))) continue;
    seen.add(norm(pr.root));
    recent.push({ path: pr.root, name: pr.name || path.basename(pr.root) });
  }
  for (const it of finalItems) {
    const project = it.originalProject ?? it.cwd;
    if (!project || it.subagent || seen.has(norm(project))) continue;
    seen.add(norm(project));
    recent.push({ path: project, name: path.win32.basename(project) || project });
    if (recent.length >= 15) break;
  }

  return {
    items: finalItems,
    recentProjects: recent,
    projects: codex.projects || [],
    codexHome: codex.home,
    codexAvailable: codex.available,
    dbError: codex.dbError || codex.error || null,
  };
}

async function resolveChatRef(key) {
  if (key.startsWith('app:')) {
    const chat = await readChat(key.slice(4));
    return { chat, threadId: chat && chat.codexThreadId };
  }
  const threadId = key.slice(6);
  const chat = await findChatByThread(threadId);
  return { chat, threadId };
}

async function distillSourceFor(key) {
  if (typeof key !== 'string' || !/^(?:app:[a-zA-Z0-9_-]+|codex:[a-f0-9-]{36}|localclaude:[a-f0-9]{64})$/.test(key)) throw new Error('請先開啟一段對話');
  const snapshotAt = Date.now();
  const initialRuns = [...running.values()].map(r => ({ key: r.key, startedAt: r.startedAt }));
  if (key.startsWith('localclaude:')) {
    const session = (await localClaudeHistory()).sessions.find(s => s.id === key.slice(12));
    if (!session) throw new Error('找不到這段 Claude Code 對話');
    const data = await claudeHistory.read(session);
    return { title: session.title, messages: data.messages, liveExcluded: 0 };
  }
  const { chat, threadId } = await resolveChatRef(key);
  if (key.startsWith('app:') && !chat) throw new Error('找不到這段對話');
  const merged = await mergedMessages(chat, threadId, { strict: true });
  if (merged.codexError) throw new Error(`對話紀錄讀取不完整，暫時無法匯出：${merged.codexError}`);
  const aliases = new Set([key, chat && `app:${chat.id}`, threadId && `codex:${threadId}`, chat?.codexActiveThreadId && `codex:${chat.codexActiveThreadId}`].filter(Boolean));
  const cutoffs = [...initialRuns, ...running.values()].filter(r => aliases.has(r.key) && r.startedAt).map(r => r.startedAt);
  const cutoff = Math.min(snapshotAt, ...cutoffs);
  let saved = merged.messages.filter(m => !(Date.parse(m.ts) >= cutoff));
  const liveExcluded = merged.messages.length - saved.length;
  // Earlier imports discarded these flags; recover them from the original Claude source for export only.
  if (chat?.localSource?.provider === 'claude') {
    const session = (await localClaudeHistory()).sessions.find(s => s.id === chat.localSource.id);
    if (!session) throw new Error('找不到原始 Claude 紀錄，無法確認匯入內容的錯誤／附件標記');
    const original = await claudeHistory.read(session);
    saved = require('./distillExport').restoreImportMarkers(saved, original.messages);
  }
  const partialWindows = (chat?.messages || []).filter(m => m.partial && m.codexSnapshot?.startedAt).map(m => [Date.parse(m.codexSnapshot.startedAt) - 2000, Date.parse(m.ts) + 2000]);
  const messages = saved.map(m => m.role === 'assistant' && m.provider === 'codex' && partialWindows.some(([start, end]) => Date.parse(m.ts) >= start && Date.parse(m.ts) <= end) ? { ...m, partial: true } : m);
  const hint = threadId ? await findCodexThread(threadId, false) : null;
  return { title: chat?.title || hint?.title || '對話', messages, liveExcluded };
}

// 找執行緒：清單沒有（剛建立或清單過期）就重新讀一次
async function findCodexThread(threadId, refresh = true) {
  const id = String(threadId || '').toLowerCase();
  let t = lastCodexList && lastCodexList.threads.find((x) => x.id === id);
  if (!t && refresh) {
    lastCodexList = await codexStore.listThreads({ codexHome: settings.codexHome }).catch(() => lastCodexList);
    t = lastCodexList && lastCodexList.threads.find((x) => x.id === id);
  }
  return t || null;
}

// 側欄項目對應的紀錄檔：Codex 是 rollout 檔、App 對話是 chats 裡的 JSON、Claude Code 是 jsonl
async function logPathFor(item) {
  const key = String(item?.key || '');
  if (key.startsWith('localclaude:')) {
    const s = (await localClaudeHistory()).sessions.find((x) => x.id === key.slice(12));
    return s ? s.filename : null;
  }
  const { chat, threadId } = await resolveChatRef(key);
  if (key.startsWith('app:')) return chat ? chatPath(chat.id) : null;
  const tid = (chat && chat.codexActiveThreadId) || threadId;
  if (!tid) return null;
  const t = await findCodexThread(tid);
  return codexStore.resolveRolloutPath(codexStore.codexHome(settings.codexHome), tid, t && t.rolloutPath);
}

// 一段側欄對話 → 備份資料（Codex 內容與 App 內的接續訊息合併在一起）
async function backupEntryFor(key) {
  if (key.startsWith('localclaude:')) {
    const session = (await localClaudeHistory()).sessions.find((x) => x.id === key.slice(12));
    if (!session) throw new Error('找不到這段 Claude Code 紀錄');
    const data = await claudeHistory.read(session);
    const chat = { ...data, title: session.title, localSource: { provider: 'claude', id: session.id }, lastProvider: 'claude', updatedAt: new Date(session.updatedAt).toISOString() };
    return chatBackup.packEntry(chat, { sourceKey: key });
  }
  const { chat, threadId } = await resolveChatRef(key);
  if (key.startsWith('app:') && !chat) throw new Error('找不到這段對話');
  const t = threadId ? await findCodexThread(threadId) : null;
  const { messages, codexCwd, codexError } = await mergedMessages(chat, threadId);
  if (codexError && !messages.length) throw new Error(codexError);
  const base = chat ? { ...chat } : { lastProvider: 'codex' };
  if (!base.title) base.title = (t && t.title) || '對話備份';
  if (!base.cwd) base.cwd = codexCwd || (t && t.cwd) || '';
  if (!chat && t) {
    if (t.createdAt) base.createdAt = new Date(t.createdAt).toISOString();
    if (t.updatedAt) base.updatedAt = new Date(t.updatedAt).toISOString();
  }
  return chatBackup.packEntry(base, { sourceKey: key, sourceThreadId: threadId, messages });
}

// target：{ mode: 'project', cwd } 放到指定專案；{ mode: 'original' } 放回原資料夾（這台電腦沒有就不指定）
let chatImportBusy = false;
let chatImportCancelled = false;
function restoreEntries(entries, target, onProgress) {
  return require('./chatRestore').restore(entries, {
    directory: chatsDir(), attachmentsDir: path.join(userDir(), 'attachments'),
    newId, readChat, writeChat, target, onProgress, isCancelled: () => chatImportCancelled,
  });
}
async function restoreBackupFile(file, target = { mode: 'none' }, onProgress = () => {}) {
  return restoreEntries(chatBackup.readBackup(file), target, onProgress);
}

async function moveChatTo(key, cwd) {
  if ([...running.values()].some(run => run.key === key)) throw new Error('請先停止這段對話再切換工作資料夾');
  let { chat, threadId } = await resolveChatRef(key);
  if (!chat) {
    if (!threadId) throw new Error('找不到對話');
    const t = await findCodexThread(threadId);
    chat = { id: newId('cx'), origin: 'codex', title: '', cwd: '', codexThreadId: threadId, messages: [], createdAt: new Date(t && t.createdAt || Date.now()).toISOString(), lastProvider: 'codex' };
  }
  chat.cwd = cwd;
  delete chat.workspace; delete chat.originalProject;
  require('./chatLive').remember(chat.id, {workspace:undefined, originalProject:undefined});
  chat.sidebarProjectAssigned = true;
  await writeChat(chat, { keepTime: true });
  if (cwd) showProjectInSidebar(cwd);
}

async function mergedMessages(chat, threadIdIn, { strict = false } = {}) {
  let codexMsgs = [];
  let codexCwd = '';
  let codexError = null;
  const threadId = (chat && chat.codexActiveThreadId) || threadIdIn;
  if (threadId) {
    const hint = await findCodexThread(threadId);
    try {
      const tr = await codexStore.loadTranscript({ codexHome: settings.codexHome, id: threadId, rolloutPath: hint && hint.rolloutPath, strict });
      codexMsgs = tr.messages.map(m => m.role === 'user' ? { ...m, text: browserPolicy.cleanTranscriptText(m.text) } : m); codexCwd = tr.cwd; codexError = tr.error || null;
    } catch (e) { codexError = `讀取 Codex 紀錄失敗：${e.message}`; }
  }
  const appMsgs = ((chat && chat.messages) || []).map(m => require('./codexPartial').reconcile(m, codexMsgs)).filter(Boolean);
  const all = [...codexMsgs, ...appMsgs.map((m) => ({ ...m, source: 'app' }))];
  all.forEach((m, i) => { m._order = i; });
  all.sort((a, b) => {
    const ta = Date.parse(a.ts) || 0; const tb = Date.parse(b.ts) || 0;
    return ta - tb || a._order - b._order;
  });
  return { messages: all, codexCwd, codexError };
}
async function codexAccountCall(customPath, home, calls, timeout) {
  const lease = await accountStore().captureRunHome(home);
  try { return await codexRunner.appServerCall(customPath, lease.home, calls, timeout); }
  finally { await lease.release(); }
}

// Permanent deletion never archives or hides a conversation as a substitute.
// Old HTTP-era settings stored API model IDs (lowercase slugs like gpt-6); the website picker
// uses display labels, so an ID never matches. Follow the site's selected model instead of guessing.
function webSiteModelLabel(value){const text=String(value||'').trim();return /^(?:gpt|o\d)[a-z0-9._-]*$/.test(text)&&text===text.toLowerCase()?'':text;}
let websiteHttpSessionManager;
function websiteHttpSessions(){return websiteHttpSessionManager ||= require('./websiteHttpSession').createManager();}
function websiteHttpAccount(site){return site==='gpt'?settings.providers.gpt.webAccountId||'default':'default';}
function websiteHttpClient(site,{model='',signal,accountId=websiteHttpAccount(site)}={}){
  const jar=websiteHttpSessions().getSession({site,accountId});
  return require('./websiteHttp').create({site,model,signal,fetch:(url,options)=>jar.fetch(url,{...options,credentials:'include'})});
}
async function loginWebsiteHttp(site,{accountId=websiteHttpAccount(site),signal}={}){
  return require('./websiteHttpLogin').login({site,accountId,signal,manager:websiteHttpSessions(),
    client:websiteHttpClient(site,{accountId,signal}),
    readCookies:()=>require('./wangpinLogin').readCookies({site,signal,browser:wangpinBrowserForChat('__website_cookie_sync__',settings.browser||{}).browser})});
}
let deletionBusy=false,deletionPlanning=false;
const deletedChatIds=new Set();
function activeConversationKeys(){
  const keys=[...running.values()].filter(r=>!r.finished).map(r=>r.key);
  for(const agent of agents.live.values())if(['queued','running'].includes(agent.status))keys.push(agent.key,agent.parentKey);
  return keys.filter(Boolean);
}
async function deletionPlan(key){
  const plan=await require('./conversationRemoval').prepare({dataRoot:userDir(),codexHome:codexStore.codexHome(settings.codexHome),settings,key,activeIds:activeConversationKeys()});
  return plan;
}
async function commitDeletion(plan){
  const report=await require('./conversationRemoval').execute(plan,{queueWrite:queueChatWrite,getActiveIds:activeConversationKeys,onDeleted:id=>{
    deletedChatIds.add(id);require('./chatLive').forget(id);sidebarMetadata.invalidate(id);agents.live.delete(id);browserChoiceManager?.forget(id);
  }});
  const removed=new Set(report.keys||[]);
  for(const id of report.deletedIds||[])removed.add('app:'+id);
  settings.hiddenKeys=(settings.hiddenKeys||[]).filter(key=>!removed.has(key));
  for(const name of ['pinOverrides','sidebarTitleOverrides'])for(const key of removed)if(settings[name])delete settings[name][key];
  for(const source of ['codex','claude'])if(settings.sidebarSourceConversations?.[source])settings.sidebarSourceConversations[source]=settings.sidebarSourceConversations[source].filter(key=>!removed.has(key));
  saveSettings();searchCache.clear();chatSearch.clearIndexCache();lastCodexList=null;
  return report;
}
async function permanentlyRemoveConversation(key){
  if(deletionBusy||deletionPlanning)throw Error('正在刪除對話，請稍候');deletionPlanning=true;
  try{
    // Planning/confirmation only reads, so sending messages stays possible; the busy gate covers the commit alone.
    let plan=await deletionPlan(key);
    const answer=await dialog.showMessageBox(win,require('./deletionConfirmation').options(plan));
    if(answer.response!==0)return {ok:false,cancelled:true};
    plan=await deletionPlan(key);
    deletionBusy=true;
    const report=await commitDeletion(plan);
    if(!report.ok)await dialog.showMessageBox(win,{type:'error',title:'部分刪除未完成',message:'部分紀錄未能刪除，請勿當作全部完成',detail:report.errors.map(e=>e.message).join('\n')});
    return {...report,removed:'deleted'};
  }finally{deletionBusy=false;deletionPlanning=false;}
}
async function applyRequestedCleanup(){
  const file=path.join(userDir(),'pending-conversation-cleanup.json');
  let job;try{job=JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(job?.version!==1||job?.action!=='deleteArchivedAndSubagents')throw Error('清理要求格式不正確');
  deletionBusy=true;
  try{
    const plan=await deletionPlan();
    const summary=await commitDeletion(plan);
    await fsp.writeFile(path.join(userDir(),'conversation-cleanup-result.json'),JSON.stringify({...summary,at:new Date().toISOString(),preview:plan.preview},null,2));
    if(!summary.ok)throw Error(summary.errors.map(e=>e.message).join('；'));
    if(!plan.preview.skippedActive)await fsp.unlink(file);
  }finally{deletionBusy=false;}
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('grokbot:open',async event=>{assertGptSender(event);return require('./grokBotDesktop').open();});
  ipcMain.handle('grokbot:copyDraft',async(event,text)=>{
    assertGptSender(event);
    if(typeof text!=='string'||!text.trim()||text.length>1000000)throw Error('輸入內容無效、空白或過長');
    const result=await require('./grokBotDesktop').open();
    clipboard.writeText(text);return {...result,copied:true};
  });
  ipcMain.handle('grokbot:saveConfig',async(event,patch={})=>{
    assertGptSender(event);
    if(!patch||typeof patch!=='object')throw Error('Grok Bot 設定格式錯誤');
    const cur=settings.providers.grokbot||{};
    if(patch.clearKey===true){settings.providers.grokbot={...cur,webhookKey:''};saveSettings();return publicSettings();}
    const next={...cur};
    if(typeof patch.allowPublicReplies==='boolean')next.allowPublicReplies=patch.allowPublicReplies;
    if(typeof patch.sendWorkspace==='boolean')next.sendWorkspace=patch.sendWorkspace;
    for(const field of ['webhookUrl','ntfyTopic','ntfyServer'])if(typeof patch[field]==='string')next[field]=patch[field].trim().slice(0,2048);
    let plainKey=decryptKey(cur.webhookKey||'');
    if(patch.clearKey===true)plainKey='';
    else if(typeof patch.webhookKey==='string'&&patch.webhookKey.trim())plainKey=grokBotBridgeKit.cleanKey(patch.webhookKey);
    const checked=grokBotBridgeKit.validateConfig({...next,webhookKey:plainKey},{requireWebhook:false});
    if(plainKey && !safeStorage.isEncryptionAvailable())throw Error('系統安全儲存目前無法使用，Webhook Key 尚未保存，請稍後重試。');
    settings.providers.grokbot={...next,webhookUrl:checked.webhookUrl,ntfyTopic:checked.ntfyTopic,ntfyServer:checked.ntfyServer,allowPublicReplies:checked.allowPublicReplies,webhookKey:plainKey?encryptKey(plainKey):'',permission:'chat'};
    saveSettings();
    return publicSettings();
  });
  ipcMain.handle('grokbuild:status',async(event,opts={})=>{assertGptSender(event);try{return await grokBuild.status({force:opts?.force===true});}catch(e){return{ok:false,installed:!!grokBuild.cliPath(),signedIn:grokBuild.signedIn(),models:[],message:e.message};}});
  ipcMain.handle('grokbuild:login',async event=>{assertGptSender(event);try{return await grokBuild.openLogin();}catch(e){return{ok:false,message:e.message};}});
  ipcMain.handle('grokbuild:install',async event=>{assertGptSender(event);try{return grokBuild.openInstall();}catch(e){return{ok:false,message:e.message};}});
  ipcMain.handle('grokbot:testNtfy',async event=>{assertGptSender(event);return grokBotBridge().checkNtfy(grokBotConfig());});
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('distill:preview', async (_e, opts = {}) => {
    const source = await distillSourceFor(opts.key);
    const format = require('./distillExport').formatOf(opts.format || settings.distillExport?.format);
    const dataset = require('./distillExport').build(source.messages, { format, includeAttachmentText: opts.includeAttachmentText === true });
    return { title: source.title, format, folder: settings.distillExport?.folder || '', stats: { ...dataset.stats, liveExcluded: source.liveExcluded } };
  });
  ipcMain.handle('distill:pickFolder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { title: '選擇蒸餾樣本的輸出資料夾', defaultPath: typeof current === 'string' && current ? current : settings.distillExport?.folder || app.getPath('desktop'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  ipcMain.handle('distill:export', async (_e, opts = {}) => {
    const source = await distillSourceFor(opts.key);
    const format = require('./distillExport').formatOf(opts.format);
    const dataset = require('./distillExport').build(source.messages, { format, includeAttachmentText: opts.includeAttachmentText === true });
    const result = await require('./distillExport').write(opts.folder, source.title, dataset, format);
    settings.distillExport = { folder: opts.folder, format };
    let warning = '';
    try { saveSettings(); } catch { warning = '樣本已匯出，但無法記住輸出資料夾；下次請重新選擇。'; }
    return { ...result, warning, stats: { ...result.stats, liveExcluded: source.liveExcluded } };
  });

  const webModelLogins = new Map();
  const webModelReads = new Map();
  const webModelProfile = site => {
    if (!['claude','gemini'].includes(site)) throw Error('不支援的網頁網站');
    return path.join(userDir(),'web-model-profiles',site);
  };
  ipcMain.handle('webmodels:status', (_e,site) => require('./webModelsBrowser').status({site,profileDir:webModelProfile(site)}));
  ipcMain.handle('webmodels:models', async (event,site) => {
    assertGptSender(event);
    if(!['gpt','claude','gemini'].includes(site))throw Error('不支援的網頁網站');
    if(settings.webWebsiteHttpOnly===true){const accountId=websiteHttpAccount(site);const rows=await websiteHttpClient(site,{accountId}).listModels();return {models:rows.map(row=>({slug:row.id,title:row.label})),accountId};}
    const key=event.sender.id+':'+site;
    if(webModelReads.has(key))throw Error('這個網站的模型清單正在讀取。');
    const controller=new AbortController(),abort=()=>controller.abort();
    const timer=setTimeout(abort,60000);webModelReads.set(key,controller);event.sender.once('destroyed',abort);
    try {
    if(site === 'gpt') {
      const account=await gptAccountStore().active();
      if(!account)throw Error('請先登入 GPT 網頁帳號。');
      if(gptLoginAccountId === account.id)throw Error('這個帳號正在登入，請完成後再讀取模型。');
      const result=await require('./chatgptWeb').listModels({profileDir:account.profileDir,importExistingLogin:false,bravePath:settings.browser?.path || '',hideWindow:settings.webHideWindow!==false,signal:controller.signal});
      if(controller.signal.aborted)return {models:[],cancelled:true};
      return {...result,accountId:account.id};
    }
    const profileDir=webModelProfile(site);
    if(webModelLogins.has(site))throw Error('這個網站正在登入，請完成後再讀取模型。');
    return await require('./webModelsBrowser').listModels({site,profileDir,bravePath:settings.browser?.path || '',hideWindow:settings.webHideWindow!==false,signal:controller.signal});
    } finally {clearTimeout(timer);event.sender.removeListener('destroyed',abort);webModelReads.delete(key);}
  });
  ipcMain.handle('webmodels:cancelModels', (event,site) => {
    assertGptSender(event);webModelReads.get(event.sender.id+':'+site)?.abort();return {ok:true};
  });
  ipcMain.handle('webmodels:cancelLogin', (event,site) => {assertGptSender(event);if(!['gpt','claude','gemini'].includes(site))throw Error('不支援的網頁網站');webModelLogins.get(site)?.abort();return {ok:true};});
  ipcMain.handle('webmodels:login', async (event,site) => {
    assertGptSender(event);
    if(!['gpt','claude','gemini'].includes(site))throw Error('不支援的網頁網站');
    if([...running.values()].some(r=>!r.finished && r.webModelSites?.includes(site)))throw Error('這個網站正在回答，請先停止再同步登入。');
    if(settings.webWebsiteHttpOnly===true){
      if(webModelLogins.has(site))throw Error('這個網站正在登入');
      const controller=new AbortController();webModelLogins.set(site,controller);
      try{
        return await loginWebsiteHttp(site,{signal:controller.signal});
      }
      finally{webModelLogins.delete(site);}
    }
    const profileDir = webModelProfile(site);
    if(webModelLogins.has(site) || [...running.values()].some(r=>!r.finished && r.webModelSites?.includes(site))) throw Error('這個網頁模型正在登入或回答，請等結束後再登入。');
    const controller = new AbortController();webModelLogins.set(site,controller);
    try{return await require('./webModelsBrowser').login({site,profileDir,bravePath:settings.browser?.path || '',signal:controller.signal});}
    finally{webModelLogins.delete(site);}
  });
  ipcMain.handle('settings:save', (_e, patch) => {
    const p = JSON.parse(JSON.stringify(patch || {}));
    for (const name of API_PROVIDERS) {
      if (p.providers && p.providers[name]) { delete p.providers[name].keys; delete p.providers[name].activeKeyId; delete p.providers[name].hasKey; }
    }
    delete p.catalog;
    // Grok Bot 的 Webhook URL／Key 只能經由 grokbot:saveConfig 修改（畫面拿不到也改不到加密後的金鑰）
    if (p.providers) delete p.providers.grokbot;
    if (p.providers?.claude && ['claudePath', 'configDir'].some(k => k in p.providers.claude && p.providers.claude[k] !== settings.providers.claude[k])) {
      clearClaudeCaches(); claudeAccountManager?.invalidate({ selectionChanged: true });
    }
    settings = deepMerge(settings, p);
    saveSettings();
    return publicSettings();
  });

  const findKey = (provider, id) => {
    if (!API_PROVIDERS.includes(provider)) throw new Error('不支援的模型');
    const k = (settings.providers[provider].keys || []).find((x) => x.id === id);
    if (!k) throw new Error('找不到這把金鑰');
    return k;
  };

  ipcMain.handle('keys:save', async (_e, { provider, id, name, apiKey, baseUrl }) => {
    if (!API_PROVIDERS.includes(provider)) throw new Error('不支援的模型');
    const c = settings.providers[provider];
    const cleanKey = String(apiKey || '').replace(/\s+/g, '');
    const label = providers.PROVIDERS[provider].label;
    let k;
    if (id) {
      k = findKey(provider, id);
    } else {
      if (!cleanKey && provider !== 'lmstudio') return { error: '請貼上 API 金鑰' };
      k = { id: newId('key') };
      c.keys.push(k);
    }
    k.name = String(name || '').trim() || k.name || `${label} 金鑰 ${c.keys.length}`;
    if (cleanKey) { k.apiKey = encryptKey(cleanKey); k.lastTest = null; }
    else if (!id && provider === 'lmstudio') k.apiKey = '';
    const rawBase = String(baseUrl || '').trim();
    k.baseUrl = sanitizeBaseUrl(provider, rawBase);
    if (!c.activeKeyId || !id && c.keys.length === 1) c.activeKeyId = k.id;
    if ((provider === 'gpt' || provider === 'claude') && !id) { c.activeKeyId = k.id; c.via = 'api'; }
    saveSettings();
    const note = rawBase && !k.baseUrl ? '你填的 API 網址不是 API 伺服器（像是官網後台），已自動改回預設。' : null;
    return { settings: publicSettings(), id: k.id, note };
  });

  ipcMain.handle('keys:delete', async (_e, { provider, id }) => {
    const k = findKey(provider, id);
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['刪除', '取消'], defaultId: 1, cancelId: 1,
      title: '刪除金鑰', message: `要刪除「${k.name}」嗎？`, detail: '只會從這個 App 移除，官網上的金鑰不受影響。',
    });
    if (r.response !== 0) return { settings: publicSettings(), cancelled: true };
    const c = settings.providers[provider];
    c.keys = c.keys.filter((x) => x.id !== id);
    if (c.activeKeyId === id) c.activeKeyId = c.keys[0] ? c.keys[0].id : null;
    saveSettings();
    return { settings: publicSettings() };
  });

  ipcMain.handle('keys:setActive', (_e, { provider, id }) => {
    if (provider === 'gpt' && id === '__web__') {
      settings.providers.gpt.via = 'web';
      saveSettings();
      return publicSettings();
    }
    if (provider === 'gpt' && id === '__codex__') {
      settings.providers.gpt.via = 'codex';
      saveSettings();
      return publicSettings();
    }
    if (provider === 'claude' && id === '__claudecode__') {
      settings.providers.claude.via = 'claudecode';
      saveSettings();
      return publicSettings();
    }
    findKey(provider, id);
    if (provider === 'gpt') settings.providers.gpt.via = 'api';
    if (provider === 'claude') settings.providers.claude.via = 'api';
    settings.providers[provider].activeKeyId = id;
    saveSettings();
    return publicSettings();
  });

  ipcMain.handle('keys:test', async (_e, { provider, id }) => {
    const k = findKey(provider, id);
    let result;
    try {
      const ids = await providers.listModels(provider, providerCfg(provider, id));
      result = { ok: true, message: `可以使用（找到 ${ids.length} 個模型）`, at: Date.now() };
      settings.modelLists[provider] = ids;
    } catch (err) {
      result = { ok: false, message: String((err && err.message) || err), at: Date.now() };
    }
    k.lastTest = result;
    saveSettings();
    return { settings: publicSettings(), result };
  });

  let attachmentPickBusy = false;
  ipcMain.handle('attachments:pick', async (event, options = {}) => {
    assertGptSender(event);
    if (attachmentPickBusy) throw Error('正在準備附件，請稍候。');
    const slots = Number.isInteger(options.availableSlots) ? Math.max(0, Math.min(16, options.availableSlots)) : 16;
    const normalSlots = Number.isInteger(options.availableNormalSlots) ? Math.max(0, Math.min(8, options.availableNormalSlots)) : 8;
    if (!slots) throw Error('附件已滿，請先移除部分附件。');
    attachmentPickBusy = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    event.sender.once('destroyed', abort);
    try {
    const r = await dialog.showOpenDialog(win, { title: '加入圖片、影片、音樂或檔案（每個最多 600 MB）', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { items: [] };
    const items = []; const errors = []; const videos = [];
    for (const file of r.filePaths.slice(0, 8)) {
      try {
        if (controller.signal.aborted) throw Error('附件準備已取消。');
        if (items.length >= slots) throw Error('本次附件空間已滿，請分次加入影片。');
        const directory = path.join(userDir(), 'attachments');
        const media = require('./mediaExtract').mediaKind(file);
        if (!media && items.filter(item => !item.video && !item.audio).length >= normalSlots) throw Error('一般附件每次最多 8 個；請先移除部分附件。');
        const batch = media
          ? await require('./mediaExtract').extractMedia(file, directory, { maxImages: Math.min(9, slots - items.length), signal: controller.signal })
          : [attachments.stage(file, directory)];
        for (const item of batch) {
          stagedAttachments.set(item.id, item);
          items.push({ id: item.id, name: item.name, mime: item.mime, size: item.size, ...(item.video ? {video: item.video} : {}), ...(item.audio ? {audio: item.audio} : {}) });
        }
        if (media) videos.push({name:path.basename(file),kind:media,frames:batch.filter(item=>item.video&&item.video.kind!=='audio').length,sheets:batch.filter(item=>item.video?.kind==='sheet').length,dense:batch.find(item=>item.video)?.video.dense||0,audio:batch.some(item=>item.audio),audioError:batch.find(item=>item.video)?.video.audioError||''});
      }
      catch (e) { errors.push(e.message); }
    }
    return { items, errors, videos };
    } finally { event.sender.removeListener('destroyed', abort); attachmentPickBusy = false; }
  });
  ipcMain.handle('attachments:addImage', (_e, { bytes, name }) => {
    const item = attachments.stageImage(bytes, path.join(userDir(), 'attachments'), name);
    stagedAttachments.set(item.id, item);
    return { id: item.id, name: item.name, mime: item.mime, size: item.size };
  });
  ipcMain.handle('attachments:preview', (_e, ref) => {
    const item = stagedAttachments.get(ref?.id);
    const file = item?.path || ref?.path;
    if (typeof file !== 'string') throw new Error('找不到這張圖片');
    const root = fs.realpathSync(path.join(userDir(), 'attachments'));
    const real = fs.realpathSync(file);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('此圖片不在 app 的附件資料夾');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(real).toLowerCase()];
    if (!mime || fs.statSync(real).size > 10 * 1024 * 1024) throw new Error('圖片格式或大小不支援預覽');
    return { url: `data:${mime};base64,${fs.readFileSync(real).toString('base64')}` };
  });
  ipcMain.handle('links:open', async (_e, raw) => {
    try { return await chatLinks.open(raw, { dialog, shell, window: win }); }
    catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('chat:storageInfo', () => ({directory:chatsDir(), portable:!!portableMode}));
  ipcMain.handle('chat:cancelImport', () => { chatImportCancelled = true; });
  async function importConversations(e, folder = false) {
    if(chatImportBusy)throw Error('對話正在載入，請等待完成或取消');
    chatImportBusy=true;chatImportCancelled=false;
    const progress = data => { if(!e.sender.isDestroyed())e.sender.send('chat:importProgress',data); };
    try {
      const r = await dialog.showOpenDialog(win, folder ? {
        title:'選擇要載入的對話資料夾（原檔保留）', properties:['openDirectory'], defaultPath:settings.lastChatImportFolder || app.getPath('appData'),
      } : { title: '匯入對話或還原備份', properties: ['openFile', 'multiSelections'], filters: [{ name: '備份與對話匯出檔', extensions: ['cmbak', 'json', 'jsonl', 'txt', 'md'] }, { name: 'Codex Multi 備份', extensions: ['cmbak'] }] });
      if(r.canceled || !r.filePaths.length)return {keys:[],cancelled:true};
      if(folder){
        await require('./chatRestore').folderDirectory(r.filePaths[0],chatsDir());
        const answer=await dialog.showMessageBox(win,{type:'question',title:'載入對話資料夾',buttons:['匯入一份','取消'],defaultId:0,cancelId:1,
          message:'將來源對話匯入目前工作台，原檔保留',detail:`來源：${r.filePaths[0]}\n儲存到：${chatsDir()}\n\n可選擇舊版的資料目錄或 chats 資料夾。不會載入帳號、設定或隱藏的流程階段；需要足夠的可用磁碟空間。`});
        if(answer.response!==0)return {keys:[],cancelled:true};
      }
      const keys=[],errors=[],dupKeys=[],dirs=new Set();let skipped=0,restored=0,target=null;
      for(const file of r.filePaths){
        if(chatImportCancelled)break;
        try {
          if(folder || await chatBackup.isBackupFile(file)){
            if(!target){
              const cur=settings.defaultCwd||'';
              const PICK='選擇工作資料夾…';
              const buttons=cur?[`放到「${path.win32.basename(cur)||cur}」`,PICK,'放回原本的資料夾','不指定資料夾','取消']:[PICK,'放回原本的資料夾','不指定資料夾','取消'];
              const q=await dialog.showMessageBox(win,{type:'question',buttons,defaultId:0,cancelId:buttons.length-1,title:'還原對話備份',message:'還原的對話要在哪個資料夾工作？',detail:'這只決定模型之後處理檔案的位置，不影響對話儲存位置。可直接選擇資料夾；「放回原本」在該資料夾不存在時會改為未指定。'});
              const choice=buttons[q.response];
              if(!choice || choice==='取消')return {keys,dupKeys,errors,skipped,restored,cancelled:true};
              if(choice===PICK){
                const picked=await dialog.showOpenDialog(win,{title:'選擇還原對話的工作資料夾',properties:['openDirectory'],defaultPath:cur||app.getPath('home')});
                if(picked.canceled||!picked.filePaths.length)return {keys,dupKeys,errors,skipped,restored,cancelled:true};
                target={mode:'project',cwd:picked.filePaths[0]};
              }else target=choice.startsWith('放到')?{mode:'project',cwd:cur}:choice==='放回原本的資料夾'?{mode:'original'}:{mode:'none'};
            }
            progress({phase:'start',file:path.basename(file),destination:chatsDir()});
            const out=folder ? await restoreEntries(require('./chatRestore').folderEntries(file),target,progress) : await restoreBackupFile(file,target,progress);
            keys.push(...out.keys);dupKeys.push(...out.dupKeys);errors.push(...out.errors);skipped+=out.skipped;restored+=out.keys.length;out.dirs.forEach(d=>dirs.add(d));
            if(folder && !out.errors.length && !out.cancelled){settings.lastChatImportFolder=file;saveSettings();}
          } else {
            if((await fsp.stat(file)).size>50*1024*1024)throw Error('一般匯出檔超過 50 MB；大型備份請選擇原始 .cmbak 檔');
            for(const data of parseImport(await fsp.readFile(file,'utf8'),path.basename(file))){
              if(chatImportCancelled)break;
              const chat={...data,id:newId('import'),origin:'app',cwd:'',importedCwd:data.cwd,createdAt:new Date().toISOString(),messages:data.messages.map(m=>({...m,id:newId('m'),ts:m.ts||new Date().toISOString()}))};
              await writeChat(chat);keys.push('app:'+chat.id);
            }
          }
        }catch(error){errors.push(`${path.basename(file)}：${error.message}`);}
      }
      for(const dir of dirs)showProjectInSidebar(dir);
      return {keys,dupKeys,errors,skipped,restored,dirs:[...dirs],cancelled:chatImportCancelled};
    }finally{chatImportBusy=false;progress({phase:'done'});}
  }
  ipcMain.handle('chat:import', e => importConversations(e));
  ipcMain.handle('chat:importFolder', e => importConversations(e,true));

  // 用連結開啟的對話不在側欄顯示的專案裡時，問要放到哪裡
  ipcMain.handle('sidebar:askPlace', async (_e, { key, title, cwd }) => {
    const cur = settings.defaultCwd || '';
    const buttons = [];
    if (cur && normDir(cur) !== normDir(cwd)) buttons.push({ id: 'move', label: `移到「${path.win32.basename(cur) || cur}」` });
    if (cwd) buttons.push({ id: 'show', label: `在側欄顯示「${path.win32.basename(cwd) || cwd}」` });
    buttons.push({ id: 'none', label: '只開啟，不加到側欄' });
    const q = await dialog.showMessageBox(win, {
      type: 'question', buttons: buttons.map((b) => b.label), defaultId: 0, cancelId: buttons.length - 1,
      title: '加入側欄', message: `「${title || '這段對話'}」不在目前側欄顯示的專案裡`,
      detail: `${cwd ? `它原本的專案資料夾：${cwd}\n\n` : ''}移到目前專案後，之後在這段對話送出的訊息會在「${cur}」工作；Codex 原本的紀錄不會被修改。`,
    });
    const pick = buttons[q.response].id;
    if (pick === 'move') {
      if ([...running.values()].some((r) => r.key === key)) throw new Error('這段對話正在執行，請先暫停再移動');
      await moveChatTo(key, cur);
      return { ok: true, action: 'move', cwd: cur };
    }
    if (pick === 'show') { showProjectInSidebar(cwd); return { ok: true, action: 'show', cwd }; }
    return { ok: true, action: 'none' };
  });
  ipcMain.handle('sidebar:move', async (_e, { key, cwd }) => {
    if ([...running.values()].some((r) => r.key === key)) throw new Error('這段對話正在執行，請先暫停再移動');
    await moveChatTo(key, String(cwd || ''));
    return { ok: true };
  });

  // ---- Codex 多帳號 ----
  const prepareCodexAccountChange = async () => {
    const active = [...running.values()].filter((r) => r.usesCodexAuth && !r.isolatedCodexAuth && !r.finished);
    if (!active.length) { await codexRunner.waitForAccountReaders(); return true; }
    const answer = await dialog.showMessageBox(win, { type: 'question', title: '切換 Codex 帳號', buttons: ['停止回合並切換', '取消'], defaultId: 1, cancelId: 1,
      message: `目前有 ${active.length} 個 Codex 回合正在執行。要先停止它們再更新登入嗎？`,
      detail: '舊程序可能會刷新並寫回共用憑證，必須等它們結束後才能安全切換。已保存的對話與檔案會保留，切換後可手動接續。' });
    if (answer.response !== 0) return false;
    for (const run of active) run.cancel();
    const until = Date.now() + 15000;
    while (active.some((r) => !r.finished) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    if (active.some((r) => !r.finished)) throw new Error('Codex 回合尚未結束，登入資料沒有切換。請等停止完成後再試。');
    await codexRunner.waitForAccountReaders();
    return true;
  };
  const forgetCodexCaches = () => { lastCodexList = null; };
  ipcMain.handle('codexAccounts:list', () => accountStore().list(settings.codexHome));
  ipcMain.handle('codexAccounts:switch', async (_e, id) => {
    codexAccountChanges++; codexRunner.beginAccountChange();
    try {
      const r = await accountStore().switchTo(String(id || ''), settings.codexHome, { beforeActivate: prepareCodexAccountChange });
      if (r.ok) forgetCodexCaches();
      return r;
    } finally { codexAccountChanges--; codexRunner.endAccountChange(); }
  });
  ipcMain.handle('codexAccounts:login', async (e, opts = {}) => {
    const resolved = await codexRunner.resolveCodex(settings.providers.codex.path);
    if (!resolved.path) return { ok: false, message: '找不到 Codex CLI，請先安裝 Codex。' };
    let activating = false;
    try {
      const result = await accountStore().login({
        spawnCli: codexRunner.spawnCli, codexPath: resolved.path, killTree: codexRunner.killTree,
        codexHome: settings.codexHome, switchAfter: !!opts.switchAfter, deviceAuth: !!opts.deviceAuth,
        beforeActivate: async () => { activating = true; codexAccountChanges++; codexRunner.beginAccountChange(); return prepareCodexAccountChange(); },
        onUrl: (url, log) => { if (!e.sender.isDestroyed()) e.sender.send('codexAccounts:loginInfo', { url, log: opts.deviceAuth ? String(log || '').slice(-600) : '' }); },
      });
      if (result.ok) forgetCodexCaches();
      return result;
    } finally { if (activating) { codexAccountChanges--; codexRunner.endAccountChange(); } }
  });
  ipcMain.handle('codexAccounts:cancelLogin', () => accountStore().cancelLogin());
  ipcMain.handle('codexAccounts:rename', (_e, { id, name }) => accountStore().rename(id, name));
  ipcMain.handle('codexAccounts:remove', async (_e, id) => {
    if ([...running.values()].some(r => r.accountId === id && !r.finished)) return { ok: false, message: '這個帳號仍有回合正在執行，請等回合結束後再移除。' };
    const list = await accountStore().list(settings.codexHome);
    const acc = list.accounts.find((a) => a.id === id);
    if (!acc) return { ok: false };
    if (acc.active) return { ok: false, message: '這是目前使用中的帳號，請先切換到其他帳號再移除' };
    const q = await dialog.showMessageBox(win, { type: 'warning', buttons: ['移除', '取消'], defaultId: 1, cancelId: 1, title: '移除 Codex 帳號', message: `要從這個 App 移除「${acc.label}」嗎？`, detail: '只會刪除這個 App 存的登入資料，不會登出或刪除 OpenAI 帳號。之後要用可以再登入一次。' });
    if (q.response !== 0) return { ok: false };
    return accountStore().remove(id);
  });

  // 用 codex://threads/<id> 或執行緒 ID 開啟 Codex 對話
  ipcMain.handle('codex:resolveLink', async (_e, text) => {
    const opts = text && typeof text === 'object' ? text : { text };
    const id = chatBackup.parseThreadLink(opts.text);
    if (!id) return { ok: false, message: '看不懂這個連結。請貼上 codex://threads/… 或執行緒 ID。' };
    const t = await findCodexThread(id);
    const linked = await findChatByThread(id);
    if (!t && !linked) {
      const file = await codexStore.resolveRolloutPath(codexStore.codexHome(settings.codexHome), id, null);
      if (!file) return { ok: false, id, message: `這台電腦的 Codex 資料夾（${codexStore.codexHome(settings.codexHome)}）找不到執行緒 ${id}。它可能在別台電腦，或 Codex 用的是別的 CODEX_HOME。` };
    }
    // 已經在 App 裡接續過的執行緒，側欄以 App 對話為準
    const key = linked && linked.origin !== 'codex' ? `app:${linked.id}` : `codex:${id}`;
    if (opts.place === true) {
      if ([...running.values()].some(r => r.key === key)) return { ok: false, message: '這段對話正在執行，請先暫停再加入專案' };
      await moveChatTo(key, String(opts.cwd || ''));
      settings.hiddenKeys = (settings.hiddenKeys || []).filter(k => k !== key && k !== `codex:${id}`);
      saveSettings();
    }
    const hidden = (settings.hiddenKeys || []).includes(key) || (settings.hiddenKeys || []).includes(`codex:${id}`);
    return { ok: true, id, key, placed: opts.place === true, title: (linked && linked.title) || (t && t.title) || '', cwd: opts.place === true ? String(opts.cwd || '') : (linked?.cwd || t?.cwd || ''), archived: !!t?.archived, subagent: !!t?.subagent, hidden };
  });
  // Electron 44 起剪貼簿 API 是非同步的；await 對舊版的同步回傳值也適用
  ipcMain.handle('clipboard:readText', async () => String((await clipboard.readText()) || '').slice(0, 4000));

  // 備份：keys 指定要備份的側欄對話；all=true 由使用者選擇範圍
  ipcMain.handle('chat:backup', async (_e, opts = {}) => {
    let keys = Array.isArray(opts.keys) ? opts.keys.map(String) : [];
    let includeCodex = false;
    if (opts.all) {
      const r = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['只備份 App 對話', 'App 對話＋所有 Codex 執行緒', '取消'], defaultId: 0, cancelId: 2,
        title: '備份全部對話', message: '要備份哪些對話？',
        detail: 'App 對話：在這個 App 建立、匯入或接續過的對話（含接續過的 Codex 內容）。\n\n所有 Codex 執行緒：再加上 Codex 側欄裡每一條未封存的主執行緒，檔案較大、需要較久。\n\n封存、已移除的對話和子代理不會包含在內。',
      });
      if (r.response === 2) return { ok: false };
      includeCodex = r.response === 1;
      const side = await buildSidebar();
      keys = side.items.filter((it) => !it.archived && !it.hidden && !it.subagent && !it.parentKey && (it.chatId || (includeCodex && it.kind === 'codex' && !it.empty))).map((it) => it.key);
    }
    keys = [...new Set(keys)].filter((k) => /^(app|codex|localclaude):/.test(k));
    if (!keys.length) return { ok: false, message: '沒有可備份的對話' };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const single = keys.length === 1 ? String(opts.title || '對話').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) : '';
    const s = await dialog.showSaveDialog(win, {
      title: '儲存對話備份',
      defaultPath: path.join(app.getPath('documents'), `${single || 'Codex Multi 全部對話'} ${stamp}.cmbak`),
      filters: [{ name: 'Codex Multi 備份', extensions: ['cmbak'] }],
    });
    if (s.canceled || !s.filePath) return { ok: false };
    const errors = [];
    async function* entries() {
      for (const key of keys) {
        try { yield await backupEntryFor(key); } catch (err) { errors.push(`${key}：${err.message}`); }
      }
    }
    const { count } = await chatBackup.writeBackup(s.filePath, entries(), { app: `Codex Multi ${app.getVersion()}`, includeCodex });
    return { ok: true, count, file: s.filePath, errors };
  });
  ipcMain.handle('sidebar:list', () => buildSidebar());
  ipcMain.handle('sidebar:sourceProjects', async (_e, source) => sourceProjectCandidates(source));
  ipcMain.handle('sidebar:sourceConversations', async (_e, { source, projectKey }) => sourceConversationCandidates(source, projectKey));
  ipcMain.handle('sidebar:addSourceConversation', async (_e, { source, projectKey, key }) => {
    const candidate = (await sourceConversationCandidates(source, projectKey)).find((c) => c.key === key);
    if (!candidate) throw new Error('找不到這則本機對話，請重新開啟清單');
    await materializeSourceProjects();
    await materializeSourceConversations();
    settings.sidebarSourceProjects[source] = [...new Set([...(settings.sidebarSourceProjects[source] || []), projectKey])];
    settings.sidebarSourceConversations[source] = [...new Set([...(settings.sidebarSourceConversations[source] || []), key])];
    settings.sidebarSources = [...new Set([...(settings.sidebarSources || []), source])];
    saveSettings();
    return { settings: publicSettings(), sidebar: await buildSidebar() };
  });
  ipcMain.handle('sidebar:removeSourceConversation', async (_e, { source, key }) => {
    if (!['codex', 'claude'].includes(source) || typeof key !== 'string') throw new Error('未知的對話來源');
    await materializeSourceProjects();
    await materializeSourceConversations();
    settings.sidebarSourceConversations[source] = (settings.sidebarSourceConversations[source] || []).filter((c) => c !== key);
    const sidebar = await buildSidebar();
    const visibleProjects = new Set(sidebar.items.filter((item) => item.source === source &&
      settings.sidebarSourceConversations[source].includes(item.sourceConversationKey)).map((item) => item.sourceProjectKey));
    settings.sidebarSourceProjects[source] = (settings.sidebarSourceProjects[source] || []).filter((p) => visibleProjects.has(p));
    if (!settings.sidebarSourceProjects[source].length) settings.sidebarSources = (settings.sidebarSources || []).filter((p) => p !== source);
    saveSettings();
    return { settings: publicSettings(), sidebar: await buildSidebar() };
  });
  ipcMain.handle('sidebar:addSourceProject', async (_e, { source, key }) => {
    const choices = await sourceProjectCandidates(source);
    if (!choices.some((p) => p.key === key)) throw new Error('找不到這個本機專案，請重新開啟清單');
    await materializeSourceProjects();
    await materializeSourceConversations();
    settings.sidebarSourceProjects[source] = [...new Set([...(settings.sidebarSourceProjects[source] || []), key])];
    settings.sidebarSourceConversations[source] = [...new Set([...(settings.sidebarSourceConversations[source] || []),
      ...(await sourceConversationCandidates(source, key)).map((c) => c.key)])];
    settings.sidebarSources = [...new Set([...(settings.sidebarSources || []), source])];
    saveSettings();
    return { settings: publicSettings(), sidebar: await buildSidebar() };
  });
  ipcMain.handle('sidebar:removeSourceProject', async (_e, { source, key }) => {
    if (!['codex', 'claude'].includes(source)) throw new Error('未知的對話來源');
    await materializeSourceProjects();
    await materializeSourceConversations();
    settings.sidebarSourceProjects[source] = (settings.sidebarSourceProjects[source] || []).filter((p) => p !== key);
    const removed = new Set((await sourceConversationCandidates(source, key)).map((c) => c.key));
    settings.sidebarSourceConversations[source] = (settings.sidebarSourceConversations[source] || []).filter((c) => !removed.has(c));
    if (!settings.sidebarSourceProjects[source].length) settings.sidebarSources = (settings.sidebarSources || []).filter((p) => p !== source);
    saveSettings();
    return { settings: publicSettings(), sidebar: await buildSidebar() };
  });
  ipcMain.handle('sidebar:removeSource', async (_e, source) => {
    if (!['codex', 'claude'].includes(source)) throw new Error('未知的對話來源');
    await materializeSourceProjects();
    settings.sidebarSourceProjects[source] = [];
    settings.sidebarSourceConversations = { ...(settings.sidebarSourceConversations || {}), [source]: [] };
    settings.sidebarSources = (settings.sidebarSources || []).filter((p) => p !== source);
    saveSettings();
    return { settings: publicSettings(), sidebar: await buildSidebar() };
  });
  ipcMain.handle('sidebar:enableSource', async (_e, source) => {
    if (!['codex', 'claude'].includes(source)) throw new Error('未知的對話來源');
    await materializeSourceProjects();
    await materializeSourceConversations();
    const projects = await sourceProjectCandidates(source);
    settings.sidebarSourceProjects[source] = [...new Set([...(settings.sidebarSourceProjects[source] || []), ...projects.map((p) => p.key)])];
    const conversations = (await Promise.all(projects.map((p) => sourceConversationCandidates(source, p.key)))).flat();
    settings.sidebarSourceConversations[source] = [...new Set([...(settings.sidebarSourceConversations[source] || []), ...conversations.map((c) => c.key)])];
    settings.sidebarSources = [...new Set([...(settings.sidebarSources || []), source])];
    if (source === 'claude') await localClaudeHistory(true);
    saveSettings();
    return buildSidebar();
  });
  ipcMain.handle('sidebar:loadSource', async (_e, source) => {
    if (!['codex', 'claude', 'all'].includes(source)) throw new Error('未知的對話來源');
    if (source === 'claude') {
      settings.loadClaudeSidebar = true; saveSettings();
      await localClaudeHistory(true);
    }
    return buildSidebar();
  });
  const localImports = new Map();
  ipcMain.handle('sidebar:openClaude', async (_e, id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('無效的對話 ID');
    if (!localImports.has(id)) localImports.set(id, (async () => {
      const existing = (await readAllChats()).find(c => c.localSource?.provider === 'claude' && c.localSource.id === id);
      if (existing) return { key: `app:${existing.id}` };
      const session = (await localClaudeHistory()).sessions.find(s => s.id === id);
      const data = await claudeHistory.read(session);
      // Imported history is data, not authorization to operate its recorded project.
      const chat = { ...data, id: newId('claude'), origin: 'app', cwd: '', importedCwd: data.cwd || session.cwd, localSource: { provider: 'claude', id, projectDir: session.projectDir }, lastProvider: 'claude', createdAt: new Date().toISOString(), messages: data.messages.map(m => ({ ...m, id: newId('m'), ts: m.ts || new Date().toISOString() })) };
      await writeChat(chat);
      return { key: `app:${chat.id}` };
    })().finally(() => localImports.delete(id)));
    return localImports.get(id);
  });

  // Hover warms the disposable transcript cache so the following click does not re-read a long rollout.
  const chatPrefetching = new Set();
  ipcMain.handle('chat:prefetch', async (_e, key) => {
    if (typeof key !== 'string' || !/^(?:app:[a-zA-Z0-9_-]+|codex:[a-f0-9-]{36})$/.test(key) || chatPrefetching.has(key) || chatPrefetching.size >= 2) return false;
    chatPrefetching.add(key);
    try { const { chat, threadId } = await resolveChatRef(key); if (threadId) await mergedMessages(chat, threadId); } catch { /* prefetch is best effort */ }
    finally { chatPrefetching.delete(key); }
    return true;
  });
  ipcMain.handle('chat:open', async (_e, key) => {
    const { chat, threadId } = await resolveChatRef(key);
    if (key.startsWith('app:') && !chat) return { error: '找不到這段對話' };
    const { messages, codexCwd, codexError } = await mergedMessages(chat, threadId);
    const hint = threadId ? await findCodexThread(threadId, false) : null;
    let workspace = chat ? (chat.workspace || await chatWorkspace.discover(chat, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'))) : null;
    if (workspace && typeof chat?.originalProject === 'string') workspace = {...workspace, originalProject:chat.originalProject};
    return {
      key,
      chatId: chat ? chat.id : null,
      threadId: threadId || null,
      title: (chat && chat.title) || (hint && hint.title) || '新對話',
      cwd: (chat && chat.cwd) || codexCwd || (hint && hint.cwd) || '',
      messages,
      codexError,
      lastProvider: chat ? chat.lastProvider : (threadId ? 'codex' : null),
      paused: !!chat?.paused,
      importedCwd: (chat && !chat.cwd && chat.importedCwd) || '',
      originalProject: chat?.originalProject,
      workspace,
      extensions: Array.isArray(chat?.extensions) ? chat.extensions : null,
      harnessScript: chat?.harness?.script || '',
      modelPick: chat?.modelPick || null,
      systemPrompt: typeof chat?.systemPrompt === 'string' ? chat.systemPrompt : '',
    };
  });

  // 對話內容搜尋：App 對話與 Codex 執行緒的訊息全文。越新的對話越先找，超過時間預算就先回報已找到的
  ipcMain.handle('chats:cancelSearch', () => { searchGeneration++; });
  ipcMain.handle('chats:search', async (_e, { query = '', limit = 80, budgetMs = 12000, allowedKeys = null } = {}) => {
    const generation = ++searchGeneration;
    const terms = chatSearch.parseQuery(query);
    if (!terms.length) return { results: [], scanned: 0, total: 0, partial: false };
    const started = Date.now();
    const { items } = await buildSidebar();
    const allowed = Array.isArray(allowedKeys) ? new Set(allowedKeys.map(String)) : null;
    const list = items.filter((it) => !it.empty && (!allowed || allowed.has(it.key))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const results = [];
    let scanned = 0, partial = false;
    for (const it of list) {
      if (generation !== searchGeneration || (budgetMs > 0 && Date.now() - started > budgetMs)) { partial = true; break; }
      const stamp = `${it.updatedAt || 0}`;
      let cached = searchCache.get(it.key);
      if (!cached || cached.stamp !== stamp) {
        try {
          const chat = it.chatId ? await readChat(it.chatId) : null;
          const messages = it.kind === 'claude' && !chat
            ? (await claudeHistory.read((await localClaudeHistory()).sessions.find(s => s.id === it.key.slice('localclaude:'.length)))).messages
            : (await mergedMessages(chat, it.threadId)).messages;
          cached = { stamp, messages: messages.map((m) => ({ role: m.role, text: m.text || '', provider: m.provider, source: m.source, ts: m.ts })) };
          searchCache.set(it.key, cached);
        } catch { continue; }
      }
      scanned += 1;
      const found = chatSearch.searchMessages(cached.messages, terms);
      const byTitle = chatSearch.titleMatches(it, terms);
      if (!found.total && !byTitle) continue;
      results.push({ key: it.key, title: it.title, cwd: it.cwd || '', updatedAt: it.updatedAt || 0, archived: !!it.archived, hidden: !!it.hidden, subagent: !!(it.subagent || it.parentKey), titleOnly: !found.total, total: found.total, hits: found.hits });
    }
    // 內文命中的排前面，其次依新舊
    results.sort((a, b) => (a.titleOnly - b.titleOnly) || (b.updatedAt - a.updatedAt));
    return { results: results.slice(0, limit), total: results.length, scanned, of: list.length, partial, terms };
  });

  ipcMain.handle('extensions:list', async () => ({
    packs: extensionsKit.describe(settings),
    enabled: settings.extensions?.enabled || [],
    removed: settings.extensions?.externalSkills ? [] : extensionsKit.BUILTINS.filter(p => (settings.extensions?.removed || []).includes(p.id)).map(p => ({ id: p.id, name: p.name })),
  }));

  ipcMain.handle('extensions:save', async (_e, patch = {}) => {
    const current = settings.extensions || { enabled: [], config: {}, custom: [] };
    const next = { ...current, enabled: [...(current.enabled || [])], config: { ...(current.config || {}) }, custom: [...(current.custom || [])], removed: [...(current.removed || [])] };
    if (Array.isArray(patch.enabled)) next.enabled = [...new Set(patch.enabled.filter((x) => typeof x === 'string'))];
    if (patch.config && typeof patch.config === 'object') {
      for (const [id, cfg] of Object.entries(patch.config)) {
        const validated = {...cfg};
        if (id === 'primeAgent' && Object.hasOwn(validated, 'fallbackModels')) validated.fallbackModels = require('./primeFallback').normalize(validated.fallbackModels);
        if (id === 'primeAgent' && Object.hasOwn(validated, 'fallbackEnabled')) validated.fallbackEnabled = validated.fallbackEnabled === true;
        if (id === 'searxng') {
          if (Object.hasOwn(validated, 'port')) { const n = Math.floor(Number(validated.port)); validated.port = n >= 1024 && n <= 65535 ? n : ''; }
          if (Object.hasOwn(validated, 'url')) validated.url = String(validated.url || '').trim();
          // 網址、埠、安裝位置改了：舊的背景服務在錯的地方，先關掉，下一次搜尋再照新設定啟動
          const old = next.config.searxng || {};
          if (['url', 'port', 'root'].some((k) => Object.hasOwn(validated, k) && String(validated[k] ?? '') !== String(old[k] ?? ''))) require('./searxng').stop();
        }
        next.config[id] = { ...(next.config[id] || {}), ...validated };
      }
    }
    if (patch.addCustom) {
      const c = patch.addCustom;
      const id = `custom_${newId('ext')}`;
      const entry = {
        id,
        name: String(c.name || '自訂 MCP').slice(0, 40),
        prefix: String(c.prefix || c.name || id).slice(0, 30),
        transport: c.transport === 'http' ? 'http' : 'stdio',
        command: String(c.command || ''),
        args: Array.isArray(c.args) ? c.args.map(String) : String(c.args || '').split(' ').filter(Boolean),
        env: c.env && typeof c.env === 'object' ? c.env : {},
        url: String(c.url || ''),
        headers: c.headers && typeof c.headers === 'object' ? c.headers : {},
      };
      if (entry.transport === 'http' ? !entry.url : !entry.command) throw new Error(entry.transport === 'http' ? '請填 MCP 伺服器網址' : '請填要執行的指令');
      next.custom.push(entry);
    }
    if (patch.removeCustom) {
      next.custom = next.custom.filter(c => c.id !== patch.removeCustom);
      delete next.config[patch.removeCustom];
    }
    if (patch.removeBuiltin && extensionsKit.BUILTIN_IDS.has(patch.removeBuiltin)) {
      next.removed = [...new Set([...next.removed, patch.removeBuiltin])];
      next.enabled = next.enabled.filter(id => id !== patch.removeBuiltin);
      next.loadedBuiltins = (next.loadedBuiltins || []).filter(id => id !== patch.removeBuiltin);
    }
    if (patch.restoreBuiltin) next.removed = next.removed.filter(id => id !== patch.restoreBuiltin);
    next.enabled = next.enabled.filter((id) => extensionsKit.BUILTIN_IDS.has(id) || next.custom.some((c) => c.id === id));
    settings.extensions = next;
    saveSettings();
    return { packs: extensionsKit.describe(settings), enabled: next.enabled, removed: next.externalSkills ? [] : extensionsKit.BUILTINS.filter(p => next.removed.includes(p.id)).map(p => ({ id: p.id, name: p.name })) };
  });

  ipcMain.handle('skills:import', async (_e, mode) => {
    if (!['file', 'folder'].includes(mode)) throw new Error('請選擇 skill 檔案或資料夾');
    const defaultPath = settings.extensions?.lastSkillDirectory || path.join(userDir(), 'skill');
    const picked = await dialog.showOpenDialog(win, { title: mode === 'folder' ? '載入 skill 資料夾' : '載入 Markdown skill', defaultPath,
      properties: [mode === 'folder' ? 'openDirectory' : 'openFile'], ...(mode === 'file' ? {filters:[{name:'Markdown skill',extensions:['md']}]} : {}) });
    if (picked.canceled || !picked.filePaths?.[0]) return {cancelled:true};
    const file = picked.filePaths[0];
    const imported = require('./skillStore').importPath(file);
    const current = settings.extensions || {};
    const ids = new Set(imported.builtins);
    const prompts = new Map((current.custom || []).map(entry=>[entry.id,entry]));
    for (const entry of imported.prompts) prompts.set(entry.id,entry);
    settings.extensions = {...current,externalSkills:true,loadedBuiltins:[...new Set([...(current.loadedBuiltins || []),...ids])],
      removed:(current.removed || []).filter(id=>!ids.has(id)),custom:[...prompts.values()],lastSkillDirectory:mode === 'folder' ? file : path.dirname(file)};
    saveSettings();
    return {count:ids.size+imported.prompts.length,ids:[...ids,...imported.prompts.map(p=>p.id)]};
  });

  ipcMain.handle('extensions:import', async () => {
    const picked = await dialog.showOpenDialog(win, { title: '載入 MCP 擴充設定（JSON）', properties: ['openFile'], filters: [{ name: 'MCP 設定', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePaths?.[0]) return { cancelled: true };
    const file = picked.filePaths[0];
    if ((await fsp.stat(file)).size > 1024 * 1024) throw new Error('設定檔超過 1 MB');
    const entries = require('./extensionImport').parse(await fsp.readFile(file, 'utf8'));
    const current = settings.extensions || {};
    settings.extensions = { ...current, custom: [...(current.custom || []), ...entries.map(c => ({ ...c, id: `custom_${newId('ext')}` }))] };
    saveSettings();
    return { count: entries.length };
  });

  // 檢查某個擴充能不能真的連上（會實際啟動一次再關掉）
  // SearXNG：下載原始碼、建 Python 環境、裝套件、試跑；過程逐行送回設定畫面
  let searxngInstalling = null;
  ipcMain.handle('searxng:install', async (e) => {
    if (searxngInstalling) throw new Error('SearXNG 正在安裝中，請等它跑完。');
    const cfg = (settings.extensions?.config || {}).searxng || {};
    const send = (line) => { try { e.sender.send('searxng:log', String(line).slice(0, 400)); } catch { /* 視窗已關 */ } };
    searxngInstalling = require('./searxng').install(cfg, { onLog: send });
    try { return await searxngInstalling; }
    finally { searxngInstalling = null; }
  });
  ipcMain.handle('searxng:open', async () => {
    const cfg = (settings.extensions?.config || {}).searxng || {};
    const base = await require('./searxng').ensure(cfg);
    await shell.openExternal(base);
    return base;
  });

  ipcMain.handle('extensions:test', async (_e, id) => {
    const pack = extensionsKit.allPacks(settings).find((x) => x.id === id);
    if (!pack) throw new Error('找不到這個擴充');
    if (pack.kind === 'prompt') return {ok:true,message:'Markdown 提示已載入；勾選後只套用這段對話，不會自動執行檔案中的程式碼。'};
    if (pack.kind === 'searxng') {
      try { return await require('./searxng').test((settings.extensions?.config || {})[id] || {}); }
      catch (error) { return { ok: false, message: error.message }; }
    }
    if(pack.kind==='scriptDoctor') {
      const data=require('./scriptDoctor').health();
      return {ok:data.ok,message:data.ok?'Script Doctor 工具鏈已內建（純 JavaScript，Fountain 檢查自我測試通過）；寫作模型沿用目前對話。':'Script Doctor 的 Fountain 檢查自我測試沒有通過。'};
    }
    if(pack.kind==='harness') {
      const data=require('./harness').health();const n=require('./harness').list(path.join(userDir(),'harness'));
      return {ok:data.ok,message:data.ok?`自訂 Harness 已內建（純 JavaScript，4 份範本解析通過）；腳本資料夾有 ${n.length} 份腳本，其中 ${n.filter(x=>!x.ok).length} 份格式有錯。模型沿用目前對話。`:'範本解析自我測試沒有通過。'};
    }
    if(pack.kind==='companion') {
      const data=require('./companion').health();
      return {ok:data.ok,message:data.ok?'陪伴角色已內建（純 JavaScript；記憶寫入、時間線與口吻檢查自我測試通過）；模型沿用目前對話。':'陪伴角色的自我測試沒有通過。'};
    }
    if(pack.kind==='ragthoven') {
      try {const data=JSON.parse(await require('./ragthoven').execute({health:true},{pythonPath:settings.extensions?.config?.[id]?.path,timeoutMs:15000}));return {ok:data.ok,message:`RAGthoven 工具鏈載入成功，${data.corpus_entries} 筆靈感資料；寫作模型沿用目前對話。`};}
      catch(error){return {ok:false,message:error.message};}
    }
    if (pack.kind === 'prime') {
      const cfg = (settings.extensions?.config || {})[id] || {};
      if(cfg.mode!=='native') return {ok:true,message:'已設定為沿用目前對話的模型與登入方式（工作台代理引擎）；實際模型以送出任務時的對話選擇為準，不呼叫 Anthropic 預設 API。'};
      const status = pack.detect(cfg);
      if (!status.available) return { ok: false, message: status.note };
      // 真的啟動一次 RPC，順便確認它拿得到金鑰、選得到模型
      const auth = extensionsKit.primeAuth(cfg, extensionApiKeys());
      let session;
      try {
        session = require('./primeAgent').createSession({ bin: status.path, cwd: settings.defaultCwd || undefined, provider: auth.provider, model: cfg.model || '', env: auth.env });
        const r = await session.command('get_state', {}, { timeoutMs: 60000 });
        const m = r?.data?.model || {};
        const ready = m.provider && m.provider !== 'unknown';
        return {
          ok: true,
          message: ready
            ? `已連線：${status.path}\n使用模型：${m.provider}／${m.id}`
            : `已連線：${status.path}\n但還沒有可用的模型——請在「API 設定」填好 Claude／Gemini／DeepSeek／OpenAI 其中一組金鑰，Prime Agent 會沿用它。`,
        };
      } catch (e) {
        return { ok: false, message: `啟動失敗：${e.message}` };
      } finally { try { session?.close(); } catch { /* 已結束 */ } }
    }
    const session = await extensionsKit.openSession({ settings, selection: [id], cwd: settings.defaultCwd || '', version: app.getVersion(), apiKeys: extensionApiKeys(), sessionRoot: path.join(userDir(), 'extensions', '_test') });
    try {
      if (!session.active.length) return { ok: false, message: session.notices.join('\n') || '連線失敗' };
      const names = session.tools.map((t) => t.function.name).slice(0, 12).join('、');
      return { ok: true, message: `連線成功，提供 ${session.tools.length} 個工具：${names}` };
    } finally { session.close(); }
  });

  // 設定畫面要列「Prime Agent 真的載入了哪些模型」：只有設好金鑰的供應商才會有東西。
  ipcMain.handle('extensions:primeModels', async () => {
    try {
      const r = await extensionsKit.primeModels(settings, extensionApiKeys(), settings.defaultCwd || '');
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, message: e.message, models: [], providers: [] };
    }
  });

  // 自訂 Harness：腳本就是 userData/harness 裡的 .txt，這裡提供列表、讀寫、改名、刪除（移到「已刪除」）、還原、載入、另存
  const harnessRoot = () => path.join(userDir(), 'harness');
  const harnessKit = () => require('./harness');
  ipcMain.handle('harness:list', async () => ({ scripts: harnessKit().list(harnessRoot()), trash: harnessKit().listTrash(harnessRoot()), root: harnessRoot(), defaultScript: (settings.extensions?.config?.harness || {}).defaultScript || '' }));
  ipcMain.handle('harness:read', async (_e, file) => { const r = harnessKit().read(harnessRoot(), String(file || '')); return { file: r.file, path: r.path, text: r.text, ok: r.script.ok, errors: harnessKit().describeErrors(r.script), steps: r.script.steps.map((x) => ({ name: x.name, type: harnessKit().TYPE_LABEL[x.type] })) }; });
  ipcMain.handle('harness:validate', async (_e, text) => { const sc = harnessKit().parse(String(text || '')); return { ok: sc.ok, errors: harnessKit().describeErrors(sc), warnings: sc.warnings.map((w) => `${w.line ? `第 ${w.line} 行：` : ''}${w.message}`), name: sc.name, steps: sc.steps.map((x) => ({ name: x.name, type: harnessKit().TYPE_LABEL[x.type] })) }; });
  ipcMain.handle('harness:save', async (_e, { file, text, overwrite = true }) => harnessKit().save(harnessRoot(), String(file || ''), String(text || ''), { overwrite: overwrite !== false }));
  ipcMain.handle('harness:create', async (_e, { name, template } = {}) => {
    const kit = harnessKit();
    const base = kit.TEMPLATES.find((t) => t.file === template) || kit.TEMPLATES[0];
    const title = String(name || '').trim() || '我的腳本';
    const text = base.text.replace(/^【名稱】.*$/m, `【名稱】${title}`);
    return kit.save(harnessRoot(), title, text, { overwrite: false });
  });
  ipcMain.handle('harness:rename', async (_e, { from, to }) => {
    const r = harnessKit().rename(harnessRoot(), String(from || ''), String(to || ''));
    const cfg = settings.extensions?.config?.harness;
    if (cfg && cfg.defaultScript === harnessKit().safeName(from)) { cfg.defaultScript = r.file; saveSettings(); }
    return r;
  });
  ipcMain.handle('harness:remove', async (_e, file) => {
    const name = harnessKit().safeName(String(file || ''));
    const res = await dialog.showMessageBox(win, { type: 'warning', buttons: ['刪除', '取消'], defaultId: 1, cancelId: 1, message: `要刪除腳本「${name}」嗎？`, detail: '檔案會移到腳本資料夾裡的「已刪除」資料夾，之後可以在管理畫面按「還原」救回來。' });
    if (res.response !== 0) return { cancelled: true };
    const r = harnessKit().remove(harnessRoot(), name);
    const cfg = settings.extensions?.config?.harness;
    if (cfg && cfg.defaultScript === name) { cfg.defaultScript = ''; saveSettings(); }
    return r;
  });
  ipcMain.handle('harness:restore', async (_e, entry) => harnessKit().restore(harnessRoot(), String(entry || '')));
  ipcMain.handle('harness:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: '載入 Harness 腳本（TXT）', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Harness 腳本', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths.length) return { cancelled: true };
    return { files: r.filePaths.map((p) => { try { return harnessKit().importFile(harnessRoot(), p); } catch (e) { return { file: path.basename(p), ok: false, errors: [e.message] }; } }) };
  });
  ipcMain.handle('harness:export', async (_e, { file, text }) => {
    const name = harnessKit().safeName(String(file || '腳本'));
    const r = await dialog.showSaveDialog(win, { title: '另存 Harness 腳本', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: '文字檔', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return { cancelled: true };
    const body = typeof text === 'string' ? text : harnessKit().read(harnessRoot(), name).text;
    await fsp.writeFile(r.filePath, '\uFEFF' + body.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n'), 'utf8');
    return { ok: true, file: r.filePath };
  });
  ipcMain.handle('harness:open', async (_e, { file = '', reveal = false } = {}) => {
    const root = harnessRoot();
    harnessKit().ensureTemplates(root);
    if (!file) return shell.openPath(root);
    const p = harnessKit().read(root, String(file)).path;
    if (reveal) { shell.showItemInFolder(p); return ''; }
    return shell.openPath(p);
  });

  // 陪伴角色：設定畫面查看她記得的事與關係狀態、清除記憶重來
  const companionCfg = () => (settings.extensions?.config || {}).companion || {};
  ipcMain.handle('companion:inspect', async () => {
    const kit = require('./companion');
    const cfg = companionCfg();
    const info = kit.inspect(path.join(userDir(), 'companion'), cfg.characterId || 'default', { name: String(cfg.name || '').trim() || undefined });
    return { ...info, text: info.exists ? kit.describeText(info) : `${info.name} 還沒跟你聊過。在對話的「能力擴充」勾選「長期陪伴角色」後送出訊息就會開始。` };
  });
  // 編輯角色與提示詞（只動人物設定，不動記憶與關係）
  const companionArgs = () => { const cfg = companionCfg(); return [path.join(userDir(), 'companion'), cfg.characterId || 'default', { name: String(cfg.name || '').trim() || undefined }]; };
  // 名字以角色檔為準：在 persona.txt 或編輯器改了名字，擴充設定裡的名字也跟著換
  const syncCompanionName = (name) => {
    if (!name || name === String(companionCfg().name || '').trim()) return;
    settings.extensions = settings.extensions || {};
    settings.extensions.config = settings.extensions.config || {};
    settings.extensions.config.companion = { ...(settings.extensions.config.companion || {}), name };
    saveSettings();
  };
  // 打開編輯器時順便確保 persona.txt 存在（剛升級、還沒聊過也有檔案可以開）
  ipcMain.handle('companion:getProfile', async () => { const [root, id, opts] = companionArgs(); const r = await require('./companion').ensurePersonaFile(root, id, opts); syncCompanionName(r.name); return r; });
  ipcMain.handle('companion:openFile', async (_e, { reveal = false } = {}) => {
    const [root, id, opts] = companionArgs();
    const r = await require('./companion').ensurePersonaFile(root, id, opts);
    if (reveal) { shell.showItemInFolder(r.personaFile); return { ok: true, file: r.personaFile }; }
    const err = await shell.openPath(r.personaFile);
    if (err) throw new Error(`打不開 ${r.personaFile}：${err}`);
    return { ok: true, file: r.personaFile };
  });
  ipcMain.handle('companion:saveProfile', async (_e, patch = {}) => {
    const [root, id, opts] = companionArgs();
    const r = await require('./companion').saveEditable(root, id, patch, opts);
    syncCompanionName(r.name); // 名字也存在擴充設定裡，兩邊要一致
    return r;
  });
  ipcMain.handle('companion:resetProfile', async () => {
    const r0 = await dialog.showMessageBox(win, { type: 'warning', buttons: ['還原預設', '取消'], defaultId: 1, cancelId: 1, title: '還原角色設定',
      message: '要把人物設定與提示詞全部還原成預設嗎？', detail: '只還原設定；她記得的事、你們的關係與時間線都會保留。' });
    if (r0.response !== 0) return { cancelled: true };
    const [root, id, opts] = companionArgs();
    return require('./companion').resetEditable(root, id, opts);
  });
  // 人物設定與 Prompt 用 .txt 存檔／載入（載入只把內容填進編輯器，按儲存才生效）
  const scenarioLabels = () => require('./companionPersona').SCENARIO_LABELS;
  // 另存一份 TXT（角色本身已經存在 persona.txt，這裡是存一份到別的地方）
  // patch：分欄編輯器上的內容（連同她目前記得的事一起存）；text：全文編輯器上的整份文字（照原樣存）
  ipcMain.handle('companion:exportText', async (_e, patch = {}, text = null) => {
    const name = String(patch.name || '陪伴角色').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 20) || '陪伴角色';
    const r = await dialog.showSaveDialog(win, { title: '把角色、Prompt 與她記得的事存成文字檔', defaultPath: path.join(app.getPath('documents'), `${name}-角色與記憶.txt`), filters: [{ name: '文字檔', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return { cancelled: true };
    const [root, id, opts] = companionArgs();
    // \u6587\u5B57\u6846\u7684\u63DB\u884C\u4E00\u5F8B\u662F \n\uFF1A\u5B58\u6A94\u6642\u63DB\u56DE \r\n\uFF0C\u820A\u7248\u8A18\u4E8B\u672C\u624D\u4E0D\u6703\u64E0\u6210\u4E00\u884C
    const body = typeof text === 'string' ? '\uFEFF' + text.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n') : require('./companion').exportFullText(root, id, patch, opts);
    fs.writeFileSync(r.filePath, body, 'utf8');
    return { ok: true, file: r.filePath };
  });
  // 全文編輯：整份角色檔（人物、Prompt、她記得的事）一次讀、一次存
  ipcMain.handle('companion:getFullText', async () => { const [root, id, opts] = companionArgs(); return require('./companion').getFullText(root, id, opts); });
  ipcMain.handle('companion:saveFullText', async (_e, text) => {
    const [root, id, opts] = companionArgs();
    const r = await require('./companion').saveFullText(root, id, String(text || ''), opts);
    syncCompanionName(r.name);
    return r;
  });
  // 載入：.txt 為主；1.9.15～1.9.16 另存的 HTML 表格也還讀得懂
  ipcMain.handle('companion:importText', async () => {
    const r = await dialog.showOpenDialog(win, { title: '選擇角色與 Prompt 的文字檔', properties: ['openFile'], filters: [{ name: '文字檔', extensions: ['txt'] }, { name: '舊版 HTML 表格', extensions: ['html', 'htm'] }, { name: '所有檔案', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    const parsed = require('./companionText').parseAny(fs.readFileSync(r.filePaths[0]), { scenarioLabels: scenarioLabels() });
    return { ok: true, file: r.filePaths[0], ...parsed };
  });
  ipcMain.handle('companion:preview', async (_e, userText) => { const [root, id, opts] = companionArgs(); return require('./companion').previewPrompt(root, id, { ...opts, userText: String(userText || '').trim() || undefined }); });
  ipcMain.handle('companion:reset', async () => {
    const cfg = companionCfg();
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['清除並重來', '取消'], defaultId: 1, cancelId: 1, title: '清除陪伴角色的記憶',
      message: '要清除她的所有記憶、關係與時間線，從剛認識重新開始嗎？', detail: '舊資料會改名保留成備份資料夾（companion 資料夾內），不會直接刪除。' });
    if (r.response !== 0) return { ok: false, cancelled: true };
    return require('./companion').reset(path.join(userDir(), 'companion'), cfg.characterId || 'default');
  });

  ipcMain.handle('chats:organizeWorkspaces', async () => {
    const rows = await sidebarMetadata.list();
    const visible = new Set((await buildSidebar()).items.filter(item => !item.hidden && !item.archived && !item.subagent).map(item => item.key));
    const results = [], errors = [];
    for (const row of rows) {
      const keys = [`app:${row.id}`, ...(row.codexThreadId ? [`codex:${row.codexThreadId}`] : [])];
      if (row.parentKey || row.subagent || row.hidden || row.agent || !keys.some(key => visible.has(key)) || keys.some(key => (settings.hiddenKeys || []).includes(key)) || (settings.removedProjects || []).some(dir => normDir(dir) === normDir(row.originalProject || row.cwd || '')) || /[\\/]trash(?:[\\/]|$)/i.test(row.cwd || '')) continue;
      try { results.push(await chatWorkspace.organize(row, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'))); }
      catch(e) { errors.push({id:row.id,message:e.message}); }
    }
    const index = path.join(userDir(), 'chat-workspaces-index.json'), temporary = index + '.' + crypto.randomUUID() + '.tmp';
    await fsp.writeFile(temporary, JSON.stringify({version:1,results,errors},null,2), {encoding:'utf8',flag:'wx'});
    await require('./atomicRename').replace(temporary, index);
    return {created:results.length,errors};
  });
  ipcMain.handle('chat:organizeWorkspace', async (_e, { key, use = false }) => {
    if (use && [...running.values()].some(r => r.key === key)) throw new Error('Stop this conversation before changing its workspace');
    const { chat } = await resolveChatRef(key);
    if (!chat) throw new Error('Save this conversation in the App first');
    const workspace = await chatWorkspace.organize(chat, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'));
    if (use) { chat.workspace = workspace; chat.originalProject = workspace.originalProject; chat.cwd = workspace.path; require('./chatLive').remember(chat.id, {workspace, originalProject:workspace.originalProject}); await writeChat(chat); }
    return workspace;
  });
  ipcMain.handle('chat:create', async (_e, { cwd, title, autoWorkspace, extensions, harnessScript, systemPrompt }) => {
    const chat = { id: newId('chat'), origin: 'app', title: String(title || '').trim().slice(0, 80), cwd: cwd ?? settings.defaultCwd ?? '', codexThreadId: null, messages: [], extensions: extensionsKit.selectionFor(settings, Array.isArray(extensions) ? extensions : []), createdAt: new Date().toISOString(), lastProvider: null };
    if (autoWorkspace === true || (autoWorkspace !== false && settings.autoChatWorkspace !== false)) {
      chat.workspace = await chatWorkspace.organize(chat, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'));
      chat.originalProject = chat.workspace.originalProject;
      chat.cwd = chat.workspace.path;
    }
    if (typeof harnessScript === 'string' && harnessScript) chat.harness = { script: harnessScript };
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) chat.systemPrompt = systemPrompt.trim().slice(0, 20000);
    await writeChat(chat);
    return { key: `app:${chat.id}`, chatId: chat.id };
  });

  ipcMain.handle('chat:update', async (_e, { key, title, cwd, projectCwd, extensions, harnessScript, modelPick, systemPrompt }) => {
    // 只改擴充勾選（或 Harness 腳本）時不必停下來：這次執行用的是送出當下的設定，改的是下一次
    const onlyExtensions = (extensions !== undefined || harnessScript !== undefined || modelPick !== undefined || systemPrompt !== undefined || projectCwd !== undefined) && title === undefined && cwd === undefined;
    if (projectCwd !== undefined && (typeof projectCwd !== 'string' || (projectCwd && !path.isAbsolute(projectCwd)))) throw Error('專案資料夾必須是完整路徑');
    if (!onlyExtensions && [...running.values()].some(r => r.key === key)) throw new Error('這段對話正在執行，請先暫停再更換專案');
    let { chat, threadId } = await resolveChatRef(key);
    const hadChat = !!chat;
    if (!chat) {
      if (!threadId) return { error: '找不到對話' };
      chat = { id: newId('cx'), origin: 'codex', title: '', cwd: '', codexThreadId: threadId, messages: [], createdAt: new Date().toISOString(), lastProvider: 'codex' };
    }
    if (typeof title === 'string') chat.title = title.trim();
    if (typeof cwd === 'string') { chat.cwd = cwd; delete chat.workspace; delete chat.originalProject; }
    if (extensions !== undefined) chat.extensions = Array.isArray(extensions) ? extensionsKit.selectionFor(settings, extensions) : null;
    if (typeof harnessScript === 'string') chat.harness = harnessScript ? { script: harnessScript } : undefined;
    if (typeof systemPrompt === 'string') chat.systemPrompt = systemPrompt.trim().slice(0, 20000) || undefined;
    // 這段對話最後選的供應商、模型與推理強度：切回來時照這份還原
    if (modelPick && typeof modelPick === 'object' && typeof modelPick.provider === 'string') chat.modelPick = require('./wangpinPlan').mergeModelPick(chat.modelPick,modelPick);
    // 記下使用者最新的設定：這段對話若正在跑，回合收尾寫回存檔時要用這份

    // 只記模型選擇時不更新時間，側欄順序不會因為切換模型而跳動
    const metadataFields = [
      typeof title === 'string' && 'title', typeof cwd === 'string' && 'cwd', typeof cwd === 'string' && 'workspace', typeof cwd === 'string' && 'originalProject', extensions !== undefined && 'extensions',
      typeof harnessScript === 'string' && 'harness',
      typeof systemPrompt === 'string' && 'systemPrompt', modelPick && typeof modelPick.provider === 'string' && 'modelPick'
    ].filter(Boolean);
    if (typeof projectCwd === 'string') metadataFields.push('originalProject', 'workspace');
    chat = await queueChatWrite(chat.id, async () => {
      let latest;
      try { latest = JSON.parse(await fsp.readFile(chatPath(chat.id),'utf8')); }
      catch(error) { if (error.code !== 'ENOENT') throw error; if (hadChat) throw Error('這段對話已移除'); latest = {...chat}; }
      if (typeof projectCwd === 'string' && !latest.workspace) {
        const discovered = await chatWorkspace.discover(latest, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'));
        if (discovered) latest.workspace = discovered;
      }
      for (const field of metadataFields) {
        if (typeof projectCwd === 'string' && field === 'originalProject') latest.originalProject = projectCwd;
        else if (typeof projectCwd === 'string' && field === 'workspace') { if (latest.workspace) latest.workspace = {...latest.workspace, originalProject:projectCwd}; }
        else if (field === 'modelPick') latest.modelPick = require('./wangpinPlan').mergeModelPick(latest.modelPick,modelPick);
        else if (chat[field] === undefined) delete latest[field];
        else latest[field] = chat[field];
      }
      // Remember merged metadata within the serialized write queue.
      require('./chatLive').remember(latest.id, Object.fromEntries(metadataFields.map(field => [field, latest[field]])));
      await persistChat(latest,{keepTime:(modelPick !== undefined || systemPrompt !== undefined) && extensions === undefined && harnessScript === undefined && title === undefined && cwd === undefined});
      return latest;
    });
    return { ok: true, originalProject:chat.originalProject, workspace:chat.workspace || null, extensions: Array.isArray(chat.extensions) ? chat.extensions : null, harnessScript: chat.harness?.script || '' };
  });

  ipcMain.handle('chat:editBranch', async (_e, { key, messageId, text }) => {
    if ([...running.values()].some(r => r.key === key)) throw new Error('請先暫停這段對話再編輯');
    if (typeof text !== 'string' || !text.trim()) throw new Error('請輸入修改後的內容');
    const { chat, threadId } = await resolveChatRef(key);
    const { messages, codexCwd } = await mergedMessages(chat,threadId);
    const index = messages.findIndex(m => m.id === messageId && m.role === 'user');
    if (index < 0) throw new Error('找不到要編輯的訊息，請重新開啟對話');
    const original = messages[index];
    const branch = { id:newId('chat'), origin:'app', title:(chat?.title || '對話')+'（編輯分支）', cwd:chat?.cwd ?? codexCwd, messages:messages.slice(0,index).map(m => ({...m,id:newId('m'),source:'app'})), createdAt:new Date().toISOString(), editedFrom:{key,messageId} };
    const items = (original.attachments || []).map(a => a.mime?.startsWith('image/') && a.data && !a.path ? attachments.stageImage(Buffer.from(a.data,'base64'),path.join(userDir(),'attachments'),a.name) : ({...a,id:newId('attachment')}));
    for (const item of items) stagedAttachments.set(item.id,item);
    await writeChat(branch);
    return { key:`app:${branch.id}`, text:text.trim(), items:items.map(({id,name,mime,size})=>({id,name,mime,size})) };
  });
  ipcMain.handle('chat:delete', (_e, key) => permanentlyRemoveConversation(String(key)));

  // Codex 的模型清單：models_cache.json 是 CLI 自己寫的，但伺服器依 CLI 版本決定給哪些模型，
  // 而且只有 CLI 執行時才會更新。快取是舊版 CLI 拿的或放太久（新模型剛推出時就會少掉），
  // 就用 app-server 的 model/list 向伺服器重新要一次。失敗時照舊用快取。
  let codexModelsRefreshAt = 0;
  let codexLatestCli = null;
  ipcMain.handle('codex:models', async (_e, { refresh = false } = {}) => {
    const cached = await codexStore.readCodexModels(settings.codexHome);
    const ver = await codexRunner.codexVersion(settings.providers.codex.path).catch(() => null);
    const cliVersion = ver && ver.ok ? ((ver.message || '').match(/\d+\.\d+\.\d+/) || [''])[0] : '';
    let out = { ...cached, cliVersion };
    const due = refresh ? Date.now() - codexModelsRefreshAt > 15000 : codexStore.codexModelsStale(cached, cliVersion) && Date.now() - codexModelsRefreshAt > 120000;
    if (ver && ver.ok && due) {
      codexModelsRefreshAt = Date.now();
      try {
        const [r] = await codexAccountCall(settings.providers.codex.path, settings.codexHome, [['model/list', {}]], 45000);
        const models = codexStore.modelsFromAppServer(r);
        if (models.length) out = { ...out, models, source: 'server', fetchedAt: Date.now(), clientVersion: cliVersion };
      } catch (e) { out.refreshError = String(e.message || e).slice(0, 200); }
    }
    // 順便看 npm 上有沒有更新的 Codex CLI（新模型常常要新版 CLI 才拿得到）；一小時查一次
    if (cliVersion && (!codexLatestCli || Date.now() - codexLatestCli.at > 3600000)) {
      try {
        const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', { signal: AbortSignal.timeout(6000) });
        if (res.ok) codexLatestCli = { at: Date.now(), version: String((await res.json()).version || '') };
      } catch { /* 沒網路就不提示 */ }
    }
    if (codexLatestCli && codexLatestCli.version && cliVersion && newerVersion(codexLatestCli.version, cliVersion)) out.cliUpdate = codexLatestCli.version;
    return out;
  });
  ipcMain.handle('claude:models', async (_e, force) => {
    if (claudeModelsCache && !force) return claudeModelsCache;
    const identity = claudeIdentity;
    const cfg = { ...settings.providers.claude };
    let result;
    try {
      const [r] = await claudeCode.control(cfg.claudePath, [{ subtype: 'list_models' }], 25000, await ensureClaudeConfig(cfg));
      result = { models: (r.models || []).map((m) => ({ slug: m.value, name: m.displayName, desc: m.description, resolved: m.resolvedModel, efforts: m.supportedEffortLevels || [] })) };
    } catch (err) {
      result = { models: [], error: String(err.message || err) };
    }
    if (identity !== claudeIdentity) return { models: [], error: 'Claude 帳號已切換；請重新讀取模型清單。' };
    if (result.models.length) claudeModelsCache = result;
    return result;
  });
  ipcMain.handle('gptweb:view', event => { assertGptSender(event); return { ok: true, embedded: false }; });
  ipcMain.handle('gptweb:accounts', async event => { assertGptSender(event); return syncGptAccountSelection(await gptAccountStore().list()); });
  for (const action of ['switch', 'remove', 'rename']) ipcMain.handle(`gptweb:account:${action}`, async (event, arg) => {
    assertGptSender(event); return syncGptAccountSelection(await gptAccountStore()[action](arg));
  });
  ipcMain.handle('gptweb:status', async event => {
    assertGptSender(event); const account = await gptAccountStore().active();
    if(settings.webWebsiteHttpOnly===true){const result=await websiteHttpClient('gpt',{accountId:account?.id||'default'}).status();return {...result,message:'網站帳號 HTTP 已連線'};}
    if (!account) return { ok: false, message: '尚未登入 ChatGPT 帳號；請在「連線」選單登入。' };
    return require('./chatgptWeb').status({ profileDir: account.profileDir, bravePath: settings.browser?.path || '' });
  });
  ipcMain.handle('gptweb:cancelLogin', event => { assertGptSender(event); gptLoginController?.abort(); return { ok: true }; });
  ipcMain.handle('gptweb:login', async (event, opts = {}) => {
    assertGptSender(event);
    if (gptLoginController) throw new Error('ChatGPT 登入視窗已開啟，請先完成或取消。');
    gptLoginController = new AbortController();
    try {
      const current = await gptAccountStore().active();
      const id = opts.newAccount ? undefined : (opts.id || current?.id);
      gptLoginAccountId = id || null;
      const result = await gptAccountStore().login({ id, name: opts.name, signal: gptLoginController.signal });
      if (result.ok) syncGptAccountSelection(result);
      return result;
    } finally { gptLoginController = null; gptLoginAccountId = null; }
  });
  ipcMain.handle('gptweb:models', async (event, opts = {}) => {
    assertGptSender(event);
    if(settings.webWebsiteHttpOnly===true){const rows=await websiteHttpClient('gpt').listModels();return {models:rows.map(row=>({slug:row.id,title:row.label})),efforts:[]};}
    const account = await gptAccountStore().active();
    if (!account) throw new Error('請先在「連線」選單登入 ChatGPT 帳號。');
    if (gptLoginAccountId === account.id) throw new Error('這個帳號正在登入，請完成後再讀取模型。');
    const r = await require('./chatgptWeb').listModels({ model: String(opts.model || ''), profileDir: account.profileDir, importExistingLogin: false, bravePath: settings.browser?.path || '' });
    if ((await gptAccountStore().active())?.id !== account.id) return r;
    settings.providers.gpt.webModels = r.models.map((m) => ({ slug: m.slug, title: m.title, description: m.description }));
    settings.providers.gpt.webModelsAt = new Date().toISOString();
    settings.providers.gpt.webPickerVersion = 2;
    settings.providers.gpt.webEfforts = r.efforts || [];
    settings.providers.gpt.webEffortModel = r.effortModel;
    if (settings.providers.gpt.webModel && !r.models.some(m => m.slug === settings.providers.gpt.webModel)) settings.providers.gpt.webModel = '';
    saveSettings();
    return r;
  });
  ipcMain.handle('claude:detect', () => claudeCode.claudeVersion(settings.providers.claude.claudePath));
  ipcMain.handle('claudeAccounts:list', (_e, opts) => claudeAccountStore().list(opts));
  const loginClaudeAccount = (e, opts = {}) => claudeAccountStore().login({ ...opts, onURL: url => { if (!e.sender.isDestroyed()) e.sender.send('claude:authURL', url); } });
  ipcMain.handle('claudeAccounts:create', e => loginClaudeAccount(e));
  ipcMain.handle('claudeAccounts:login', (e, opts) => loginClaudeAccount(e, opts));
  ipcMain.handle('claudeAccounts:rename', (_e, opts) => claudeAccountStore().rename(opts));
  ipcMain.handle('claudeAccounts:remove', (_e, id) => claudeAccountStore().remove(id));
  ipcMain.handle('claudeAccounts:switch', (_e, id) => claudeAccountStore().switch(id));
  ipcMain.handle('claude:authStatus', async () => claudeCode.authStatus(settings.providers.claude.claudePath, await ensureClaudeConfig(settings.providers.claude)));
  ipcMain.handle('claude:loginCode', (_e, code) => claudeCode.submitLoginCode(code));
  ipcMain.handle('claude:cancelLogin', () => claudeAccountStore().cancelLogin());
  ipcMain.handle('claude:login', async e => {
    const list = await claudeAccountStore().list();
    return loginClaudeAccount(e, { id: list.accounts.find(a => a.active)?.id });
  });
  // 桌面版登入沿用：只檢查，不寫檔
  ipcMain.handle('claude:desktopStatus', () => claudeDesktopAuth.status());
  // 桌面版登入沿用：把桌面版的 token 匯入 CLI 讀得到的 .credentials.json
  ipcMain.handle('claude:importDesktop', async () => {
    const configured = (settings.providers.claude.configDir || '').trim();
    const selectionToken = claudeAccountStore().selectionToken();
    const root = path.join(userDir(), 'claude-accounts');
    const configDir = path.join(root, crypto.randomUUID());
    await fsp.mkdir(root, { recursive: true });
    const ownedRoot = await fsp.realpath(root);
    try {
      const result = await claudeDesktopAuth.importDesktopLogin(configDir);
      const adopted = claudeAccountStore().adopt({ configDir, label: 'Claude 桌面版帳號', source: 'desktop', plan: result.subscriptionType, selectionToken });
      return { ...result, switched: adopted.switched, fallbackDefault: !configured };
    } catch (err) {
      try {
        const registered = (settings.claudeAccounts || []).some(a => normDir(a.configDir) === normDir(configDir));
        const stat = await fsp.lstat(configDir), real = await fsp.realpath(configDir);
        if (!registered && !stat.isSymbolicLink() && normDir(real) === normDir(path.join(ownedRoot, path.basename(configDir)))) await fsp.rm(configDir, { recursive: true, force: true });
      } catch { /* Failed imports may not have created the staging directory. */ }
      return { ok: false, message: String((err && err.message) || err), configDir };
    }
  });

  // 側欄右鍵選單（Windows 原生選單）
  ipcMain.handle('sidebar:menu', (e, item) => new Promise((resolve) => {
    let chosen = null;
    const pick = (id) => () => { chosen = id; };
    const tpl = [
      { label: '開啟', click: pick('open') },
      { label: '重新命名', click: pick('rename'), enabled: !item.key.startsWith('localclaude:') },
      { label: item.pinned ? '取消釘選' : '釘選', click: pick('pin'), enabled: !item.key.startsWith('localclaude:') },
      { type: 'separator' },
    ];
    if (item.threadId) tpl.push({ label: '在 Codex App 開啟', click: pick('openCodex') });
    if (item.cwd) tpl.push({ label: '開啟專案資料夾', click: pick('openFolder') });
    tpl.push({ label: '在檔案總管顯示紀錄檔', click: pick('showLog') });
    tpl.push({ type: 'separator' });
    const copy = [];
    if (item.threadId) {
      copy.push({ label: '複製 Codex 連結（codex://threads/…）', click: pick('copyLink') });
      copy.push({ label: '複製工作 ID（執行緒 ID）', click: pick('copyId') });
    } else if (item.key.startsWith('app:')) {
      copy.push({ label: '複製對話 ID', click: pick('copyChatId') });
    } else if (item.key.startsWith('localclaude:')) {
      copy.push({ label: '複製 Claude Code 工作階段 ID', click: pick('copyClaudeId') });
    }
    if (item.cwd) copy.push({ label: '複製專案資料夾路徑', click: pick('copyCwd') });
    copy.push({ label: '複製對話紀錄檔路徑', click: pick('copyLog') });
    tpl.push({ label: '複製', submenu: copy });
    tpl.push({ label: '移到其他專案…', click: pick('move'), enabled: !item.key.startsWith('localclaude:') });
    tpl.push({ label: '備份這段對話…', click: pick('backup') });
    tpl.push({ type: 'separator' });
    if (['codex', 'claude'].includes(item.source)) tpl.push({ label: '從側欄移除這則對話', click: pick('removeSourceConversation') });
    if (item.hidden) tpl.push({ label: '放回側欄', click: pick('unhide') });
    tpl.push({ label: '永久刪除…', click: pick('delete'), enabled: !item.key.startsWith('localclaude:') });
    const menu = Menu.buildFromTemplate(tpl);
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(chosen), 60) });
  }));

  // 改名：Codex 執行緒用官方 app-server 改，Codex App 也會看到新名字
  ipcMain.handle('sidebar:rename', async (_e, { key, threadId, title }) => {
    const name = String(title || '').trim();
    if (!name) return { ok: false };
    const override = {title:name, at:Date.now()};
    settings.sidebarTitleOverrides = {...settings.sidebarTitleOverrides, [key]:override};
    if (threadId) settings.sidebarTitleOverrides[`codex:${threadId.toLowerCase()}`] = override;
    saveSettings(); // Persist the user's choice before any slow external rename request.
    let { chat } = await resolveChatRef(key);
    if (chat) {
      if(settings.sidebarTitleOverrides[key] === override) for (const alias of require('./chatTitles').keys(chat)) settings.sidebarTitleOverrides[alias] = override;
      saveSettings();
      chat.title = name;
      for (const run of running.values()) if (run.chat?.id === chat.id) run.chat.title = name;
    }
    let synced = false;
    let error = null;
    if (threadId) {
      try {
        await codexAccountCall(settings.providers.codex.path, settings.codexHome, [['thread/name/set', { threadId, name }]]);
        synced = true;
      } catch (err) { error = String(err.message || err); }
    }
    if (chat) {
      chat.title = name; await writeChat(chat);
      const workspace = chat.workspace || await chatWorkspace.discover(chat, path.join(app.getPath('documents'), 'wangpin-chat-workspaces'));
      if (workspace) await chatWorkspace.organize({...chat, workspace}, path.join(app.getPath('documents'), 'wangpin-chat-workspaces')).catch(error => console.error('更新對話資料夾標題失敗：', error.message));
    }
    else if (!threadId || !synced) {
      if (!threadId) return { ok: false };
      chat = { id: newId('cx'), origin: 'codex', title: name, cwd: '', codexThreadId: threadId, messages: [], createdAt: new Date().toISOString(), lastProvider: 'codex' };
      await writeChat(chat);
    }
    return { ok: true, synced, error };
  });

  // 用量與餘額
  ipcMain.handle('usage:read', async () => {
    const result = { codex: null, keys: {}, billing: providers.BILLING_PAGES };
    const claudeQueryIdentity = claudeIdentity;
    const claudeCfg = { ...settings.providers.claude };
    const tasks = [];
    tasks.push((async () => {
      try {
        const [rl] = await codexAccountCall(settings.providers.codex.path, settings.codexHome, [['account/rateLimits/read', { excludeResetCreditDetails: true }]], 20000);
        result.codex = { source: 'live', ...normalizeRateLimits(rl && (rl.rateLimitsByLimitId && rl.rateLimitsByLimitId.codex || rl.rateLimits), true) };
      } catch (err) {
        const local = await codexStore.readLatestRateLimits(settings.codexHome).catch(() => null);
        result.codex = local ? { source: 'cache', ...normalizeRateLimits(local.snapshot, false), at: local.at } : { error: String(err.message || err) };
      }
    })());
    tasks.push((async () => {
      try {
        const [u] = await claudeCode.control(claudeCfg.claudePath, [{ subtype: 'get_usage', skip_behaviors: true }], 25000, await ensureClaudeConfig(claudeCfg));
        if (!u || !u.rate_limits_available || !u.rate_limits) {
          result.claude = { error: u && u.subscription_type == null ? 'Claude Code 還沒登入 Claude 帳號（或目前用的是 API 金鑰）' : '這個帳號沒有方案用量資料' };
        } else {
          result.claude = { source: 'live', ...normalizeClaudeUsage(u.rate_limits), planType: u.subscription_type };
        }
      } catch (err) {
        result.claude = lastClaudeRateLimit ? { source: 'cache', windows: [claudeEventWindow(lastClaudeRateLimit.info)].filter(Boolean) } : { error: String(err.message || err) };
      }
    })());
    for (const k of settings.providers.deepseek.keys || []) {
      tasks.push((async () => {
        try { result.keys[k.id] = { ok: true, ...(await providers.deepseekBalance(providerCfg('deepseek', k.id))) }; }
        catch (err) { result.keys[k.id] = { ok: false, message: String(err.message || err) }; }
      })());
    }
    await Promise.all(tasks);
    if (claudeQueryIdentity !== claudeIdentity) result.claude = { error: 'Claude 帳號已切換，正在更新用量。' };
    return result;
  });

  ipcMain.handle('sidebar:pin', (_e, { key, pinned }) => {
    settings.pinOverrides = { ...(settings.pinOverrides || {}), [key]: !!pinned };
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('sidebar:unhide', (_e, { key, threadId }) => {
    const drop = new Set([key, threadId ? `codex:${threadId}` : null]);
    settings.hiddenKeys = (settings.hiddenKeys || []).filter((k) => !drop.has(k));
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('sidebar:copy', async (_e, text) => { await clipboard.writeText(String(text || '')); return { ok: true }; });
  ipcMain.handle('sidebar:logPath', async (_e, { item, reveal }) => {
    const file = await logPathFor(item);
    if (!file || !fs.existsSync(file)) return { ok: false, message: '找不到這段對話的紀錄檔（新對話要送出第一則訊息後才會建立）' };
    if (reveal) shell.showItemInFolder(file); else await clipboard.writeText(file);
    return { ok: true, path: file };
  });

  ipcMain.handle('sidebar:remove', (_e, item) => permanentlyRemoveConversation(String(item.key)));

  ipcMain.handle('antigravity:status', async (_e, opts = {}) => {
    if (antigravityAccountChanging) return { ok: false, changing: true, message: '正在切換帳號；完成登入後請關閉登入終端。' };
    try { return await antigravity.status({ force: !!opts.force }); }
    catch (e) { return { ok: false, message: e.message, notInstalled: !!e.notInstalled }; }
  });
  ipcMain.handle('antigravity:open', async () => {
    if (antigravityAccountChanging) return { ok: false, message: '帳號切換視窗已開啟，請先完成並關閉。' };
    const exe = antigravity.cliPath();
    if (!exe) return { ok: false, message: '尚未安裝 Antigravity CLI，請先按「安裝 CLI」。' };
    try {
      return await require('./antigravityLogin').open({ executable: exe, directory: userDir() });
    } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('antigravity:switchAccount', async event => {
    assertGptSender(event);
    if (antigravityAccountChanging) return { ok: false, message: '帳號切換視窗已開啟，請完成登入並關閉該視窗。' };
    try {
      if ([...running.values()].some(r => !r.finished && r.usesAntigravityAuth) || [...agents.live.values()].some(a => a.provider === 'antigravity' && ['queued','running'].includes(a.status))) {
        throw Error('Antigravity 任務仍在執行，請先停止再切換帳號。');
      }
      const executable = antigravity.cliPath();
      if (!executable) throw Error('尚未安裝 Antigravity CLI，請先按「安裝 CLI」。');
      antigravityAccountChanging = true;
      // 新增帳號：先保存目前帳號並移除 CLI 登入（不執行 /logout），登入視窗完成後登記新帳號；失敗則自動放回原帳號。
      let result, begin, finished = false, poll, deadline;
      const accountStore = antigravityAccounts();
      const finish = async () => {
        if (finished) return; finished = true; clearInterval(poll); clearTimeout(deadline);
        try { await accountStore.finishAdd(begin); } catch (e) { console.error('Antigravity 帳號登記失敗：', e.message); }
        antigravityAccountChanging = false; antigravity.clearCache();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('antigravity:accountsChanged');
      };
      try {
        begin = await accountStore.beginAdd();
        poll = setInterval(async () => {
          try { const live = await accountStore.peekLogin(); if (live.exists) { clearInterval(poll); await new Promise(r => setTimeout(r, 1500)); finish(); } } catch {}
        }, 2500);
        deadline = setTimeout(finish, 15 * 60 * 1000);
        poll.unref?.(); deadline.unref?.();
        result = await require('./antigravityLogin').open({ executable, directory: userDir(), switchAccount: true, onExit: finish });
      } catch (e) {
        if (begin) await finish(); else antigravityAccountChanging = false;
        throw e;
      }
      antigravity.clearCache();
      return result;
    } catch (e) { return { ok: false, message: e.message }; }
  });
  function assertAntigravityIdle() {
    if (antigravityAccountChanging) throw Error('帳號登入視窗仍開啟，請先完成登入。');
    if ([...running.values()].some(r => !r.finished && r.usesAntigravityAuth) || [...agents.live.values()].some(a => a.provider === 'antigravity' && ['queued','running'].includes(a.status))) {
      throw Error('Antigravity 任務仍在執行，請先停止再切換帳號。');
    }
  }
  ipcMain.handle('antigravity:accounts', async () => {
    try { return { ok: true, ...(await antigravityAccounts().list()) }; } catch (e) { return { ok: false, message: e.message, accounts: [] }; }
  });
  ipcMain.handle('antigravity:selectAccount', async (event, id) => {
    assertGptSender(event);
    try {
      assertAntigravityIdle();
      antigravityAccountChanging = true;
      try { const r = await antigravityAccounts().switchTo(String(id || '')); antigravity.clearCache(); return r; }
      finally { antigravityAccountChanging = false; }
    } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('antigravity:removeAccount', async (event, id) => {
    assertGptSender(event);
    try { assertAntigravityIdle(); return await antigravityAccounts().remove(String(id || '')); } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('antigravity:install', async () => {
    try {
      await antigravity.install();
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('sidebar:mirror', (_e, payload) => applySidebarMirror(payload || {}));
  ipcMain.handle('sidebar:openMirror', async () => {
    const m = sidebarMirror();
    await fsp.mkdir(m.shownDir, { recursive: true });
    return shell.openPath(m.root);
  });

  ipcMain.handle('lmstudio:models', async () => {
    const list = await providers.lmstudioModels(providerCfg('lmstudio'));
    settings.modelLists.lmstudio = list.map((m) => m.id);
    saveSettings();
    return list;
  });

  ipcMain.handle('models:list', async (_e, provider) => {
    const config = providerCfg(provider), keyId = activeKey(provider)?.id;
    const ids = await providers.listModels(provider, config);
    if(activeKey(provider)?.id !== keyId || providerCfg(provider).baseUrl !== config.baseUrl)throw Error('模型帳號設定已變更，請重新讀取清單。');
    settings.modelLists[provider] = ids;
    saveSettings();
    return ids;
  });

  ipcMain.handle('codex:detect', () => codexRunner.codexVersion(settings.providers.codex.path));
  ipcMain.handle('codex:install', async (e) => {
    const r = await codexRunner.installCodexCli((line) => e.sender.send('codex:installLog', line));
    return r;
  });

  ipcMain.handle('dialog:pickFolder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { title: '選擇工作資料夾', defaultPath: current || app.getPath('desktop'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: '選擇 codex.exe', properties: ['openFile'], filters: [{ name: 'Codex', extensions: ['exe', 'cmd', 'bat', '*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:openCodexThread', (_e, threadId) => shell.openExternal(`codex://threads/${threadId}`));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:createShortcut', () => createDesktopShortcut(true));

  ipcMain.handle('send', (e, req) => { const { agentCtx, ...clean } = req || {}; handleSend(e.sender, clean); return { ok: true }; });
  ipcMain.handle('cancel', (_e, reqId) => { const r = running.get(reqId); if (r) r.cancel(); agents.cancelSpawnedBy(reqId); return { ok: !!r }; });
  ipcMain.handle('run:status', (_e, reqId) => {
    const run = running.get(reqId);
    return {running:!!run && !run.finished,cancelled:!!run?.cancelled,paused:!!run?.paused,key:run?.key || '',command:run?.commandStatus || null};
  });
  ipcMain.handle('agents:list', (_e, parentKey) => agents.list(String(parentKey || '')));
  ipcMain.handle('agents:spawn', async (_e, { parentKey, task, name, provider, model }) => {
    const { chat, threadId } = await resolveChatRef(String(parentKey || ''));
    if (!chat && !threadId) throw new Error('找不到主對話');
    const cwd = chat?.cwd || (threadId && lastCodexList?.threads.find((t) => t.id === threadId.toLowerCase())?.cwd) || '';
    const extensions = extensionsKit.selectionFor(settings, Array.isArray(chat?.extensions) ? chat.extensions : undefined);
    return agents.spawn({ parentKey, task, name, provider, model, level: defaultLevel(provider), cwd, extensions });
  });
  ipcMain.handle('agents:message', (_e, { id, message }) => agents.message(String(id || ''), message));
  ipcMain.handle('agents:cancel', (_e, id) => agents.cancel(String(id || '')));
  ipcMain.handle('pause', async (_e, reqId) => {
    const r = running.get(reqId); if (!r) return {ok:false};
    r.paused = true;
    if (r.chat) { r.chat.paused = true; await writeChat(r.chat); }
    r.cancel(); return {ok:true};
  });
  ipcMain.handle('approval:resolve', (_e, { id, decision }) => {
    const ok = resolveApproval(id, decision);
    return { ok };
  });

  ipcMain.handle('wangpinBrowser:choose', async () => {
    const picked = await dialog.showOpenDialog(win,{title:'選擇王品 Firefox 執行檔',properties:['openFile'],filters:[{name:'Firefox',extensions:['exe']}]});
    if (picked.canceled || !picked.filePaths?.[0]) return {cancelled:true};
    const executable=picked.filePaths[0];
    if (!/^(?:firefox|WangpinBrowser)\.exe$/i.test(path.basename(executable))) throw Error('請選擇 firefox.exe 或 WangpinBrowser.exe。');
    return {path:require('./wangpinBrowserPaths').resolveExecutable(executable)};
  });
  ipcMain.handle('wangpinBrowser:start',async () => {
    if (!browserPolicy.availability(settings.browser || {}).wangpin) throw Error('請先開啟「操作瀏覽器」並選擇王品 Firefox。');
    return wangpinBrowserForChat('__setup',settings.browser).start();
  });
  ipcMain.handle('wangpinBrowser:stop',async () => Promise.all([...wangpinBrowsers.values()].map(entry=>entry.browser.stop())));
  ipcMain.handle('browser:status', async () => {
    const controller = browserControllerFor();
    const info = controller.info();
    const found = browserControl.findBrave((settings.browser || {}).path || '');
    let reused = null;
    if (!info.running) {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(path.join(userDir(), 'browser-state.json'), 'utf8')); } catch { saved = null; }
      if (saved && (await browserControl.probeVersion(saved.port))) reused = saved.port;
    }
    return { ...info, enabled: browserEnabled(), found: found.path, reusedPort: reused };
  });
  ipcMain.handle('browser:start', async () => {
    // 這個按鈕專門測試／啟動外部 Brave；即使內建瀏覽器也同時勾選，仍要真的測到 Brave。
    await requireBrave('測試外部瀏覽器前，需要先安裝或指定 Brave。');
    return browserControllerFor().start();
  });
  ipcMain.handle('browser:prepare', (_e, opts = {}) => prepareBrave(String(opts.reason || '').slice(0,500)));
  let showSeq = 0;
  ipcMain.handle('appBrowser:show', async (_e, { key, open, bounds }) => {
    const seq = ++showSeq; // 讀對話檔是非同步的：只套用最後一次的顯示要求，避免舊要求把網頁又蓋回來
    const scope = await browserScopeForKey(key, false);
    if (seq !== showSeq) return appBrowser().state(scope);
    appBrowser().visibleKey = key || null;
    return appBrowser().show({ scope, open, bounds });
  });
  ipcMain.handle('appBrowser:state', async (_e, key) => appBrowser().state(await browserScopeForKey(key, false)));
  ipcMain.handle('appBrowser:action', async (_e, { key, ...rest }) => {
    const host = appBrowser();
    if (rest.action === 'navigate' || (rest.action === 'newTab' && rest.url)) await host.ensureLogin();
    const scope = await browserScopeForKey(key, true);
    if (scope && host.visibleScope !== scope && String(host.visibleKey || '') === String(key)) host.visibleScope = scope;
    return host.action(scope, rest);
  });
  ipcMain.handle('appBrowser:keys', async (_e, scope) => {
    const chat = scope ? await readChat(String(scope)).catch(() => null) : null;
    if (!chat) return [];
    return [`app:${chat.id}`, chat.codexThreadId ? `codex:${chat.codexThreadId}` : null].filter(Boolean);
  });
  ipcMain.handle('browser:stop', async () => browserControllerFor().stop());
  ipcMain.handle('browser:detect', () => browserControl.findBrave((settings.browser || {}).path || ''));
  // 把使用者電腦上 Brave 的登入（cookie）匯入 App 內建瀏覽器
  ipcMain.handle('browser:importBraveLogin', async () => {
    return syncBraveLogin({ force: true, reason: 'manual' });
  });
  ipcMain.handle('browser:loginSyncStatus', () => loginSync.last);
  ipcMain.handle('browser:restartUserBrave', async () => {
    try { return await require('./braveLogin').restartUserBrave({ bravePath: (settings.browser || {}).path || '' }); }
    catch (e) { return { ok: false, message: String(e.message || e) }; }
  });
}

// 把 Codex 的用量資料整理成畫面好顯示的格式（live 是 camelCase，本機紀錄是 snake_case）
function normalizeRateLimits(snap, camel) {
  if (!snap) return { windows: [] };
  const g = (o, a, b) => (o ? (camel ? o[a] : o[b]) : null);
  const windows = [];
  for (const [key, w] of [['primary', snap.primary], ['secondary', snap.secondary]]) {
    if (!w) continue;
    const mins = g(w, 'windowDurationMins', 'window_minutes');
    const used = g(w, 'usedPercent', 'used_percent');
    const resets = g(w, 'resetsAt', 'resets_at');
    let label = key === 'primary' ? '短期' : '長期';
    if (mins) label = mins >= 10080 ? '每週' : mins >= 1440 ? `${Math.round(mins / 1440)} 天` : `${Math.round(mins / 60)} 小時`;
    windows.push({ label, usedPercent: typeof used === 'number' ? used : null, resetsAt: resets ? resets * 1000 : null });
  }
  const credits = snap.credits || null;
  return {
    windows,
    planType: g(snap, 'planType', 'plan_type') || null,
    credits: credits ? { hasCredits: g(credits, 'hasCredits', 'has_credits'), unlimited: credits.unlimited, balance: credits.balance } : null,
  };
}

// Claude Code 的方案用量（utilization 是已使用 %）
function normalizeClaudeUsage(rl) {
  const windows = [];
  const add = (label, w) => { if (w && (w.utilization != null || w.resets_at)) windows.push({ label, usedPercent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }); };
  add('5 小時', rl.five_hour);
  add('每週', rl.seven_day);
  add('每週 Opus', rl.seven_day_opus);
  add('每週 Sonnet', rl.seven_day_sonnet);
  for (const m of rl.model_scoped || []) add(`每週 ${m.display_name}`, m);
  const extra = rl.extra_usage && rl.extra_usage.is_enabled ? { usedCredits: rl.extra_usage.used_credits, monthlyLimit: rl.extra_usage.monthly_limit, currency: rl.extra_usage.currency } : null;
  return { windows, extra };
}
function claudeEventWindow(info) {
  if (!info || info.utilization == null) return null;
  const names = { five_hour: '5 小時', seven_day: '每週', seven_day_opus: '每週 Opus', seven_day_sonnet: '每週 Sonnet' };
  const u = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  return { label: names[info.rateLimitType] || info.rateLimitType || '用量', usedPercent: u, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null };
}

function contextBlock(msgs, archive = '') {
  const compacted = contextManager.compact(msgs, Number(settings.maxContextChars) || 120000, {historyOnly:true});
  msgs = compacted.messages;
  const lines = msgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim())
    .map((m) => {
      const label = m.provider === 'codex' ? 'Codex' : (providers.PROVIDERS[m.provider] || { label: m.provider || '模型' }).label;
      const who = m.role === 'user' ? '使用者' : `${label}${m.model ? `（${m.model}）` : ''}`;
      return `[${who}]\n${m.text.trim()}`;
    });
  let body = lines.join('\n\n');
  const max = Number(settings.maxContextChars) || 120000;
  if (compacted.compacted && archive) body += `\n完整原文檔案：${archive}（需要細節可讀取此檔；不要猜測省略內容）`; 
  return `${codexStore.CTX_OPEN}\n以下是這段對話中，使用者在其他模型的往來紀錄，請延續這個脈絡處理下面的新要求：\n\n${body}\n${codexStore.CTX_CLOSE}\n\n`;
}

// 自訂 Harness 的一個回合：這段對話的訊息交給使用者選的腳本跑完整個流程，最後的輸出就是回覆。
// 每個步驟的模型呼叫由 runnerFor 建立（預設沿用目前對話；步驟可以另外指定模型或降低權限）。
async function harnessTurn({ emit, task, chat, text, files, provider, model, runSettings, extSelection, runnerFor, scriptChoice, history, cwd, level }) {
  const kit = require('./harness');
  const root = path.join(userDir(), 'harness');
  kit.ensureTemplates(root);
  const others = extSelection.filter((id) => id !== 'harness');
  if (others.length) emit('notice', { message: `這段對話開著 Harness 模式，由腳本接管回覆；同時勾選的其他擴充（${others.join('、')}）這次不會使用。` });
  chat.messages = chat.messages || [];
  chat.messages.push({ id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model });
  chat.lastProvider = provider;
  await writeChat(chat);
  emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
  const controller = new AbortController();
  task.attach({ cancel: () => controller.abort() });
  const t0 = Date.now();
  let label = '準備中';
  const progress = () => emit('progress', { message: `Harness ${label}…　${Math.round((Date.now() - t0) / 1000)} 秒` });
  const ticker = setInterval(progress, 2000);
  let current = null;
  const stepItem = (patch) => { if (current) emit('item', { item: { ...current, ...patch } }); };
  try {
    let file = scriptChoice || kit.TEMPLATES[0].file;
    let generated = null;
    if (file === kit.AUTO) {
      label = '依目標設計新腳本'; progress();
      current = { id: newId('harness'), type: 'api_tool', name: 'harness_generate', label: 'Harness：依目標建立腳本', args: text.slice(0, 80), status: 'in_progress' };
      stepItem({});
      generated = await kit.generate(text, { root, runner: await runnerFor({ type: 'prompt', model: '', session: '' }), signal: controller.signal, history, level, onProgress: (m) => { label = m; } });
      stepItem({ status: 'completed', args: generated.file, output: generated.text.slice(0, 4000) });
      current = null;
      file = generated.file;
      chat.harness = { script: file };
      emit('notice', { message: `已依目標建立新腳本「${file}」（${generated.script.steps.length} 個步驟：${generated.script.steps.map((x) => x.name).join(' → ')}），接著執行。這段對話之後會沿用這份腳本；想再自動建立，從擴充選單把 Harness 腳本改回「依目標自動建立」。` });
      emit('harness', { script: file });
    }
    const loaded = kit.read(root, file);
    const script = loaded.script;
    if (!script.name) script.name = loaded.file.replace(/\.txt$/i, '');
    if (!script.ok) throw new Error(`腳本「${loaded.file}」有格式錯誤，沒有執行：\n${kit.describeErrors(script).join('\n')}\n請到「API 設定 → 能力擴充 → 自訂 Harness → 管理腳本」修正。`);
    emit('status', { message: `Harness 腳本：${script.name}（${script.steps.map((x) => `${x.name}〔${kit.TYPE_LABEL[x.type]}〕`).join(' → ')}）` });
    const r = await kit.run(script, {
      input: text, history, cwd, signal: controller.signal, runnerFor,
      onProgress: (m) => { label = m; },
      onStep: (st) => {
        current = { id: newId('harness'), type: 'api_tool', name: 'harness_step', label: `Harness 步驟：${st.name}（${kit.TYPE_LABEL[st.type]}）`, args: st.round > 1 ? `第 ${st.round} 次` : '', status: 'in_progress' };
        stepItem({});
      },
      onStepDone: (rec) => { stepItem({ status: 'completed', args: [rec.verdict, `${Math.round(rec.ms / 1000)} 秒`].filter(Boolean).join('，'), output: String(rec.output || '').slice(0, 4000) }); current = null; },
    });
    const calls = r.calls + (generated ? generated.calls : 0);
    emit('delta', { text: r.text });
    const tools = [...(generated ? [{ name: 'Harness：依目標建立腳本', args: generated.file }] : []), ...r.runs.map((x) => ({ name: `Harness 步驟：${x.step}（${x.type}）`, args: [x.verdict, `${Math.round(x.ms / 1000)} 秒`].filter(Boolean).join('，') }))];
    chat.messages.push({ id: newId('m'), role: 'assistant', text: r.text, tools, ts: new Date().toISOString(), provider, model, harness: { script: loaded.file, name: script.name, calls, runs: r.runs.map((x) => ({ step: x.step, type: x.type, verdict: x.verdict || '', ms: x.ms })) } });
    await writeChat(chat);
    emit('notice', { message: `Harness「${script.name}」完成：執行 ${r.runs.length} 次步驟、呼叫模型 ${calls} 次，花了 ${Math.round(r.ms / 1000)} 秒。` });
    emit('done', {});
  } catch (e) {
    stepItem({ status: 'failed', output: e.message });
    if (chat.harness) await writeChat(chat).catch(() => {});
    if (task.cancelled) emit('done', { cancelled: true });
    else emit('error', { message: `Harness 這次沒有跑完：${e.message}` });
  } finally {
    clearInterval(ticker);
  }
}

// 陪伴角色的一個回合：角色的話直接當成這段對話的回覆。
// 模型呼叫沿用目前對話（inheritedRunner，僅聊天權限），每回合 1 次，口吻檢查沒過時最多 2 次。
async function companionTurn({ emit, task, chat, text, files, provider, model, runSettings, extSelection, runner }) {
  const cfg = (runSettings.extensions?.config || {}).companion || {};
  const others = extSelection.filter((id) => id !== 'companion');
  if (others.length) emit('notice', { message: `這段對話由陪伴角色接管回覆，同時勾選的其他擴充（${others.join('、')}）這次不會使用。` });
  chat.messages = chat.messages || [];
  chat.messages.push({ id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model });
  chat.lastProvider = provider;
  await writeChat(chat);
  emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
  const controller = new AbortController();
  task.attach({ cancel: () => controller.abort() });
  // 模型可能要想很久（本機模型尤其慢）：定時回報「還在想、已經想了多少」，畫面才不會像當掉
  const who = String(cfg.name || '').trim() || '她';
  const t0 = Date.now();
  const progress = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const a = companionActivity;
    const what = a.status ? a.status : a.reply ? '正在打字' : a.thinking ? `正在想（已想 ${a.thinking} 字）` : provider === 'lmstudio' ? '正在想（本機模型讀 prompt 中）' : '正在想';
    emit('progress', { message: `${who}${what}…　${sec} 秒` });
  };
  const companionActivity = { thinking: 0, reply: 0, status: '' };
  runner.onActivity = (ev) => {
    if (ev.type === 'reasoning') companionActivity.thinking += String(ev.text || '').length;
    else if (ev.type === 'delta') companionActivity.reply += String(ev.text || '').length;
    else if (ev.type === 'status') { companionActivity.status = String(ev.message || '').slice(0, 80); emit('status', { message: ev.message }); }
  };
  progress();
  const ticker = setInterval(progress, 2000);
  try {
    const r = await require('./companion').turn({
      root: path.join(userDir(), 'companion'), characterId: cfg.characterId || 'default', name: String(cfg.name || '').trim() || undefined,
      userText: text, runner, signal: controller.signal, timeoutMs: 600000,
    });
    emit('delta', { text: r.reply });
    // persona.txt 在 App 外改了名字：擴充設定跟著換
    if (r.name && r.name !== String(cfg.name || '').trim() && settings.extensions?.config?.companion) { settings.extensions.config.companion.name = r.name; saveSettings(); }
    chat.messages.push({ id: newId('m'), role: 'assistant', text: r.reply, ts: new Date().toISOString(), provider, model, companion: { name: r.name, calls: r.calls } });
    await writeChat(chat);
    emit('done', {});
  } catch (e) {
    if (task.cancelled) emit('done', { cancelled: true });
    else emit('error', { message: `陪伴角色這次沒有回覆：${e.message}` });
  } finally {
    clearInterval(ticker);
  }
}

async function handleSend(wc, req, inheritedExecution = null) {
  if(typeof deletionBusy!=='undefined' && deletionBusy){if(!wc.isDestroyed())wc.send('stream',{reqId:req.reqId,type:'error',message:'正在清理對話，請稍後再送出'});return;}
  const { reqId, key, provider, options = {}, agentCtx = null } = req;
  let { model } = req;
  const runSettings = JSON.parse(JSON.stringify(inheritedExecution?.settings || settings));
  if(runSettings.webBrowserModeRestored===true && provider==='gpt' && (options.via||runSettings.providers.gpt.via)==='web' && options.webEnsemble){
    options.webEnsemble={...options.webEnsemble,connections:{gpt:'account',claude:'account',gemini:'account'}};
  }
  if(runSettings.webWebsiteHttpOnly===true && provider==='gpt' && (options.via||runSettings.providers.gpt.via)==='web'){
    const previous=options.webEnsemble||runSettings.providers.gpt.webEnsemble||{};
    options.webEnsemble={...previous,enabled:true,connections:{gpt:'site-http',claude:'site-http',gemini:'site-http'},mcp:previous.mcp??runSettings.providers.gpt.webAgent??false};
  }
  const planKit = require('./wangpinPlan');
  let planConfig;
  try { planConfig = planKit.normalize(options.wangpinPlan); }
  catch(error) { if(!wc.isDestroyed())wc.send('stream',{reqId,type:'error',message:error.message});return; }
  if (planConfig.enabled && agentCtx) { if(!wc.isDestroyed())wc.send('stream',{reqId,type:'error',message:'wangpinplan 不可巢狀執行'});return; }
  const planTargets = planConfig.enabled ? [planConfig.plan.target,planConfig.execute.target] : [];
  // Capture credentials before the first await, including the later stage.
  const planApiConfigs = Object.fromEntries([...new Set(planTargets)].map(target=>[target,target.startsWith('api:')?JSON.parse(JSON.stringify(providerCfg(target.slice(4)))):null]));
  const planExtensionKeys = planConfig.enabled ? extensionApiKeys() : inheritedExecution?.extensionKeys;
  const planNoTools = inheritedExecution?.planStage === true;
  if(planConfig.enabled && options.webEnsemble && typeof options.webEnsemble==='object')runSettings.providers.gpt.webEnsemble={...(runSettings.providers.gpt.webEnsemble || {}),...JSON.parse(JSON.stringify(options.webEnsemble))};
  const apiConfig = inheritedExecution ? inheritedExecution.apiConfig : provider === 'codex' || provider === 'grokbot' || provider === 'grokbuild' ? null : providerCfg(provider);
  const grokBotRunConfig = provider === 'grokbot' ? grokBotConfig() : null;
  let text = String(req.text || '');
  if (running.has(reqId) || [...running.values()].some(r => r.key === key)) { if (!wc.isDestroyed()) wc.send('stream',{reqId,type:'error',message:'這段對話已在執行，請先暫停'}); return; }
  const borrowedCodexReview = planConfig.enabled ? !planTargets.includes('codex') && planConfig.execute.target==='antigravity' && runSettings.providers.antigravity.permission==='codex-review' : provider === 'antigravity' && (options.permission || runSettings.providers.antigravity.permission) === 'codex-review';
  const ensembleMcp = !!options.webEnsemble && (options.webEnsemble.mcp ?? runSettings.providers.gpt.webAgent) === true;
  const ensembleWanted = !planConfig.enabled && provider === 'gpt' && (options.via || runSettings.providers.gpt.via) === 'web' && (options.webEnsemble?.enabled === true || ensembleMcp);
  let ensembleConfig;
  if(ensembleWanted)try {
    ensembleConfig=require('./webEnsemble').normalize({...options.webEnsemble,mcp:ensembleMcp});
    if(ensembleConfig.mcp && options.webSynthesisRoundId)throw Error('請先關閉 MCP，再選擇統合模型。');
  } catch(error) {if(!wc.isDestroyed())wc.send('stream',{reqId,type:'error',message:error.message});return;}
  const ensembleSynthesis = ensembleWanted && ensembleConfig.synthesize;
  const sourceApiConfigs = Object.fromEntries((ensembleWanted ? ['gpt','claude','gemini'].filter(site=>ensembleConfig.connections[site]==='http') : []).map(site=>[site,structuredClone(providerCfg(site))]));
  const ensembleApiConfig = ensembleSynthesis && String(ensembleConfig.target).startsWith('api:') ? providerCfg(String(ensembleConfig.target).slice(4)) : null;
  const usesCodexAuth = planConfig.enabled ? planTargets.includes('codex') || (planConfig.execute.target==='antigravity' && runSettings.providers.antigravity.permission==='codex-review') : borrowedCodexReview || provider === 'codex' || (ensembleSynthesis && ensembleConfig.target === 'codex') || (provider === 'gpt' && (options.via || runSettings.providers.gpt.via) === 'codex');
  if (usesCodexAuth && codexAccountChanges) { if (!wc.isDestroyed()) wc.send('stream', { reqId, type: 'error', message: '正在更新 Codex 登入，請等帳號切換完成後再送出。' }); return; }
  if (antigravityAccountChanging && (provider === 'antigravity' || planTargets.includes('antigravity'))) {
    if (!wc.isDestroyed()) wc.send('stream', { reqId, type: 'error', message: '正在切換 Antigravity 帳號，請完成登入並關閉登入終端後再送出。' });
    return;
  }
  const task = registerRun(running, reqId); task.key = key; task.startedAt = Date.now(); task.provider = provider === 'gpt' && settings.providers.gpt.via === 'api' ? 'gpt-api' : provider;
  if (provider === 'gpt' && (options.via || runSettings.providers.gpt.via) === 'web') task.gptWebAccountId = runSettings.providers.gpt.webAccountId || 'default';
  task.usesCodexAuth = usesCodexAuth;
  task.usesAntigravityAuth = provider === 'antigravity' || planTargets.includes('antigravity');
  if (provider === 'claude' && (options.via || runSettings.providers.claude.via) === 'claudecode') task.claudeConfigDir = runSettings.providers.claude.configDir || require('./claudeAccounts').defaultProfile(userDir());
  if (ensembleSynthesis && ensembleConfig.target === 'claudecode') {
    task.claudeConfigDir = runSettings.providers.claude.configDir || require('./claudeAccounts').defaultProfile(userDir());
    runSettings.providers.claude.configDir = task.claudeConfigDir;
  }
  if (ensembleWanted) task.webModelSites = [...new Set([...ensembleConfig.sites,...(ensembleSynthesis && ensembleConfig.target.startsWith('web:')?[ensembleConfig.target.slice(4)]:[])])];
  if (planConfig.enabled) {
    if(planTargets.includes('web:gpt'))task.gptWebAccountId=runSettings.providers.gpt.webAccountId || 'default';
    task.webModelSites=[...new Set(planTargets.filter(t=>t.startsWith('web:')).map(t=>t.slice(4)))];
    if(planTargets.includes('claudecode')) {
      task.claudeConfigDir=runSettings.providers.claude.configDir || require('./claudeAccounts').defaultProfile(userDir());
      runSettings.providers.claude.configDir=task.claudeConfigDir;
    }
  }
  let nativeBridge = null;
  let selectedWangpin = false;
  let extSession = null;
  let deleteGuard = null;
  const runAbort = new AbortController();
  task.attach({ cancel: () => runAbort.abort() });
  let accountLease = null;
  const streamedItems = require('./codexPartial').create();
  const streamedTools = () => streamedItems.snapshot().tools;
  const emit = (type, data = {}) => {
    if (task.finished) return;
    if (type === 'item') {
      const previous = task.commandItems?.get(data.item?.id);
      if(previous && !data.item.commandLifecycle)data={...data,item:{...data.item,commandLifecycle:previous}};
      streamedItems.capture(data.item);
    }
    if (['done', 'error', 'locked'].includes(type)) require('./runTerminal').complete(task,
      [()=>nativeBridge?.close(),()=>extSession?.close(),()=>deleteGuard?.close(),()=>runAbort.abort(),()=>accountLease?.release()],
      error=>console.error('回合資源清理失敗：',error.message));
    if (!wc.isDestroyed()) wc.send('stream', { reqId, key, type, paused:!!task.paused, ...data });
  };
  // Actual API command phases only. CLI tool envelopes do not expose internal child spawn.
  const commandContext = (ctx, item, send = value => emit('item', {item:value})) => ({...ctx,onCommand:metadata=>{
    if(task.finished)return;
    const commandLifecycle={...metadata,transport:wc.isDestroyed()?'unavailable':'stream_requested'};
    if(!task.commandItems)task.commandItems=new Map();
    task.commandItems.set(item.id,commandLifecycle);
    if(task.commandItems.size>64)task.commandItems.delete(task.commandItems.keys().next().value);
    task.commandStatus={toolId:item.id,...commandLifecycle};
    send({...item,status:'in_progress',commandLifecycle});
  }});
  const observedApiTool = (name,args,ctx,item,send) => apiTools.execute(name,args,commandContext(ctx,item,send));
  const guardNative = handlers => require('./runTerminal').guardCallbacks(handlers,(error,name,args)=>{
    task.cancel();
    emit('error',{message:[name === 'onError' ? String(args[0] || '') : '',`回合收尾失敗：${error.message}`].filter(Boolean).join('\n'),authRequired:!!args[1]?.authRequired});
  },()=>task.finished);
  try {
    if (usesCodexAuth) {
      try {
        accountLease = inheritedExecution?.codexLease ? {...inheritedExecution.codexLease,release:()=>{}} : await accountStore().captureRunHome(runSettings.codexHome);
        runSettings.codexHome = accountLease.home;
        task.accountId = accountLease.accountId; task.isolatedCodexAuth = true;
      } catch (error) {
        if (!borrowedCodexReview) throw error;
        emit('notice', { message: 'Codex 審核帳號未就緒；這回合需要授權的操作改為手動確認。請在 Codex 的連線選單登入。' });
      }
    }
    if (!['codex', 'gpt', 'claude', 'deepseek', 'gemini', 'grok', 'meta', 'ablit', 'lmstudio', 'antigravity', 'grokbot', 'grokbuild'].includes(provider)) throw new Error('不支援的供應商');
    // LM Studio 沒選模型：用它目前載入的那個，並讓擴充與子 agent 也沿用同一個
    if (!planConfig.enabled && provider === 'lmstudio' && !String(model || apiConfig?.model || '').trim()) {
      const picked = await providers.lmstudioPickModel(apiConfig);
      apiConfig.model = picked;
      runSettings.providers.lmstudio = { ...(runSettings.providers.lmstudio || {}), model: picked };
    } else if (!planConfig.enabled && provider === 'lmstudio' && !agentCtx) {
      // 記住的模型已經不在 LM Studio 裡（卸載後的量化版本 ID、刪掉的檔案）：換成還在的，不要送出注定失敗的請求
      const r = await providers.lmstudioResolveModel(apiConfig, model || apiConfig.model);
      if (r.changed) {
        model = r.model;
        apiConfig.model = r.model;
        runSettings.providers.lmstudio = { ...(runSettings.providers.lmstudio || {}), model: r.model };
        if (!inheritedExecution) { settings.providers.lmstudio.model = r.model; saveSettings(); }
        if (r.reason) emit('notice', { message: r.reason });
      }
    }
    const files = (req.attachmentIds || []).map(id => { const item = stagedAttachments.get(id); if (!item) throw new Error('附件已失效，請重新加入'); return item; });
    if (files.length > 16 || files.filter(a=>!a.video && !a.audio).length > 8) throw new Error('每次最多 8 個一般附件；含影音擷取圖片時合計最多 16 個');
    if (!planConfig.enabled && files.some(a => a.mime === 'application/pdf') && provider !== 'claude') throw new Error('PDF 請切換 Claude；其他模型可上傳文字或圖片。');
    if (!planConfig.enabled && provider === 'deepseek' && files.some(a => a.mime.startsWith('image/')) && !/^(deepseek-flash|deepseek-v4-flash|deepseek-v4-flash-vision-exp)$/i.test(model || runSettings.providers.deepseek.model)) throw new Error('DeepSeek 圖片請選 deepseek-flash（DeepSeek 4.1 Flash）；V4 Pro 不接受圖片。');
    text = attachments.textWithFiles(text || '請分析附件。', files);
    let { chat, threadId } = await resolveChatRef(key);
    if (!chat) {
      if (!threadId) { emit('error', { message: '找不到這段對話' }); return; }
      chat = { id: newId('cx'), origin: 'codex', title: '', cwd: '', codexThreadId: threadId, messages: [], createdAt: new Date().toISOString(), lastProvider: 'codex' };
    }
    if ([...running.values()].some(r => r !== task && r.chat?.id === chat.id)) throw new Error('這段對話已由另一個請求執行');
    task.chat = chat; chat.paused = !!task.paused;
    const keptFrom = (chat.messages || []).length;
    // 回合還沒寫下使用者訊息就被暫停／停止：剛送出的訊息仍要留在紀錄裡，不能跟著重新載入消失
    const keepCancelledUser = async () => {
      if (agentCtx || (chat.messages || []).slice(keptFrom).some(m => m.role === 'user')) return;
      if (provider === 'codex') {
        const { messages } = await mergedMessages(chat, threadId).catch(() => ({ messages: [] }));
        if (messages.some(m => m.role === 'user' && m.source !== 'app' && (Date.parse(m.ts) || 0) >= task.startedAt - 1000)) return;
      }
      chat.messages = chat.messages || [];
      chat.messages.push({ id: newId('m'), role: 'user', text, attachments: files.length ? files : undefined, ts: new Date(task.startedAt).toISOString(), provider, model: model || '' });
      await writeChat(chat).catch(e => console.error('保存暫停前的訊息失敗：', e.message));
    };
    // 這段對話自己的 System Prompt：疊在全域 System Prompt 後面；Codex 原生另外走 developer_instructions
    const chatSystem = typeof chat.systemPrompt === 'string' ? chat.systemPrompt.trim() : '';
    if (chatSystem && !inheritedExecution?.wangpinPlanPrompt) runSettings.systemPrompt = [runSettings.systemPrompt, chatSystem].filter((x) => x && String(x).trim()).join('\n\n');
    const promptSkillText = extensionsKit.promptSkills(runSettings, Array.isArray(options.extensions) ? options.extensions : chat.extensions);
    const promptSkillContext = runSettings.extensions?.externalSkills
      ? `[本輪 Markdown skill 設定：以下是本輪的完整清單；先前輪次的 skill 不作為本輪啟用設定。]\n${promptSkillText || '本輪沒有啟用 Markdown skill。'}` : promptSkillText;
    if (promptSkillContext && !inheritedExecution?.wangpinPlanPrompt) runSettings.systemPrompt = [runSettings.systemPrompt,promptSkillContext].filter(Boolean).join('\n\n');
    const { messages: storedMerged, codexCwd, codexError } = await mergedMessages(chat, threadId);
    const merged = planKit.handoffMessages(storedMerged);
    if (task.cancelled) { await keepCancelledUser(); emit('done', { cancelled: true }); return; }
    const cwd = chat.cwd || codexCwd || '';
    if (req.cwd !== undefined && path.resolve(req.cwd || '.') !== path.resolve(cwd || '.')) throw new Error('專案已切換，請確認工作目錄後重新送出');
    chat.cwd = cwd;
    const archiveDir = path.join(userDir(), 'context-archives', chat.id);
    await fsp.mkdir(archiveDir,{recursive:true});
    const archive = path.join(archiveDir, 'history.txt');
    await fsp.writeFile(archive,merged.map(m => `[${m.role}]\n${m.text || ''}`).join('\n\n'),'utf8');
    if (!chat.title && chat.origin === 'app') chat.title = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!agentCtx) { settings.lastProvider = provider; saveSettings(); }

    if(planConfig.enabled) {
      for(const stage of ['plan','execute']) {
        const picked=planConfig[stage],p=planKit.providerFor(picked.target);
        if(files.some(a=>a.mime==='application/pdf') && p!=='claude')throw Error('wangpinplan 的兩個階段都必須使用支援 PDF 的 Claude 模型');
        if(files.some(a=>a.mime.startsWith('image/')) && ['web:claude','web:gemini'].includes(picked.target))throw Error('wangpinplan 的 Claude／Gemini 網頁來源尚不支援圖片附件');
        if(p==='deepseek' && files.some(a=>a.mime.startsWith('image/')) && !/^(deepseek-flash|deepseek-v4-flash|deepseek-v4-flash-vision-exp)$/i.test(picked.model || runSettings.providers.deepseek.model))throw Error('wangpinplan 的 DeepSeek 圖片階段請選 deepseek-flash（DeepSeek 4.1 Flash）');
        if(picked.target.startsWith('api:') && picked.target!=='api:lmstudio' && !planApiConfigs[picked.target]?.apiKey)throw Error(`wangpinplan 的 ${picked.target} 尚未設定 API 金鑰`);
      }
      const history=planKit.boundedContext(merged);
      const sourceExtensions=Array.isArray(options.extensions)?options.extensions:chat.extensions || [];
      const phaseChat={id:chat.id,cwd,extensions:[...sourceExtensions],systemPrompt:chat.systemPrompt || ''};
      chat.messages ||= [];
      chat.messages.push({id:newId('m'),role:'user',text,attachments:files,ts:new Date().toISOString(),provider,model,wangpinPlan:{config:planConfig}});
      chat.lastProvider=provider;await writeChat(chat);
      emit('started',{key:chat.origin==='codex'?`codex:${chat.codexThreadId}`:`app:${chat.id}`});
      const stageText={plan:'',execute:''};
      const format=()=>`## wangpinplan · Plan\n\n${stageText.plan}${stageText.execute?'\n\n---\n\n## wangpinplan · 執行\n\n'+stageText.execute:''}`;
      const execute=planKit.create({newId,writeChat,readChat,cancel:id=>running.get(id)?.cancel(),run:(sink,request,context)=>handleSend(sink,request,context)});
      try {
        await execute.execute({config:planConfig,question:String(req.text || text),history,archive,signal:runAbort.signal,settings:runSettings,apiConfigs:planApiConfigs,codexLease:accountLease,extensionKeys:planExtensionKeys,chat:phaseChat,attachmentIds:req.attachmentIds,
          onStage:(stage,picked)=>emit('status',{message:`wangpinplan · ${stage==='plan'?'Plan':'執行'} · ${picked.target} / ${picked.model || '預設模型'}${picked.effort ? ' · '+picked.effort : ''}`}),
          onEvent:event=>{
            const stage=event.stage;
            if(['delta','replace'].includes(event.type) || event.type==='item' && event.item?.type==='agent_message' && !['analysis','commentary'].includes(event.item.phase)) {
              stageText[stage]=event.answer || '';emit('replace',{text:format()});
            } else if(event.type==='item')emit('item',{item:{...event.item,id:`${stage}:${event.item?.id || 'tool'}`,label:`${stage==='plan'?'Plan':'執行'} · ${event.item?.label || event.item?.name || event.item?.type || '工具'}`}});
            else if(event.type==='approval')emit('approval',{id:event.id,kind:event.kind,cwd:event.cwd,detail:`wangpinplan · ${stage==='plan'?'Plan':'執行'}\n${event.detail || ''}`});
            else if(['status','notice','progress'].includes(event.type)) {
              const message=`wangpinplan · ${stage==='plan'?'Plan':'執行'} · ${event.message || ''}`;
              emit(event.type,{message});
              if(event.type==='progress')emit('item',{item:{id:`${stage}:progress:${event.id || 'status'}`,type:'agent_message',phase:'commentary',publicActivity:true,text:message}});
            }
            else if(event.type==='reasoning')emit('reasoning',{text:event.text || ''});
            else if(event.type==='usageChanged')emit('usageChanged',{});
          },
          save:async(stage,result,picked)=>{
            stageText[stage]=result.text;const p=planKit.providerFor(picked.target);
            chat.messages.push({id:newId('m'),role:'assistant',text:result.text,tools:result.tools,reasoning:result.activity || '',provider:p,model:picked.model,via:picked.target,ts:new Date().toISOString(),wangpinPlan:{stage,target:picked.target},...(result.partial?{partial:true,partialReason:result.partialReason}:{})});
            await writeChat(chat);emit('replace',{text:format()});
          }});
        emit('done',{cancelled:false});
      } catch(error) {
        if(task.cancelled)emit('done',{cancelled:true});else emit('error',{message:error.message});
      }
      return;
    }

    if (ensembleWanted) {
      const kit = require('./webEnsemble');
      const config = ensembleConfig;
      const requestedLevel = options.permission || runSettings.providers.gpt.permission || 'chat';
      const runLevel = ['chat','read-only','workspace-write','danger-full-access'].includes(requestedLevel) ? requestedLevel : 'chat';
      const noDelete = runSettings.guard?.noDelete === true;
      task.webModelSites = [...new Set([...config.sites, ...(config.synthesize && config.target.startsWith('web:') ? [config.target.slice(4)] : [])])];
      // Capture every connection before fanout: later account/settings changes
      // only affect the next round, including a later manual re-synthesis.
      const needsGpt = config.connections.gpt === 'account' && (config.sites.includes('gpt') || (config.synthesize && config.target === 'web:gpt'));
      const account = needsGpt ? await gptAccountStore().active(runSettings.providers.gpt.webAccountId || undefined) : null;
      if (account) task.gptWebAccountId = account.id;
      const profiles = Object.fromEntries(['gpt','claude','gemini'].map(site => [site, config.connections[site] === 'guest' ? path.join(userDir(),'web-guest-profiles',site) : site === 'gpt' ? account?.profileDir : path.join(userDir(), 'web-model-profiles', site)]));
      const apiProvider = config.target.startsWith('api:') ? config.target.slice(4) : null;
      const synthesisApiConfig = ensembleApiConfig;
      const original = options.webSynthesisRoundId
        ? chat.messages.find(m => m.webRound?.id === options.webSynthesisRoundId)?.webRound : null;
      if (options.webSynthesisRoundId && !original) throw Error('找不到這輪原始回答，請重新開啟對話後再試。');
      const images = attachments.imagePaths(files, path.join(userDir(), 'attachments'));
      if (images.length && config.sites.some(site => site !== 'gpt')) throw Error('Claude／Gemini 網頁的圖片附件尚未支援；請先只選 GPT，或改用文字附件。');
      if (images.length && config.sites.some(site=>config.connections[site] !== 'account')) throw Error('HTTP／訪客來源目前只接受文字附件；請改用一般 API 模式傳送圖片。');
      const neededSites = [...new Set([...config.sites,...(config.synthesize && config.target.startsWith('web:') ? [config.target.slice(4)] : [])])];
      for(const site of neededSites) if(config.connections[site]==='http' && !sourceApiConfigs[site]?.apiKey) throw Error(site+' HTTP 模式需要 API Key；請先在 API 設定新增。');
      const roundId = original?.id || newId('webround');
      const question = original?.question || text;
      chat.messages ||= [];
      if (!original) chat.messages.push({ id:newId('m'),role:'user',text,attachments:files,ts:new Date().toISOString(),provider:'gpt',via:'web' });
      chat.lastProvider = 'gpt';
      await writeChat(chat);
      emit('started', {key:chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}`});
      let sourceMessage;
      let visibleFinal = '';
      const sourceTools = new Map();
      let sourceToolTail = Promise.resolve();
      const serializeSourceTool = action => {
        const work = sourceToolTail.catch(()=>{}).then(()=>{if(runAbort.signal.aborted || task.cancelled)throw Error('已停止');return action();});
        sourceToolTail = work; return work;
      };
      const askSite = async ({site, model: want, text: prompt, signal, onDelta, onReplace, stage = 'source'}) => {
        if (signal.aborted) throw Error('已停止');
        const common = { chatKey:`${chat.id}:${roundId}:${site}:${stage}`,model:config.connections[site]==='guest'?'':want,signal,
          onStatus:message=>emit('status',{message:`${kit.LABELS[site]}：${message}`}),bravePath:runSettings.browser?.path || '' };
        let turnUrl = '', useTools = false, session = null, firstTurn = true;
        const httpAsk = config.connections[site] === 'http' ? require('./webHttp').create({site,cfg:sourceApiConfigs[site],model:stage==='synthesis' ? config.httpSynthesisModel : config.apiModels[site],signal}) : null;
        const accountHttp=config.connections[site]==='site-http'?websiteHttpClient(site,{model:want,signal,accountId:site==='gpt'?runSettings.providers.gpt.webAccountId||'default':'default'}):null;
        const direct = async (turnText, callbacks = {}) => {
          if(accountHttp)return accountHttp.ask(turnText,{onDelta:callbacks.onDelta||onDelta,onStatus:common.onStatus});
          if(httpAsk) return httpAsk(turnText,{onDelta:callbacks.onDelta || onDelta,onReplace:callbacks.onReplace || onReplace,onStatus:common.onStatus});
          const request = {...common,text:turnText,onDelta:callbacks.onDelta || onDelta,onReplace:callbacks.onReplace || onReplace};
          if (site !== 'gpt') return require('./webModelsBrowser').ask({...request,hideWindow:runSettings.webHideWindow!==false,site,keepTab:useTools,closeTab:!useTools,guest:config.connections[site]==='guest',profileDir:profiles[site]});
          const guest = config.connections.gpt === 'guest';
          if (!account && !guest) throw Error('請先在連線選單登入 GPT 網頁帳號。');
          if (account && gptLoginAccountId === account.id) throw Error('GPT 帳號正在登入，請完成後再送出。');
          const result = await require('./chatgptWeb').ask({...request,url:turnUrl,keepTab:useTools,closeTab:true,guest,profileDir:profiles.gpt,importExistingLogin:false,temporary:!guest,images:stage === 'source' && firstTurn ? images : []});
          firstTurn = false;if(result.url)turnUrl=result.url;
          if(useTools && !require('./webSourceMcp').stableGptUrl(turnUrl)){
            let call;try{call=require('./webToolBridge').parse(result.text);}catch{}
            if(call)throw Object.assign(Error('GPT 對話網址尚未穩定；這次工具尚未執行，已保留收到的內容，請重新送出。'),{partial:result.text});
          }
          return result;
        };
        if (stage !== 'source' || !config.mcp) return direct(prompt);
        const onTool = event => {
          if(task.finished)return;
          const item = {...event,id:`${roundId}:${site}:${event.id}`,type:'api_tool',site,label:`${kit.LABELS[site]}：${event.label || event.name}`,
            status:event.status === 'inprogress' ? 'in_progress' : event.status};
          if(sourceTools.get(item.id)?.commandLifecycle&&!item.commandLifecycle)item.commandLifecycle=sourceTools.get(item.id).commandLifecycle;
          sourceTools.set(item.id,item);emit('item',{item});
        };
        try {
          const browsing = browsersForChat(`${chat.id}:web:${site}`,runSettings.browser || {});
          browsing.browser?.setGuard(()=>!task.cancelled&&!task.finished);
          browsing.braveBrowser?.setGuard(()=>!task.cancelled&&!task.finished);
          const approve = async data => {
            const answer = await askApproval(emit,{...data,kind:data.kind || 'mcp',detail:`${kit.LABELS[site]}：${data.detail || ''}`,cwd,signal});
            return !!answer.ok && !signal.aborted && !task.cancelled;
          };
          session = await require('./webMcpSession').create({settings:runSettings,
            selection:Array.isArray(options.extensions)?options.extensions:chat.extensions,level:runLevel,cwd,chatId:chat.id,site,signal,
            sessionRoot:path.join(userDir(),'extensions',chat.id,'web',site),version:app.getVersion(),apiKeys:planExtensionKeys || extensionApiKeys(),
            browserEnabled:!!browsing.active.primary,noDelete,approve,approveDelete:approve,onTool,
            onNotice:message=>emit('notice',{message:`${kit.LABELS[site]}：${message}`})});
          const approval = runSettings.providers.gpt.approval || 'on-request';
          const nativeTools = apiTools.definitions(runLevel,{browser:browsing.browser,braveBrowser:!!browsing.braveBrowser,approval});
          const nativeNames = new Set(nativeTools.map(t=>t.function.name));
          const toolCtx = {mode:runLevel,cwd,signal,approval,noDelete,browser:browsing.browser,braveBrowser:browsing.braveBrowser,
            approve,approveDelete:approve};
          const tools = [...nativeTools,...session.tools.filter(t=>!nativeNames.has(t.function.name))];
          useTools = tools.length > 0;
          if(!useTools){emit('notice',{message:`${kit.LABELS[site]}：目前沒有可用 MCP 工具，請載入並勾選 MCP，或調整使用權限。`});return await direct(prompt);}
          const execute = (name,args) => serializeSourceTool(async()=>{
            if(!nativeNames.has(name))return session.execute(name,args);
            const id=newId('webtool'),base={id,name,label:apiTools.label(name),args:apiTools.brief(name,args)};
            onTool({...base,status:'in_progress'});
            try{const output=await observedApiTool(name,args,toolCtx,base,onTool);onTool({...base,status:'completed',output:String(output).slice(0,4000)});return output;}
            catch(error){onTool({...base,status:'failed',output:error.message});throw error;}
          });
          return await require('./webSourceMcp').run({text:prompt,tools,signal,onDelta,onReplace,ask:direct,execute});
        } finally {
          session?.close();
          if(!httpAsk && site === 'gpt' && useTools)await require('./chatgptWeb').closeSession(common.chatKey,{profileDir:profiles.gpt,bravePath:common.bravePath}).catch(()=>{});
          if(!httpAsk && site !== 'gpt' && useTools)await require('./webModelsBrowser').closeSession(common.chatKey,{profileDir:profiles[site]}).catch(()=>{});
        }
      };
      const saveFinal = async (out, extra = {}) => {
        if (!out) return;
        chat.messages.push({id:newId('m'),role:'assistant',text:out,provider:config.target.startsWith('web:') ? config.target.slice(4) : config.target === 'claudecode' ? 'claude' : config.target.replace(/^api:/,''),
          via:config.target.startsWith('web:') ? 'web' : config.target,model:extra.model || config.model,ts:new Date().toISOString(),webSynthesis:{roundId,target:config.target,prompt:config.prompt},...extra.flags});
        await writeChat(chat);
      };
      try {
        const result = await kit.execute({question,history:kit.contextOf(merged),sourceHistory:{gemini:kit.sourceContextOf(merged,question,'gemini')},system:runSettings.systemPrompt || '',config,signal:runAbort.signal,existingResults:original?.results,
          ask:askSite,
          synthesize: async ({target,model:want,text:prompt,signal,onDelta,onReplace}) => {
            emit('status',{message:`正在由 ${target} 統合回應…`});
            if (target.startsWith('web:')) return askSite({site:target.slice(4),model:want,text:prompt,signal,onDelta,onReplace,stage:'synthesis'});
            return require('./webSynthesis').ask({target,model:want,prompt,system:runSettings.systemPrompt || '',settings:runSettings,apiConfig:synthesisApiConfig,codexHome:runSettings.codexHome,
              cwd:path.join(userDir(),'web-synthesis-workspace'),signal,onDelta,onReplace,onStatus:message=>emit('status',{message})});
          },
          onUpdate:({results,final})=>{visibleFinal=final;emit('replace',{text:kit.format(results,final)});},
          onSources:async results=>{
            if (original) return;
            sourceMessage={id:newId('m'),role:'assistant',text:kit.format(results),provider:'gpt',via:'web-ensemble',ts:new Date().toISOString(),
              tools:[...sourceTools.values()],webRound:{id:roundId,question,results,config},...(runAbort.signal.aborted?{partial:true,partialReason:task.paused?'已暫停':'已停止'}:{})};
            chat.messages.push(sourceMessage);await writeChat(chat);
          }});
        await saveFinal(result.final,{model:result.model,flags:result.cancelled?{partial:true,partialReason:task.paused?'已暫停':'已停止'}:{}});
        emit('done',{cancelled:result.cancelled});
      } catch(error) {
        await saveFinal(error.partial || visibleFinal,{flags:{partial:true,partialReason:task.paused?'已暫停':task.cancelled?'已停止':String(error.message).slice(0,500)}});
        if(!task.cancelled){chat.messages.push({id:newId('m'),role:'note',text:`（網頁模型統合未完成：${String(error.message).slice(0,1500)}）`,ts:new Date().toISOString()});await writeChat(chat);}
        if(task.cancelled)emit('done',{cancelled:true});else emit('error',{message:error.message});
      }
      return;
    }

    // ---- Grok Bot（routine webhook 送出，回覆經 ntfy 主題傳回；不使用 xAI API Key） ----
    if (provider === 'grokbot') {
      if (agentCtx || inheritedExecution) throw new Error('Grok Bot 目前只能在一般對話中使用，不能當子 agent、流程步驟或擴充代理。');
      if (files.some(a => String(a.mime || '').startsWith('image/'))) throw new Error('Grok Bot 目前只接受文字（文字檔附件會併入訊息）；圖片請改用其他模型。');
      chat.messages = chat.messages || [];
      const grokUserMessage = { id: newId('m'), role: 'user', text, attachments: files.length ? files : undefined, ts: new Date().toISOString(), provider, model: '', via: 'grokbot-webhook' };
      chat.messages.push(grokUserMessage);
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
      try { grokBotBridgeKit.validateConfig(grokBotRunConfig); }
      catch (error) { emit('error', { message: error.message, grokBotSetup: true }); return; }
      emit('notice', { message: 'Grok Bot 在雲端執行：只帶入文字指示，不提供工作台的本機工具或 MCP。停止只會中止等待，遠端 routine 可能繼續執行。' });
      emit('status', { message: '正在連線 Grok Bot…' });
      try {
        const result = await grokBotBridge().send({
          config: grokBotRunConfig, conversationId: chat.id,
          message: [runSettings.systemPrompt && `本次對話的文字指示（不授予本機工具權限）：\n${runSettings.systemPrompt}`,text].filter(Boolean).join('\n\n'),
          history: merged, workspace: grokBotRunConfig.sendWorkspace ? cwd || '' : '', signal: runAbort.signal,
          onRequest: async ({messageId}) => {grokUserMessage.grokBotRequest={id:messageId,state:'waiting'};await writeChat(chat);},
          onStatus: message => emit('status', { message }),
        });
        if(task.cancelled || runAbort.signal.aborted){grokUserMessage.grokBotRequest.state='stopped';await writeChat(chat);emit('done',{cancelled:true});return;}
        grokUserMessage.grokBotRequest.state='completed';
        chat.messages.push({ id: newId('m'), role: 'assistant', text: result.reply, ts: new Date().toISOString(), provider, model: '', via: 'grokbot-webhook', grokBotMessageId: result.messageId });
        await writeChat(chat);
        emit('replace', { text: result.reply });
        emit('done', { cancelled: false });
      } catch (error) {
        if(grokUserMessage.grokBotRequest){grokUserMessage.grokBotRequest.state=task.cancelled || runAbort.signal.aborted ? 'stopped':'failed';await writeChat(chat);}
        if (task.cancelled || runAbort.signal.aborted || error.name === 'AbortError') { emit('done', { cancelled: true }); return; }
        emit('error', { message: error.message, grokBotSetup: ['GROKBOT_NOT_CONFIGURED', 'GROKBOT_BAD_CONFIG'].includes(error.code) || (error.code === 'GROKBOT_WEBHOOK' && [401, 403, 404].includes(error.status)) });
      }
      return;
    }

    // ---- Grok Build（xAI 官方 grok CLI，經 ACP；grok.com 帳號登入，工具操作逐次回頭由工作台決定） ----
    if (provider === 'grokbuild') {
      if (agentCtx || inheritedExecution) throw new Error('Grok Build 目前只能在一般對話中使用，不能當子 agent、流程步驟或擴充代理。');
      const gbCfg = runSettings.providers.grokbuild || {};
      const permission = grokBuild.level(options.permission || gbCfg.permission);
      const useModel = String(model || gbCfg.model || '').trim();
      const effort = options.effort || gbCfg.effort || 'default';
      const cli = grokBuild.cliPath();
      const images = attachments.imagePaths(files, path.join(userDir(), 'attachments'));
      chat.messages = chat.messages || [];
      chat.messages.push({ id: newId('m'), role: 'user', text, attachments: files.length ? files : undefined, ts: new Date().toISOString(), provider, model: useModel });
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
      const history = merged.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
      const workDir = cwd || path.join(userDir(), 'grok-build', 'workspace', chat.id);
      await fsp.mkdir(workDir, { recursive: true });
      const saved = chat.grokBuild && chat.grokBuild.sessionId && normDir(chat.grokBuild.cwd) === normDir(workDir) ? chat.grokBuild : null;
      const identity = `（系統資訊：這次透過 xAI Grok Build CLI 呼叫${useModel ? `，使用的模型是「${useModel}」` : ''}。被問到模型或版本時以此為準。）`;
      const permNote = permission === 'read-only' || planNoTools ? '本回合只允許讀取；寫檔、執行指令等操作都會被拒絕，不要嘗試繞過。'
        : permission === 'ask' ? '寫檔、執行指令等操作會逐次請使用者在工作台同意；被拒絕時不要改用其他方式繞過。' : '工作台已允許寫檔與執行指令；刪除仍受使用者的刪除保護設定限制。';
      const where = cwd ? `使用者目前選的專案資料夾是「${cwd}」。` : `使用者沒有選專案資料夾，工作資料夾是工作台的暫存區「${workDir}」。`;
      const mediaNote = images.length ? `使用者附上的圖片檔（Grok Build 不直接接收圖片，請用讀檔工具查看）：\n${images.map(p => `- ${p}`).join('\n')}` : '';
      const note = `（工作台說明：${where}${permNote}必須有成功的工具結果才可說已完成操作。）`;
      const tail = `${text}${mediaNote ? `\n\n${mediaNote}` : ''}`;
      const fresh = () => `${[runSettings.systemPrompt, identity, note].filter(Boolean).join('\n')}\n\n${history.length ? contextBlock(history, archive) : ''}${tail}`;
      const resumed = s => {
        const unseen = history.slice(Math.min(history.length, Number(s.synced) || 0));
        return `${identity}\n${note}\n${unseen.length ? `（這段期間使用者在其他模型的往來：）\n${contextBlock(unseen, archive)}\n\n` : ''}${tail}`;
      };
      const controller = new AbortController();
      task.attach({ cancel: () => controller.abort() });
      const toolLog = new Map();
      if(!planNoTools){
        const browsing=browsersForChat(chat.id,runSettings.browser || {});
        browsing.browser?.setGuard(()=>!task.cancelled&&!task.finished&&!controller.signal.aborted);
        browsing.braveBrowser?.setGuard(()=>!task.cancelled&&!task.finished&&!controller.signal.aborted);
        const browserTools=apiTools.definitions('read-only',{browser:browsing.browser,braveBrowser:browsing.braveBrowser}).filter(t=>/^(browser|brave)_/.test(t.function.name));
        if(browserTools.length)nativeBridge=await require('./mcpBridge').createBridge({browserOnly:true,tools:browserTools,extraInstructions:browserPolicy.toolGuidance(runSettings.browser || {}),cancelled:()=>task.cancelled||task.finished||controller.signal.aborted,execute:async(name,args)=>{
          const id=newId('grok_browser'),base={id,type:'api_tool',name,label:apiTools.label(name),args:apiTools.brief(name,args)};
          emit('item',{item:{...base,status:'in_progress'}});
          try{const output=await observedApiTool(name,args,{mode:'read-only',browser:browsing.browser,braveBrowser:browsing.braveBrowser,signal:controller.signal},base);emit('item',{item:{...base,status:'completed',output:String(output).slice(0,4000)}});return output;}
          catch(error){emit('item',{item:{...base,status:'failed',output:error.message}});throw error;}
        }});
      }
      const runId = newId('grokbuild');
      const toolBrief = call => {
        const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
        return String(input.command || input.cmd || input.path || input.file_path || input.target_file || input.url || input.query || (Object.keys(input).length ? JSON.stringify(input) : '')).slice(0, 400);
      };
      const onTool = call => {
        const status = call.status === 'completed' ? 'completed' : call.status === 'failed' ? 'failed' : 'in_progress';
        const output = Array.isArray(call.content) ? call.content.map(c => grokBuild.textOf(c)).join('\n') : call.rawOutput ? (typeof call.rawOutput === 'string' ? call.rawOutput : JSON.stringify(call.rawOutput)) : '';
        const label = String(call.title || call.kind || '工具');
        toolLog.set(call.toolCallId, { name: label, args: toolBrief(call), status, output: String(output).slice(0, 2400) });
        emit('item', { item: { id: `${runId}_${call.toolCallId}`, type: 'api_tool', name: String(call.kind || 'tool'), label, args: toolBrief(call), status, output: String(output).slice(0, 4000) } });
      };
      const gbNoDelete = runSettings.guard?.noDelete === true;
      const decide = call => grokBuild.decideTool(call, { permission, planOnly: planNoTools, noDelete: gbNoDelete,
        isDelete: c => c.kind === 'delete' || !!deleteGuardKit.detectToolCall(c.title, c.rawInput),
        ask: async kind => (await askApproval(emit, { kind: kind === 'delete' ? 'delete' : 'command', detail: `Grok Build：${call.title || call.kind || '工具操作'}\n${toolBrief(call)}`, cwd: workDir, signal: controller.signal, allowAlways: false })).ok });
      const attempt = s => grokBuild.run({ cli, cwd: workDir, model: useModel, effort, mcpServers:nativeBridge?.grokServers || [], prompt: [s ? resumed(s) : fresh(),!planNoTools ? browserPolicy.toolGuidance(runSettings.browser || {}) : ''].filter(Boolean).join('\n\n'), sessionId: s ? s.sessionId : '', signal: controller.signal, decide,
        onDelta: t => emit('delta', { text: t }), onThought: t => emit('reasoning', { text: t }), onTool, onStatus: message => emit('status', { message }) });
      try {
        let result;
        try { result = await attempt(saved); } catch (e) {
          if (!saved || controller.signal.aborted || e.name === 'AbortError' || e.streamed || e.code === 'GROKBUILD_LOGIN') throw e;
          result = await attempt(null);
        }
        if (saved && !result.resumed) emit('notice', { message: '原本的 Grok Build 對話已無法接續，這次開了新對話並帶入先前內容。' });
        chat.grokBuild = { sessionId: result.sessionId, cwd: workDir, synced: history.length + 2 };
        const used = [...toolLog.values()];
        chat.messages.push({ id: newId('m'), role: 'assistant', text: result.text, tools: used.length ? used : undefined, ts: new Date().toISOString(), provider, model: useModel, via: 'grok-build-cli' });
        await writeChat(chat);
        emit('done', { cancelled: false });
      } catch (e) {
        const used = [...toolLog.values()];
        if (e.streamed || used.length) {
          chat.messages.push({ id: newId('m'), role: 'assistant', text: e.streamed || '', tools: used.length ? used : undefined, ts: new Date().toISOString(), provider, model: useModel, via: 'grok-build-cli', partial: true, partialReason: controller.signal.aborted ? (task.paused ? '已暫停' : '已停止') : String(e.message).slice(0, 500) });
          if (e.sessionId) chat.grokBuild = { sessionId: e.sessionId, cwd: workDir, synced: history.length + 2 };
          await writeChat(chat);
        }
        if (controller.signal.aborted || e.name === 'AbortError') emit('done', { cancelled: true });
        else emit('error', { message: e.message, grokBuildLogin: e.code === 'GROKBUILD_LOGIN' });
      }
      return;
    }

    const isNative = provider==='codex' || (provider==='gpt' && (options.via || runSettings.providers.gpt.via)==='codex') || (provider==='claude' && (options.via || runSettings.providers.claude.via)==='claudecode');
    const claudePermission = options.claudePermission || runSettings.providers.claude.permission || 'default';
    const nativePermission = provider==='codex' ? options.sandbox || runSettings.providers.codex.sandbox : provider==='claude' ? claudePermission : options.permission || runSettings.providers.gpt.permission || 'chat';
    const runLevel = provider === 'antigravity' ? antigravity.level(options.permission || runSettings.providers.antigravity.permission || 'chat') : !isNative ? (options.permission || (provider === 'claude' ? runSettings.providers.claude.apiPermission : runSettings.providers[provider].permission) || 'chat')
      : provider === 'claude' ? claudeLevel(claudePermission) : codexLevel(nativePermission);
    // 主 agent 才能建立子 agent（子 agent 不再往下分派，避免失控）；僅聊天模式不提供，仍可從畫面手動建立
    const canSpawn = !agentCtx && runSettings.agents?.modelSpawn !== false && runLevel !== 'chat';
    const noDelete = runSettings.guard?.noDelete === true;
    const agentItem = async (name, args, signal) => {
      const id = newId('agent');
      const base = { id, type: 'api_tool', name, label: agentKit.TOOL_LABELS[name], args: String(args.name || (args.task || '').slice(0, 80) || args.agent_id || (args.agent_ids || []).join(', ')) };
      emit('item', { item: { ...base, status: 'in_progress' } });
      try {
        const out = await agents.handleTool(name, args, { parentKey: key, cwd, level: runLevel, provider, model: model || '', reqId, signal, extensions: extSelection });
        emit('item', { item: { ...base, status: 'completed' } });
        return out;
      } catch (e) { emit('item', { item: { ...base, status: 'failed', args: e.message } }); throw e; }
    };
    // ---- 能力擴充（Prime Agent／Zenith／Scrapling／自訂 MCP，三者各自獨立）----
    const wantedExtensions = extensionsKit.selectionFor(runSettings, Array.isArray(options.extensions) ? options.extensions : (Array.isArray(chat.extensions) ? chat.extensions : undefined)).filter((id) => !['scriptDoctor', 'companion', 'harness'].includes(id));
    // Antigravity 只透過本機服務聊天，沒有工具通道：擴充這次不啟用
    const toolExtensions = wantedExtensions.filter(id=>extensionsKit.allPacks(runSettings).find(pack=>pack.id===id)?.kind !== 'prompt');
    const extSelection = provider === 'antigravity' ? [] : toolExtensions;
    if (provider === 'antigravity' && toolExtensions.length) emit('notice', { message: 'Antigravity CLI 尚未接入這些工具型 skill；Markdown 提示仍可使用。' });
    if (extSelection.length) {
      const childOptions = {...agentKit.optionsFor(provider,runLevel,runSettings.providers),...options,extensions:[]};
      const gptWeb = provider==='gpt' && childOptions.via==='web';
      // 「模仿 Codex 架構」開啟時，網頁版自己就能透過本機橋接呼叫工具，代理不必改走 Codex 帳號
      const webAgentOn = gptWeb && runSettings.providers.gpt.webAgent === true;
      const chosenModel = model || (provider==='claude' && childOptions.via==='claudecode' ? runSettings.providers.claude.cliModel : gptWeb ? runSettings.providers.gpt.webModel : runSettings.providers[provider]?.model) || '';
      // ChatGPT 網頁版只能聊天：純聊天的擴充（陪伴角色、RAGthoven、Script Doctor）照樣用網頁版；
      // 要呼叫工具的代理改走同一個 ChatGPT 訂閱的 Codex 帳號，並明講原因
      const CHAT_ONLY = ['ragthoven','scriptDoctor','companion','harness-prompt'];
      let webNoticeSent = false;
      const runnerOptions = name => {
        const base = CHAT_ONLY.includes(name)?{...childOptions,permission:'chat',sandbox:'read-only',claudePermission:'chat'}:childOptions;
        if (!gptWeb || webAgentOn || CHAT_ONLY.includes(name)) return base;
        if (!webNoticeSent) { webNoticeSent = true; emit('notice',{message:`${name}：ChatGPT 網頁版沒辦法讓代理呼叫工具，這個代理改用同一個 ChatGPT 訂閱的 Codex 帳號執行。`}); }
        return {...base, via:'codex'};
      };
      const inheritedRunner = name => require('./conversationAgent').create({
        run:(request,sink)=>handleSend(sink,request,{settings:runSettings,apiConfig}),
        cancel:id=>running.get(id)?.cancel(),readChat,writeChat,deleteChat:id=>fsp.rm(chatPath(id),{force:true}),newId,parentKey:key,cwd,provider,model:gptWeb && !webAgentOn && !CHAT_ONLY.includes(name) ? (runSettings.providers.gpt.model || '') : chosenModel,options:runnerOptions(name),
        sessionFile:path.join(userDir(),'extensions',chat.id,`${name}-conversation-agent.json`),
        onNotice:message=>emit('notice',{message}),
        onApproval:ev=>emit('approval',{id:ev.id,kind:ev.kind,detail:ev.detail,cwd:ev.cwd}),
      });
      // 陪伴角色：接管這段對話的回覆，使用者看到的是角色本人說的話（不經過工具呼叫與助理轉述）
      if (!agentCtx && extSelection.includes('companion')) { await companionTurn({ emit, task, chat, text, files, provider, model: chosenModel, runSettings, extSelection, runner: inheritedRunner('companion') }); return; }
      // 自訂 Harness 模式：這段對話的訊息交給腳本跑流程
      if (!agentCtx && extSelection.includes('harness')) {
        const LEVELS = require('./harness').LEVELS;
        const runners = new Map();
        const announced = new Set();
        const harnessNotice = (message) => {
          const m = /^[^：]*：(沿用 .*工作台代理引擎)$/.exec(String(message || ''));
          if (m) { if (announced.has(m[1])) return; announced.add(m[1]); emit('notice', { message: `Harness 步驟${m[1]}` }); return; }
          emit('notice', { message });
        };
        const runnerFor = async ({ type, model: want, permission, session }) => {
          // 模型：留空／沿用對話＝目前對話；「模型 ID」＝同一家換模型；「供應商/模型 ID」＝換一家
          let p = provider, m = gptWeb && type === 'agent' ? (runSettings.providers.gpt.model || '') : chosenModel;
          const w = String(want || '').trim();
          if (w && w !== '沿用對話') {
            const mm = /^([a-z]+)\/(.+)$/i.exec(w);
            const all = ['codex', 'gpt', 'claude', 'deepseek', 'gemini', 'grok', 'meta', 'ablit', 'lmstudio'];
            if (mm && all.includes(mm[1].toLowerCase())) { p = mm[1].toLowerCase(); m = mm[2].trim(); } else m = w;
          }
          const chatOnly = type !== 'agent';
          const cur = LEVELS.indexOf(runLevel);
          let lv = chatOnly ? 'chat' : runLevel;
          if (!chatOnly && permission && LEVELS.indexOf(permission) >= 0 && (cur < 0 || LEVELS.indexOf(permission) < cur)) lv = permission;
          const cacheKey = [type === 'agent' ? session : type, p, m, lv].join('|');
          if (runners.has(cacheKey)) return runners.get(cacheKey);
          let opts, cfg;
          if (p === provider) {
            opts = { ...childOptions };
            if (gptWeb && !chatOnly) opts.via = 'codex';
            cfg = apiConfig;
          } else {
            opts = { ...agentKit.optionsFor(p, lv, runSettings.providers), extensions: [] };
            if (p === 'gpt' && runSettings.providers.gpt.via === 'web' && !chatOnly) opts.via = 'codex';
            if (p === 'gpt' && runSettings.providers.gpt.via === 'web' && chatOnly) opts.via = 'web';
            const native = p === 'codex' || (p === 'gpt' && opts.via !== 'api' && opts.via !== undefined) || (p === 'claude' && opts.via === 'claudecode');
            cfg = p === 'codex' ? null : providerCfg(p);
            if (!native && p !== 'lmstudio' && !(cfg && cfg.apiKey)) throw new Error(`步驟指定的「${w}」要用 ${(providers.PROVIDERS[p] || { label: p }).label} 的 API 金鑰，但還沒設定。請到「API 設定」填好，或把這一步的「模型」改成「沿用對話」。`);
          }
          if (lv !== (p === provider ? runLevel : lv) || chatOnly) Object.assign(opts, { permission: lv, sandbox: lv === 'chat' ? 'read-only' : lv, claudePermission: { chat: 'chat', 'read-only': 'plan', 'workspace-write': 'default', 'danger-full-access': 'bypassPermissions' }[lv] });
          if (p === 'claude' && opts.via === 'claudecode' && !m) m = runSettings.providers.claude.cliModel || '';
          const safe = String(session || type).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
          const base = require('./conversationAgent').create({
            run: (request, sink) => handleSend(sink, request, { settings: runSettings, apiConfig: cfg }),
            cancel: (id) => running.get(id)?.cancel(), readChat, writeChat, deleteChat: (id) => fsp.rm(chatPath(id), { force: true }), newId, parentKey: key, cwd, provider: p, model: m, options: opts,
            sessionFile: path.join(userDir(), 'extensions', chat.id, `harness-${safe}-conversation-agent.json`),
            onNotice: harnessNotice,
            onApproval: (ev) => emit('approval', { id: ev.id, kind: ev.kind, detail: ev.detail, cwd: ev.cwd }),
          });
          // 純文字步驟：不當任務代理、用完就刪掉子對話
          const runner = chatOnly ? { ask: (message, o = {}) => base.ask(message, { ...o, followup: false, preamble: '', ephemeral: true }) } : base;
          runners.set(cacheKey, runner);
          return runner;
        };
        const history = merged.filter((x) => (x.role === 'user' || x.role === 'assistant') && x.text && x.text.trim()).slice(-20)
          .map((x) => `[${x.role === 'user' ? '使用者' : '助理'}]\n${x.text.trim().slice(0, 3000)}`).join('\n\n').slice(-20000);
        const scriptChoice = (typeof options.harnessScript === 'string' && options.harnessScript) || chat.harness?.script || ((runSettings.extensions?.config || {}).harness || {}).defaultScript || '';
        if (typeof options.harnessScript === 'string' && options.harnessScript) { chat.harness = { script: options.harnessScript }; require('./chatLive').remember(chat.id, { harness: chat.harness }); }
        await harnessTurn({ emit, task, chat, text, files, provider, model: chosenModel, runSettings, extSelection, runnerFor, scriptChoice, history, cwd, level: runLevel });
        return;
      }
      extSession = await extensionsKit.openSession({
        settings: runSettings,
        selection: extSelection,
        level: runLevel,
        noToolsInChat: isNative,
        cwd,
        chatId: chat.id,
        sessionRoot: path.join(userDir(), 'extensions', chat.id),
        version: app.getVersion(),
        apiKeys: planExtensionKeys || extensionApiKeys(),
        conversation: {provider,model:gptWeb ? (runSettings.providers.gpt.model || '') : chosenModel,via:gptWeb ? 'codex' : childOptions.via || (provider==='codex'?'codex':'api'),endpoint:apiConfig?{apiKey:apiConfig.apiKey||'',baseUrl:apiConfig.baseUrl||''}:null},
        createConversationAgent:inheritedRunner,
        onNotice:message=>emit('notice',{message}),
      });
      if (task.cancelled) { extSession.close(); extSession = null; await keepCancelledUser(); emit('done', { cancelled: true }); return; }
      for (const message of extSession.notices) emit('notice', { message });
      if (extSession.active.length) {
        emit('status', { message: `已啟用擴充：${extSession.active.map((a) => `${a.name}（${a.tools} 個工具）`).join('、')}` });
      } else if (extSelection.length) {
        emit('notice', { message: '這次勾選的擴充都沒有啟用成功，模型手上不會有那些工具。請看上面的原因說明。' });
      }
    }
    const extHint = extensionsKit.promptHint(extSession?.active);
    const extTools = extSession?.tools || [];
    const runExtTool = async (name, args, signal) => {
      const id = newId('ext');
      const base = { id, type: 'api_tool', name, label: extSession.label(name), args: apiTools.brief(name, args) };
      emit('item', { item: { ...base, status: 'in_progress' } });
      try {
        const output = await extSession.execute(name, args, { signal });
        emit('item', { item: { ...base, status: 'completed', output: String(output).slice(0, 4000) } });
        return output;
      } catch (e) {
        emit('item', { item: { ...base, status: 'failed', output: e.message } });
        throw new Error(e.message);
      }
    };

    if (isNative && noDelete && nativePermission !== 'chat' && !planNoTools) {
      deleteGuard = await deleteGuardKit.startGuard({ ask: async ({ reason, detail }) => (await askApproval(emit, { kind: 'delete', detail: `${reason}\n\n${detail}`, cwd, signal: runAbort.signal })).ok });
    }
    // 不要把 ELECTRON_RUN_AS_NODE 放進 CLI 的環境：它會一路傳給模型執行的所有指令，
    // 讓模型開的任何 Electron 程式（VS Code、其他 App）都變成 Node 模式而開不起來。
    // hook 沒帶這個變數也沒關係：main.js 最前面會攔下 deleteGuardHook.js，自己改用 Node 模式重跑。
    const guardEnv = deleteGuard ? { ...deleteGuard.env } : null;
    if (isNative && !planNoTools) {
      const mode=['danger-full-access','bypassPermissions'].includes(nativePermission)?'danger-full-access':'read-only';
      const browsing = browsersForChat(chat.id, runSettings.browser || {});
      browsing.browser?.setGuard(()=>!task.cancelled&&!task.finished);
      browsing.braveBrowser?.setGuard(()=>!task.cancelled&&!task.finished);
      if (browsing.active.conversation && browsing.browser) {
        const requested = require('./browserChoice').requestedWangpin(String(req.text || ''), merged, browsing.browser.info()?.browser);
        if (requested) await browsing.browser.select({browser:requested});
      }
      const browserCtx = { mode, cwd, browser: browsing.browser, braveBrowser: browsing.braveBrowser };
      const browserProvider = provider==='claude' && (options.via || runSettings.providers.claude.via)==='claudecode' ? 'claude-cli' : provider;
      const exposedBrowsers = browserPolicy.nativeAvailability(runSettings.browser || {}, browserProvider);
      const tools=[...apiTools.definitions(mode,{browser:exposedBrowsers.primary ? browsing.browser : null,braveBrowser:!!browsing.braveBrowser && exposedBrowsers.brave}).filter(t=>/^(?:browser|brave)_/.test(t.function.name)), ...(browsing.active.brave ? [require('./braveVisible').tool] : []), contextManager.historyTool, ...(canSpawn?agentKit.TOOLS:[]), ...extTools];
      const extInstructions=extSession?.active.length?`The user explicitly enabled these capability packs for this turn — actually call them instead of your own built-in equivalents (e.g. use scrapling_* rather than WebFetch/web search), do not just mention them: ${extSession.active.map((a)=>`${a.name} (${(a.toolNames||[]).join(', ')})`).join('; ')}.`:'';
      // Claude Code 會截斷過長的 MCP 說明，Claude 的瀏覽器指引改放系統提示（見下方 runChat）
      const browserInstructions = provider === 'codex' ? browserPolicy.codexGuidance(runSettings.browser || {}, runSettings.codexHome) : browserProvider === 'claude-cli' ? '' : browserPolicy.toolGuidance(runSettings.browser || {});
      const rejectingWangpin = /(?:不要|別用|不用|不使用).{0,12}王品\s*(?:瀏覽器|browser)|(?:改用|換成|改到|使用).{0,12}(?:brave|chrome|edge|firefox)/i.test(String(req.text || ''));
      selectedWangpin = !rejectingWangpin && (browsing.active.wangpin || (browsing.active.conversation && browsing.browser?.info()?.browser === 'wangpin'));
      // 這次執行的取消，加上呼叫端放棄那一次工具呼叫的取消：任何一邊喊停都要真的停下來
      const callSignal=(extra)=>{
        if(!extra)return runAbort.signal;
        try{return AbortSignal.any([runAbort.signal,extra]);}catch{return runAbort.signal;}
      };
      nativeBridge=await require('./mcpBridge').createBridge({tools,extraInstructions:[extInstructions,browserInstructions].filter(Boolean).join('\n\n'),cancelled:()=>task.cancelled||task.finished,execute:async(name,args,opts)=>{
        if(name==='read_conversation')return contextManager.readHistory(merged,args);
        if(agentKit.TOOL_NAMES.has(name))return agentItem(name,args,callSignal(opts?.signal));
        if(extSession?.has(name))return runExtTool(name,args,callSignal(opts?.signal));
        const id=newId('browser');emit('item',{item:{id,type:'api_tool',name,args:apiTools.brief(name,args),status:'in_progress'}});
        try {const output=name==='brave_open_visible'?await openVisibleBrave(args.url):await observedApiTool(name,args,browserCtx,{id,type:'api_tool',name,args:apiTools.brief(name,args)});emit('item',{item:{id,type:'api_tool',name,args:apiTools.brief(name,args),status:'completed'}});return output;}
        catch(e){emit('item',{item:{id,type:'api_tool',name,args:e.message,status:'failed'}});throw e;}
      }});
      if(task.cancelled){await keepCancelledUser();emit('done',{cancelled:true});return;}
    }

    const effortArgs = (effort) => (effort && effort !== 'default' && /^[a-z]+$/.test(effort) ? ['-c', `model_reasoning_effort=${effort}`] : []);

    if (provider === 'codex') {
      const visibleBrave = require('./braveVisible');
      const directUrl = files.length ? null : visibleBrave.request(text);
      if (directUrl && browserPolicy.availability(runSettings.browser || {}).brave) {
        const item = { id: newId('brave'), type: 'api_tool', name: 'brave_open_visible', label: '在 Brave 開啟可見分頁', args: directUrl, status: 'in_progress' };
        chat.messages = chat.messages || [];
        chat.messages.push({ id: newId('m'), role: 'user', text, ts: new Date().toISOString(), provider, model });
        chat.lastProvider = provider; await writeChat(chat); emit('started', {}); emit('item', { item });
        const output = await openVisibleBrave(directUrl);
        emit('item', { item: { ...item, status: 'completed', output } }); emit('delta', { text: output });
        chat.messages.push({ id: newId('m'), role: 'assistant', text: output, tools: [{ name: '在 Brave 開啟可見分頁', args: directUrl }], ts: new Date().toISOString(), provider, model });
        await writeChat(chat); emit('done', { cancelled: false }); return;
      }
      const lastCodexTs = merged.filter((m) => m.source === 'codex').reduce((acc, m) => Math.max(acc, Date.parse(m.ts) || 0), 0);
      const pendingOther = planKit.handoffMessages((chat.messages || []).filter((m) => (Date.parse(m.ts) || 0) > lastCodexTs));
      // Browser guidance belongs to the per-run MCP instructions, never the
      // user prompt: native rollouts are shared with every other provider.
      const prompt = (extHint ? extHint + '\n\n' : '') + (pendingOther.length ? contextBlock(pendingOther, archive) : '') + text;
      chat.lastProvider = 'codex';
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });

      let attempt = 0;
      const partial = require('./codexPartial').create();
      let partialSaved = false;
      const savePartial = async reason => {
        if (partialSaved) return; partialSaved = true;
        const content = partial.snapshot();
        if (!content.text && !content.reasoning && !content.tools.length) return;
        chat.messages.push({ id: newId('m'), role: 'assistant', ...content, ts: new Date().toISOString(), provider: 'codex', model: model || '', partial: true, partialReason: reason });
        await writeChat(chat);
      };
      const run = async (mode) => {
        const generation = ++attempt;
        if (task.cancelled) { await keepCancelledUser(); emit('done', { cancelled: true }); return; }
        const target = chat.codexActiveThreadId || chat.codexThreadId || null;
        const handle = await codexRunner.runCodex({
          customPath: runSettings.providers.codex.path,
          codexHome: runSettings.codexHome,
          signal: runAbort.signal,
          prompt,
          images: attachments.imagePaths(files, path.join(userDir(), 'attachments')),
          cwd,
          threadId: target,
          mode,
          sandbox: options.sandbox || runSettings.providers.codex.sandbox,
          model: model || '',
          extraArgs: [...effortArgs(options.effort), ...((chatSystem || selectedWangpin) ? ['-c', 'developer_instructions=' + JSON.stringify([chatSystem, selectedWangpin ? browserPolicy.codexGuidance(runSettings.browser || {}, runSettings.codexHome) : ''].filter(Boolean).join('\n\n'))] : []), ...(nativeBridge?.codexArgs || []), ...(deleteGuard ? deleteGuardKit.codexArgs(process.execPath) : []), ...(planNoTools ? require('./webSynthesis').codexArgs(runSettings.systemPrompt || '') : [])],
          extraEnv: guardEnv,
        }, guardNative({
          onThread: async (tid) => {
            if (!tid) return;
            if (!chat.codexThreadId) {
              chat.codexThreadId = tid;
              await writeChat(chat);
              emit('thread', { threadId: tid });
            } else if (mode === 'fork' && tid.toLowerCase() !== String(target).toLowerCase()) {
              chat.codexActiveThreadId = tid;
              await writeChat(chat);
            }
          },
          onItem: (item, phase) => { partial.capture(item); emit('item', { item, phase }); },
          onNotice: (message) => emit('status', { message }),
          onDone: async (info) => { if (info.cancelled) { await keepCancelledUser(); await savePartial(task.paused ? '已暫停' : '已停止'); } emit('done', { threadId: info.threadId, usage: info.usage, cancelled: !!info.cancelled }); },
          onError: async (message, info) => {
            if (info && info.writerConflict && mode === 'resume' && !task.cancelled) {
              if (options.onLock === 'fork') {
                emit('status', { message: '改用分支接續（內容會完整帶過去，但不會同步回 Codex App 原本的對話）' });
                run('fork').catch(err => emit('error', { message: err.message }));
                return;
              }
                        emit('locked', { text });
              return;
            }
            await savePartial(String(message).slice(0, 500));
            emit('error', { message, authRequired: !!info?.authRequired });
          },
        }));
        if (generation === attempt) task.attach(handle);
      };
      run('resume').catch(err => emit('error', { message: err.message }));
      return;
    }

    // ---- Google Antigravity（沿用 Antigravity App 已登入的 Google 帳號與額度，不用 API 金鑰） ----
    if (provider === 'antigravity') {
      const imageTransport = require('./antigravityImages');
      const images = imageTransport.collect(merged, files, path.join(userDir(), 'attachments'));
      const visibleBrave = require('./braveVisible');
      const directUrl = files.length ? null : visibleBrave.request(text);
      if (directUrl && browserPolicy.availability(runSettings.browser || {}).brave) {
        const item = { id: newId('brave'), type: 'api_tool', name: 'brave_open_visible', label: '在 Brave 開啟可見分頁', args: directUrl, status: 'in_progress' };
        chat.messages = chat.messages || [];
        chat.messages.push({ id: newId('m'), role: 'user', text, ts: new Date().toISOString(), provider, model });
        chat.lastProvider = provider; await writeChat(chat); emit('started', {}); emit('item', { item });
        const output = await openVisibleBrave(directUrl);
        emit('item', { item: { ...item, status: 'completed', output } }); emit('delta', { text: output });
        chat.messages.push({ id: newId('m'), role: 'assistant', text: output, tools: [{ name: '在 Brave 開啟可見分頁', args: directUrl }], ts: new Date().toISOString(), provider, model });
        await writeChat(chat); emit('done', { cancelled: false }); return;
      }
      const agCfg = runSettings.providers.antigravity || {};
      const wantEffort = options.effort || agCfg.effort || 'default';
      const st = await antigravity.status();
      if (st.usageError) emit('notice', { message: `Antigravity 額度暫時讀不到；仍會嘗試送出訊息。${st.usageError}` });
      const picked = antigravity.resolveModel(st, String(model || agCfg.model || '').trim(), wantEffort);
      if (images.length && picked.variant.images === false) throw new Error(`「${picked.variant.label}」不支援圖片；請選擇 Antigravity 的 Claude 或 Gemini 模型。`);
      if (picked.effortMissing) emit('notice', { message: `「${picked.family}」沒有這個推理強度，這次改用 ${picked.variant.label}。` });
      const useModel = picked.variant.label;
      const userMsg = { id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model: useModel };
      chat.messages = chat.messages || [];
      chat.messages.push(userMsg);
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
      const history = merged.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
      const identity = `（系統資訊：這次透過 Google Antigravity 呼叫，使用的模型是「${useModel}」。被問到模型或版本時以此為準。）`;
      const controller = new AbortController();
      task.attach({ cancel: () => controller.abort() });
      const permission = options.permission || agCfg.permission || 'chat';
      const browsing = browsersForChat(chat.id, runSettings.browser || {});
      browsing.browser?.setGuard(() => !task.cancelled && !task.finished);
      browsing.braveBrowser?.setGuard(() => !task.cancelled && !task.finished);
      // 「僅聊天」以外：讓 Antigravity CLI 用自己的工具操作電腦（跟 Antigravity App 一樣）。
      // 每次工具呼叫都經 hook 回頭讓工作台依權限放行、擋下或跳同意卡；刪除保護一樣有效。
      if (permission !== 'chat') {
        const agent = require('./antigravityAgent');
        const cli = antigravity.cliPath();
        if (!cli) throw new Error('尚未安裝 Antigravity CLI。請在帳號選單按「安裝 CLI」。');
        agent.removeStaleRootHook(path.join(userDir(), 'antigravity-cli', 'workspace'));
        const workspace = agent.prepareWorkspace(path.join(userDir(), 'antigravity-cli', 'workspace', chat.id));
        const hostTools = apiTools.definitions(runLevel, { browser: browsing.browser, braveBrowser: !!browsing.braveBrowser }).filter(t => /^(browser|brave)_/.test(t.function.name));
        if (browsing.active.brave) hostTools.push(visibleBrave.tool);
        if (hostTools.length) {
          nativeBridge = await require('./mcpBridge').createBridge({ tools: hostTools, cancelled: () => task.cancelled || task.finished, extraInstructions: 'Brave 開新分頁必須用 brave_open_visible；不可用 Shell 啟動成功冒充網頁已載入。', execute: async (name, args) => {
            const item = { id: newId('agy_browser'), type: 'api_tool', name, label: name === 'brave_open_visible' ? '在 Brave 開啟可見分頁' : apiTools.label(name), args: apiTools.brief(name, args), status: 'in_progress' };
            emit('item', { item });
            try {
              const output = name === 'brave_open_visible' ? await openVisibleBrave(args.url) : await observedApiTool(name, args, { mode: runLevel, cwd, browser: browsing.browser, braveBrowser: browsing.braveBrowser }, item);
              emit('item', { item: { ...item, status: 'completed', output } }); return output;
            } catch (error) { emit('item', { item: { ...item, status: 'failed', output: error.message } }); throw error; }
          } });
        }
        agent.configureBrowserBridge(workspace, nativeBridge);
        const always = {};
        const liveReviewContext = [];
        const rememberReviewContext = entry => { liveReviewContext.push(entry); if (liveReviewContext.length > 12) liveReviewContext.shift(); };
        const reviewLog = new Map();
        const policy = { permission, cwd, noDelete, browser: !!(browsing.browser || browsing.braveBrowser), hostBrowserTools: hostTools.map(t => t.function.name), always };
        const review = permission === 'codex-review' && accountLease ? require('./codexToolReview').createReviewer({
          customPath: runSettings.providers.codex.path, codexHome: accountLease.home, model: runSettings.providers.codex.model,
          onQueue: position => emit('status',{message:position ? `Codex 審核正在排隊（第 ${position} 位），最多等待 5 分鐘；按停止可取消。` : 'Codex 排隊已結束，正在審核這次操作…'}),
          getContext: () => [...history.slice(-12), ...liveReviewContext],
          request: text, priorRequests: history.filter(m => m.role === 'user').map(m => m.text).slice(-6), cwd, noDelete, signal: controller.signal,
        }) : null;
        const hookServer = await agent.startHookServer(async (call) => {
          if(planNoTools)return {decision:'deny',reason:'wangpinplan 的 Plan 階段不允許呼叫本機工具；請依提供的資料回傳規劃文字。'};
          const id = newId('codex_review');
          return agent.authorize(call, policy, {
            review, signal: controller.signal, active: () => !task.cancelled && !task.finished,
            approve: d => askApproval(emit, { ...d, cwd, signal: controller.signal, allowAlways: permission !== 'codex-review' }),
            onReview: event => {
              const started = event.state === 'started';
              if (!started) reviewLog.set(id, { name: `Codex 操作審核（${{allow:'允許',deny:'拒絕',ask:'手動確認',cancelled:'取消'}[event.state]}）`, args: `${agent.brief(call.name, call.args)}\n${event.reason || ''}` });
              emit('status', { message: started ? `Codex 正在審核：${agent.label(call.name)}…` : `Codex 審核${{allow:'允許',deny:'拒絕',ask:'需要手動確認',cancelled:'已取消'}[event.state]}：${event.reason || ''}` });
              emit('item', { item: { id, type: 'api_tool', name: 'codex_tool_review', label: 'Codex 操作審核', args: agent.brief(call.name, call.args), status: started ? 'in_progress' : ['deny','cancelled'].includes(event.state) ? 'failed' : 'completed', output: event.reason || '使用一般 Codex 額度，逐次審核本次操作。' } });
            },
          });
        });
        const saved = !agentCtx && chat.antigravityCli && chat.antigravityCli.conversationId && chat.antigravityCli.workspace === workspace && normDir(chat.antigravityCli.cwd) === normDir(cwd) ? chat.antigravityCli : null;
        const where = cwd
          ? `使用者目前選的專案資料夾是「${cwd}」。沒有特別指定時，檔案操作與指令都在這個資料夾進行（run_command 的 Cwd 設成它）。`
          : '使用者沒有選專案資料夾；需要時用使用者指定的絕對路徑。';
        const browserNote = hostTools.length ? `本回合工作台已提供 codex_multi_browser MCP 瀏覽器工具：${hostTools.map(t => t.function.name).join(', ')}。${browsing.active.brave ? '使用者要求在 Brave 開網址／分頁時，用 brave_open_visible 在使用者可見的正常 Brave 視窗操作；不要以 run_command／Start-Process 或 Antigravity 自己的瀏覽器代替。' : ''}其他頁面操作依工作台 browser_*／brave_* 工具執行。必須有成功工具結果才可說已執行；若只得到啟動確認，不可說已確認頁面載入。` : '工作台瀏覽器已關閉，不要聲稱已操作瀏覽器。';
        const note = `（工作台說明：${where}你的啟動資料夾「${workspace}」只是工作台的中繼資料夾，不要在裡面建立或修改檔案。工具被擋下時不要改用其他方式繞過。${browserNote}）`;
        const imageNote = imageTransport.instruction(images);
        const fresh = () => `${[runSettings.systemPrompt, identity, note].filter(Boolean).join('\n')}\n\n${history.length ? contextBlock(history, archive) : ''}${text}${imageNote}`;
        const resumed = (s) => {
          const unseen = history.slice(Math.min(history.length, Number(s.synced) || 0));
          return `${identity}\n${note}\n${unseen.length ? `（這段期間使用者在其他模型的往來：）\n${contextBlock(unseen, archive)}\n\n` : ''}${text}${imageNote}`;
        };
        const runId = newId('agy');
        const toolLog = new Map();
        const toolItem = (t) => {
          const status = t.state === 'DONE' ? 'completed' : t.state === 'ERROR' ? 'failed' : 'in_progress';
          toolLog.set(t.index, { name: `${agent.label(t.name)}${status === 'failed' ? '（未執行）' : ''}`, args: agent.brief(t.name, t.args), status });
          const output = status === 'failed' ? (t.error || '') : typeof t.output === 'string' ? t.output : t.output ? JSON.stringify(t.output) : '';
          if (status !== 'in_progress') {
            toolLog.set(t.index, { ...toolLog.get(t.index), status, output:String(output).slice(0,2400) });
            rememberReviewContext({ role:'tool', text: JSON.stringify({ name:t.name, args:agent.brief(t.name,t.args), status, output:String(output).slice(0,2400) }) });
          }
          emit('item', { item: { id: `${runId}_${t.index}`, type: 'api_tool', name: t.name, label: agent.label(t.name), args: agent.brief(t.name, t.args), status, output: String(output).slice(0, 4000) } });
        };
        const attempt = (s) => agent.run({ cli, model: picked.variant.id, prompt: s ? resumed(s) : fresh(), workspace, project: cwd, conversationId: s ? s.conversationId : '', mode: permission === 'plan' ? 'plan' : '',
          env: hookServer.env, signal: controller.signal, onDelta: (t) => emit('delta', { text: t }), onTool: toolItem,
          onProgress: event => emit('progress',event) });
        emit('status', { message: `${useModel} 正在透過 Antigravity CLI 處理…` });
        try {
          let result;
          try { result = await attempt(saved); } catch (e) {
            // 接續的 CLI 對話不見了（被刪或換電腦）：開一段新的、把歷史帶進去
            if (!saved || controller.signal.aborted || e.name === 'AbortError' || e.streamed) throw e;
            result = await attempt(null);
          }
          if (!agentCtx) chat.antigravityCli = { conversationId: result.conversationId, workspace, cwd: cwd || '', synced: history.length + (result.text ? 2 : 1) };
          const used = [...reviewLog.values(), ...toolLog.values()];
          if (result.text || used.length) chat.messages.push({ id: newId('m'), role: 'assistant', text: result.text, tools: used.length ? used : undefined, ts: new Date().toISOString(), provider, model: useModel, via: 'antigravity-cli' });
          await writeChat(chat);
          if (result.denied.length) emit('notice', { message: `Antigravity 有 ${result.denied.length} 個操作沒有被允許：${result.denied.map((d) => d.display_name || d.action).join('、')}` });
          emit('done', { cancelled: false });
        } catch (e) {
          const partialText = e.streamed || '';
          const used = [...reviewLog.values(), ...toolLog.values()];
          if (partialText || used.length) {
            chat.messages.push({ id: newId('m'), role: 'assistant', text: partialText, tools: used, ts: new Date().toISOString(), provider, model: useModel, via: 'antigravity-cli', partial: true, partialReason: controller.signal.aborted ? (task.paused ? '已暫停' : '已停止') : String(e.message).slice(0,500) });
            if (!agentCtx && e.conversationId) chat.antigravityCli = { conversationId: e.conversationId, workspace, cwd: cwd || '', synced: history.length + (partialText ? 2 : 1) };
            await writeChat(chat);
          }
          if (controller.signal.aborted || e.name === 'AbortError') emit('done', { cancelled: true });
          else emit('error', { message: e.message });
        } finally {
          hookServer.close();
        }
        return;
      }
      const toolCtx = { mode: runLevel, cwd, signal: controller.signal, approval: 'on-request', browser: browsing.browser, braveBrowser: browsing.braveBrowser, noDelete };
      toolCtx.approveDelete = async ({ reason, detail }) => (await askApproval(emit, { kind: 'delete', detail: `${reason}\n\n${detail}`, cwd, signal: controller.signal })).ok;
      toolCtx.approve = async ({ kind, detail }) => (await askApproval(emit, { kind, detail, cwd, signal: controller.signal })).ok;
      const tools = apiTools.definitions(runLevel, { browser: browsing.browser, braveBrowser: !!browsing.braveBrowser, approval: 'on-request' });
      const imageToolLog = new Map();
      const execute = async (name, args) => {
        const id = newId('agytool');
        const base = { id, type: 'api_tool', name, label: apiTools.label(name), args: apiTools.brief(name, args) };
        imageToolLog.set(id, { name: base.label, args: base.args });
        emit('item', { item: { ...base, status: 'in_progress' } });
        try {
          const output = await antigravity.execute(name, args, permission, commandContext(toolCtx, base));
          emit('item', { item: { ...base, status: 'completed', output: String(output).slice(0, 4000) } });
          return output;
        } catch (error) {
          emit('item', { item: { ...base, status: 'failed', output: error.message } });
          throw error;
        }
      };
      const harness = runLevel === 'chat' ? '' : await require('./webCodexHarness').buildContext({ cwd, level: runLevel, approval: 'on-request', tools });
      const prompt = `${[runSettings.systemPrompt, identity, harness].filter(Boolean).join('\n')}\n\n${history.length ? contextBlock(history, archive) : ''}${text}`;
      // Keep CLI away from project instructions/native file access; host tools use the selected cwd.
      const scratch = path.join(userDir(), 'antigravity-cli', 'transport');
      await fsp.mkdir(scratch, { recursive: true });
      const turns = [];
      let partialText = '';
      const ask = async input => {
        turns.push(input);
        let streamed = ''; let shown = '';
        const output = await antigravity.ask({ model: picked.variant.id, prompt: turns.join('\n\n'), images, cwd: scratch, signal: controller.signal,
          onDelta: t => {
            streamed += t;
            const visible = tools.length ? require('./webToolBridge').visibleText(streamed) : streamed;
            if (visible.length > shown.length) { const delta = visible.slice(shown.length); partialText += delta; emit('delta', { text: delta }); shown = visible; }
          }, onStatus: message => emit('status', { message }),
          onTool: tool => {
            const agent = require('./antigravityAgent');
            const id = `${reqId}_${turns.length}_${tool.index}`;
            const status = tool.state === 'DONE' ? 'completed' : tool.state === 'ERROR' ? 'failed' : 'in_progress';
            const name = agent.label(tool.name), args = agent.brief(tool.name, tool.args);
            imageToolLog.set(id, { name, args });
            emit('item', { item: { id, type: 'api_tool', name: tool.name, label: name, args, status, output: tool.error || '' } });
          } });
        turns.push(output);
        return { text: output };
      };
      emit('status', { message: `${useModel} 正在透過 Antigravity CLI 回覆…` });
      try {
        const result = await require('./webToolBridge').run({ text: prompt, tools, signal: controller.signal, ask, execute });
        if (result.cancelled || controller.signal.aborted) {
          if (partialText || imageToolLog.size) {
            chat.messages.push({ id: newId('m'), role: 'assistant', text: partialText, tools: streamedTools().length ? streamedTools() : undefined, ts: new Date().toISOString(), provider, model: useModel, partial: true, partialReason: task.paused ? '已暫停' : '已停止' });
            await writeChat(chat);
          }
          emit('done', { cancelled: true }); return;
        }
        if (!partialText && result.text) emit('delta', { text: result.text });
        if (result.text) {
          chat.messages.push({ id: newId('m'), role: 'assistant', text: result.text, tools: streamedTools().length ? streamedTools() : undefined, ts: new Date().toISOString(), provider, model: useModel, via: 'antigravity-cli' });
          await writeChat(chat);
        }
        emit('done', { cancelled: !!result.cancelled });
      } catch (e) {
        if (partialText || imageToolLog.size) { chat.messages.push({ id: newId('m'), role: 'assistant', text: partialText, tools: streamedTools().length ? streamedTools() : undefined, ts: new Date().toISOString(), provider, model: useModel, partial: true, partialReason: controller.signal.aborted ? (task.paused ? '已暫停' : '已停止') : String(e.message).slice(0, 500) }); await writeChat(chat); }
        if (controller.signal.aborted || e.name === 'AbortError') emit('done', { cancelled: true });
        else emit('error', { message: e.message });
      }
      return;
    }

    // ---- GPT 走 ChatGPT 網頁版（使用者 Brave 裡已登入的 chatgpt.com，不用 API 餘額） ----
    if (provider === 'gpt' && (options.via || runSettings.providers.gpt.via) === 'web') {
      const userMsg = { id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model, via: 'web' };
      chat.messages = chat.messages || [];
      chat.messages.push(userMsg);
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });
      // 一次性呼叫（擴充代理、陪伴角色、子 agent）用臨時對話，不塞進使用者的 ChatGPT 紀錄
      const temporary = !!agentCtx;
      // 模仿 Codex 架構：另開一條 ChatGPT 對話（gptWebAgent），關掉後回到原本的聊天對話，不受工具提示影響
      const webAgent = runSettings.providers.gpt.webAgent === true;
      const webSlot = webAgent ? 'gptWebAgent' : 'gptWeb';
      if (gptLoginAccountId === task.gptWebAccountId) throw new Error('這個 ChatGPT 帳號正在登入，請完成後再送出。');
      const webAccount = await gptAccountStore().active(task.gptWebAccountId);
      if (!webAccount) throw new Error('請先在「連線」選單登入 ChatGPT 帳號。');
      const webMapSlot = `${webSlot}ByAccount`;
      const web = temporary ? {} : (chat[webMapSlot]?.[webAccount.id] || (webAccount.id === 'default' ? chat[webSlot] : null) || {});
      const history = merged.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
      // 接續同一個 ChatGPT 對話時只補上「這段期間在其他模型的往來」，不重送整段歷史
      const unseen = web.url ? history.slice(Math.min(history.length, Number(web.synced) || 0)) : history;
      const sys = !web.url && runSettings.systemPrompt && runSettings.systemPrompt.trim() ? `${runSettings.systemPrompt.trim()}\n\n`
        : web.url && promptSkillContext ? `${promptSkillContext}\n\n` : '';
      let harnessCtx = '';
      const controller = new AbortController();
      task.attach({ cancel: () => controller.abort() });
      const providerCfgRun = runSettings.providers.gpt || {};
      const approval = providerCfgRun.approval || 'on-request';
      const browsing = browsersForChat(chat.id, runSettings.browser || {});
      browsing.browser?.setGuard(()=>!task.cancelled&&!task.finished);
      browsing.braveBrowser?.setGuard(()=>!task.cancelled&&!task.finished);
      const toolCtx = { mode: runLevel, cwd, signal: controller.signal, approval, browser: browsing.browser, braveBrowser: browsing.braveBrowser, noDelete };
      toolCtx.approveDelete = async ({ reason, detail }) => (await askApproval(emit, { kind: 'delete', detail: `${reason}\n\n${detail}`, cwd, signal: controller.signal })).ok;
      let approveAlways = false;
      toolCtx.approve = async ({ kind, detail }) => {
        if (approveAlways) return true;
        const answer = await askApproval(emit, { kind, detail, cwd, signal: controller.signal });
        if (answer.always) approveAlways = true;
        return !!answer.ok;
      };
      const toolDefs = [...apiTools.definitions(runLevel, { browser: browsing.browser, braveBrowser: !!browsing.braveBrowser, approval }), ...(browsing.active.brave ? [require('./braveVisible').tool] : []), ...(canSpawn ? agentKit.TOOLS : []), ...extTools];
      const runWebTool = async (name, args) => {
        if (task.cancelled || task.finished || controller.signal.aborted) throw Error('已停止');
        if (name === 'brave_open_visible' && !browsing.active.brave) throw Error('外部 Brave 工具目前是關閉的。');
        if (agentKit.TOOL_NAMES.has(name)) return agentItem(name, args, controller.signal);
        if (extSession?.has(name)) return runExtTool(name, args, controller.signal);
        const id = newId('webtool');
        const base = { id, type: 'api_tool', name, label: name === 'brave_open_visible' ? '在 Brave 開啟可見分頁' : apiTools.label(name), args: apiTools.brief(name, args) };
        emit('status', { message: `正在執行工具：${base.label || name}；若有同意卡，請先回覆。` });
        emit('item', { item: { ...base, status: 'in_progress' } });
        try {
          const output = name === 'brave_open_visible' ? await openVisibleBrave(args.url, controller.signal) : await observedApiTool(name, args, toolCtx, base);
          emit('item', { item: { ...base, status: 'completed', output: String(output).slice(0, 4000) } });
          emit('status', { message: '工具已完成，準備同步 ChatGPT 的後續回覆…' });
          return output;
        } catch (error) {
          const message = String(error?.message || error);
          emit('item', { item: { ...base, status: 'failed', output: message } });
          throw new Error(message);
        }
      };
      if (webAgent) {
        if (runLevel === 'chat') {
          harnessCtx = '（Codex 架構已開啟；目前是僅聊天，不讀取本機專案內容，也沒有檔案或指令工具。）\n\n';
          emit('notice', { message: '模仿 Codex 架構已開啟，但權限是「僅聊天」，不會讀取本機專案或使用檔案、指令工具；要讓它動手請把權限改成唯讀以上。' });
        } else if (!web.url) harnessCtx = `${await require('./webCodexHarness').buildContext({ cwd, level: runLevel, approval, tools: toolDefs })}\n\n`;
        else harnessCtx = `（Codex 模式：專案 ${cwd || '未選擇'}，權限 ${runLevel}；請沿用前面的工作方式。）\n\n`;
      }
      const prompt = `${sys}${harnessCtx}${unseen.length ? contextBlock(unseen, archive) : ''}${text}`;
      const save = async (out, extra = {}) => {
        if (out) chat.messages.push({ id: newId('m'), role: 'assistant', text: out, ts: new Date().toISOString(), provider, model: extra.model || model || '', via: 'web', ...(webAgent ? { webAgent: true } : {}), ...extra.flags });
        if (!temporary && extra.url && /\/c\/(?!WEB[:_-])/i.test(extra.url)) {
          const value = { url: extra.url, synced: history.length + (out ? 2 : 1) };
          chat[webMapSlot] = { ...chat[webMapSlot], [webAccount.id]: value };
          if (webAccount.id === 'default') chat[webSlot] = value;
        }
        await writeChat(chat);
      };
      const chatgptWeb = require('./chatgptWeb');
      const webChatKey = temporary ? `${chat.id}:${reqId}` : webAgent ? `${chat.id}:agent` : chat.id;
      let turnUrl = web.url || '';
      let servedModel = '';
      let firstWebTurn = true;
      let streamedVisible = '';
      const askTurn = async (turnText) => {
        const images = firstWebTurn ? attachments.imagePaths(files, path.join(userDir(), 'attachments')) : [];
        firstWebTurn = false;
        let turnStream = '';
        const turnBase = streamedVisible;
        const publish = (body) => {
          const visible = toolDefs.length ? require('./webToolBridge').visibleText(body) : body;
          const full = turnBase + visible;
          if (full.startsWith(streamedVisible)) {
            const delta = full.slice(streamedVisible.length);
            if (delta) emit('delta', { text: delta });
          } else emit('replace', { text: full });
          streamedVisible = full;
        };
        const result = await chatgptWeb.ask({
          chatKey: webChatKey, url: turnUrl, model: webSiteModelLabel(typeof options.webSourceModel==='string' ? options.webSourceModel : model || runSettings.providers.gpt.webModel || ''), effort: options.webEffort || runSettings.providers.gpt.webEffort || 'default', temporary,
          profileDir: webAccount.profileDir, importExistingLogin: false, bravePath: runSettings.browser?.path || '', hideWindow: runSettings.webHideWindow !== false, showWindow: runSettings.webHideWindow === false,
          keepTab: toolDefs.length > 0, closeTab: true,
          text: turnText || (images.length ? '請分析附上的圖片。' : ''), images, signal: controller.signal,
          onDelta: (t) => {
            turnStream += t;
            publish(turnStream);
          },
          onReplace: (body) => { turnStream = body; publish(body); },
          onStatus: (message) => emit('status', { message }),
        });
        if (toolDefs.length && result.cancelled) result.text = require('./webToolBridge').visibleText(result.text);
        if (result.url) turnUrl = result.url;
        if (result.model) servedModel = result.model;
        return result;
      };
      try {
        const r = toolDefs.length
          ? await require('./webToolBridge').run({ text: prompt, tools: toolDefs, signal: controller.signal, ask: askTurn, execute: runWebTool, maxTurns: webAgent ? 40 : undefined })
          : await askTurn(prompt);
        if (toolDefs.length && r.cancelled) r.text = require('./webToolBridge').visibleText(r.text);
        if (String(r.text || '') !== streamedVisible) emit('replace', { text: String(r.text || '') });
        await save(r.text, { url: r.url || turnUrl, model: r.model || servedModel, flags: r.cancelled ? { partial: true, partialReason: task.paused ? '已暫停' : '已停止' } : {} });
        emit('done', { cancelled: !!r.cancelled });
      } catch (e) {
        if (e.partial) {
          const partial = toolDefs.length ? require('./webToolBridge').visibleText(e.partial) : e.partial;
          emit('replace', { text: partial });
          await save(partial, { url: e.url || turnUrl, flags: { partial: true, partialReason: String(e.message).slice(0, 500) } });
        }
        if (task.cancelled) emit('done', { cancelled: true }); else emit('error', { message: e.message });
      } finally {
        if (toolDefs.length) {
          try { await chatgptWeb.closeSession(webChatKey, { profileDir: webAccount.profileDir, bravePath: runSettings.browser?.path || '' }); } catch { /* already closed */ }
        }
      }
      return;
    }

    // ---- GPT 走 Codex 帳號（ChatGPT 訂閱，不用 API 餘額） ----
    if (provider === 'gpt' && (options.via || runSettings.providers.gpt.via) === 'codex') {
      const userMsg = { id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model };
      chat.messages = chat.messages || [];
      chat.messages.push(userMsg);
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });

      const history = merged.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
      const sys = runSettings.systemPrompt && runSettings.systemPrompt.trim() ? `${runSettings.systemPrompt.trim()}\n` : '';
      const idLine = model ? `（系統資訊：你這次使用的模型 ID 是「${model}」，被問到模型或版本時以此為準。）\n` : '';
      const prompt = `${sys}${idLine}${(options.permission || runSettings.providers.gpt.permission || 'chat') === 'chat' ? '這次僅聊天，不要執行指令或讀寫檔案。' : '請在指定專案內完成任務，可使用 CLI 工具。'}\n${extHint ? extHint + '\n' : ''}\n${history.length ? contextBlock(history, archive) : ''}${text}`;
      const chatDir = path.join(app.getPath('temp'), 'codex-multi-chat');
      try { fs.mkdirSync(path.join(chatDir, chat.id), { recursive: true }); } catch { /* */ }

      const parts = new Map();
      let finished = false;
      const handle = await codexRunner.runCodex({
        customPath: runSettings.providers.codex.path,
        codexHome: runSettings.codexHome,
        signal: runAbort.signal,
        prompt,
        images: attachments.imagePaths([...merged.flatMap(m => m.attachments || []), ...files], path.join(userDir(), 'attachments')),
        cwd: cwd || path.join(chatDir, chat.id),
        threadId: null,
        sandbox: (options.permission || runSettings.providers.gpt.permission) === 'chat' ? 'read-only' : (options.permission || runSettings.providers.gpt.permission || 'read-only'),
        ephemeral: true,
        model: model || '',
        extraArgs: [...effortArgs(options.reasoningEffort === 'none' ? 'default' : options.reasoningEffort), ...(nativeBridge?.codexArgs || []), ...(deleteGuard ? deleteGuardKit.codexArgs(process.execPath) : [])],
        extraEnv: guardEnv,
      }, guardNative({
        onThread: () => {},
        onItem: (item, phase) => {
          if (item.type === 'agent_message') parts.set(item.id, require('./codexPartial').retainText(parts.get(item.id), item.text));
          emit('item', { item, phase });
        },
        onNotice: (message) => emit('status', { message }),
        onDone: async (info) => {
          if (finished) return; finished = true;
          const {text:out,reasoning,tools} = streamedItems.snapshot();
          if (out || reasoning || tools.length) {
            chat.messages.push({ id: newId('m'), role: 'assistant', text: out, reasoning:reasoning || undefined, tools:tools.length ? tools : undefined, ts: new Date().toISOString(), provider, model: model || '', via: 'codex', partial: info.cancelled || undefined, partialReason: info.cancelled ? (task.paused ? '已暫停' : '已停止') : undefined });
            await writeChat(chat);
          }
          emit('done', { cancelled: !!info.cancelled });
        },
        onError: async (message, info) => {
          if (finished) return; finished = true;
          const {text:out,reasoning,tools} = streamedItems.snapshot();
          if (out || reasoning || tools.length) { chat.messages.push({ id: newId('m'), role: 'assistant', text: out, reasoning:reasoning || undefined, tools:tools.length ? tools : undefined, ts: new Date().toISOString(), provider, model: model || '', via: 'codex', partial: true, partialReason: String(message || '').slice(0, 500) }); await writeChat(chat); }
          emit('error', { message, authRequired: !!info?.authRequired });
        },
      }));
      task.attach(handle);
      return;
    }

    // ---- Claude 走 Claude Code（Claude 訂閱，不用 API 餘額） ----
    if (provider === 'claude' && (options.via || runSettings.providers.claude.via) === 'claudecode') {
      const userMsg = { id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model };
      chat.messages = chat.messages || [];
      chat.messages.push(userMsg);
      chat.lastProvider = provider;
      await writeChat(chat);
      emit('started', { key: chat.origin === 'codex' ? `codex:${chat.codexThreadId}` : `app:${chat.id}` });

      const history = merged.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
      const prompt = `${history.length ? contextBlock(history, archive) : ''}${text}`;
      const useModel = model || runSettings.providers.claude.cliModel || '';
      const identity = useModel ? `（系統資訊：這次透過 Claude Code 呼叫，指定的模型是「${useModel}」。）` : '';
      let out = '';
      let reasoning = '';
      let servedModel = null;
      const claudeRunConfig = await ensureClaudeConfig(runSettings.providers.claude);
      task.claudeConfigDir = claudeRunConfig;
      const handle = claudeCode.runChat({
        customPath: runSettings.providers.claude.claudePath,
        configDir: claudeRunConfig,
        mcpConfig: nativeBridge?.claude,
        disallowTools: extSession?.nativeDisallow || [],
        settingsFile: deleteGuard ? deleteGuardKit.claudeSettings(path.join(userDir(), 'delete-guard'), process.execPath) : '',
        extraEnv: guardEnv,
        chrome: browserPolicy.availability(runSettings.browser || {}).conversation || browserPolicy.prefersBraveExtension(runSettings.browser || {}, 'claude-cli'),
        pureText: planNoTools,
        model: useModel,
        cwd,
        permission: claudePermission,
        onPermission: async (tool, input) => {
          const r = await dialog.showMessageBox(win, { type: 'question', title: 'Claude 工具使用權限', message: `Claude 要使用 ${tool}`, detail: JSON.stringify(input, null, 2).slice(0, 6000), buttons: ['拒絕', '允許這一次'], defaultId: 0, cancelId: 0 });
          return r.response === 1;
        },
        effort: options.effort || runSettings.providers.claude.effort,
        system: [runSettings.systemPrompt, identity, extHint, browserPolicy.claudeGuidance(runSettings.browser || {})].filter((x) => x && x.trim()).join(' '),
        prompt: attachments.content(prompt, [...merged.flatMap(m => m.attachments || []), ...files], 'claude'),
      }, guardNative({
        onDelta: (d) => { out += d; emit('delta', { text: d }); },
        onReasoning: (d) => { reasoning += d; emit('reasoning', { text: d }); },
        onModel: (m) => { if (m && !/^<synthetic>$/.test(m)) servedModel = m; },
        onRateLimit: (info) => {
          if (normDir(claudeRunConfig) === normDir(settings.providers.claude.configDir || require('./claudeAccounts').defaultProfile(userDir()))) lastClaudeRateLimit = { info, at: Date.now() };
          emit('usageChanged', {});
        },
        onDone: async (info) => {
          const tools = streamedTools();
          if (out || reasoning || tools.length) {
            chat.messages.push({ id: newId('m'), role: 'assistant', text: out, reasoning: reasoning || undefined, tools:tools.length ? tools : undefined, ts: new Date().toISOString(), provider, model: useModel, servedModel: servedModel || undefined, via: 'claudecode', partial: info.cancelled || undefined, partialReason: info.cancelled ? (task.paused ? '已暫停' : '已停止') : undefined });
            await writeChat(chat);
          }
          emit('done', { cancelled: !!info.cancelled });
        },
        onError: async (message) => {
          const tools = streamedTools();
          if (out || reasoning || tools.length) { chat.messages.push({ id: newId('m'), role: 'assistant', text: out, reasoning: reasoning || undefined, tools:tools.length ? tools : undefined, ts: new Date().toISOString(), provider, model: useModel, servedModel: servedModel || undefined, via: 'claudecode', partial: true, partialReason: String(message || '').slice(0, 500) }); await writeChat(chat); }
          emit('error', { message });
        },
      }));
      task.attach(handle);
      return;
    }

    // ---- API 模型 ----
    const cfg = apiConfig;
    const userMsg = { id: newId('m'), role: 'user', text, attachments: files, ts: new Date().toISOString(), provider, model };
    chat.messages = chat.messages || [];
    chat.messages.push(userMsg);
    chat.lastProvider = provider;
    await writeChat(chat);
    emit('started', { key: chat.origin === 'codex' ? `codex:${threadId}` : `app:${chat.id}` });

    const { history, truncated } = providers.buildHistory([...merged, userMsg], Number(runSettings.maxContextChars) || 120000, provider);
    if (truncated) emit('notice', { message: '長對話已改用歷史摘錄送給模型（正常處理）；完整聊天紀錄仍保留，可查閱原文。' });

    const controller = new AbortController();
    task.attach({ cancel: () => controller.abort() });
    // 權限與同意政策：每個供應商各自設定（Codex 的沙盒／approval 講法）
    const providerCfgRun = runSettings.providers[provider] || {};
    const permission = options.permission || (provider === 'claude' ? providerCfgRun.apiPermission : providerCfgRun.permission) || 'chat';
    const approval = providerCfgRun.approval || 'on-request';
    const browsing = browsersForChat(chat.id, runSettings.browser || {});
    const useBrowser = !!browsing.browser;
    const toolCtx = { mode: permission, cwd, signal: controller.signal, approval, browser: browsing.browser, braveBrowser: browsing.braveBrowser, noDelete };
    toolCtx.approveDelete = async ({ reason, detail }) => (await askApproval(emit, { kind: 'delete', detail: `${reason}\n\n${detail}`, cwd, signal: controller.signal })).ok;
    toolCtx.browser?.setGuard(()=>!task.cancelled&&!task.finished);
    toolCtx.braveBrowser?.setGuard(()=>!task.cancelled&&!task.finished);
    let approveAlways = false;
    toolCtx.approve = async ({ kind, detail }) => {
      if (approveAlways) return true;
      const answer = await askApproval(emit, { kind, detail, cwd, signal: controller.signal });
      if (answer.always) approveAlways = true;
      return !!answer.ok;
    };
    const toolDefs = planNoTools ? [] : [...apiTools.definitions(permission, { browser: toolCtx.browser, braveBrowser: !!toolCtx.braveBrowser, approval }), ...(truncated ? [contextManager.historyTool] : []), ...(canSpawn ? agentKit.TOOLS : []), ...extTools];
    const runTool = async (name, args) => {
      if (name === 'read_conversation') return contextManager.readHistory(merged,args);
      if (agentKit.TOOL_NAMES.has(name)) return agentItem(name, args, controller.signal);
      if (extSession?.has(name)) return runExtTool(name, args, controller.signal);
      const id = newId('t');
      const argsText = apiTools.brief(name, args);
      const base = { id, type: 'api_tool', name, label: apiTools.label(name), args: argsText };
      emit('item', { item: { ...base, status: 'in_progress' } });
      try {
        const output = await observedApiTool(name, args, toolCtx, base);
        emit('item', { item: { ...base, status: 'completed', output: String(output).slice(0, 4000) } });
        return output;
      } catch (err) {
        const message = String((err && err.message) || err);
        emit('item', { item: { ...base, status: 'failed', output: message } });
        throw new Error(message);
      }
    };
    let out = '';
    let reasoning = '';
    let usage = null;
    let servedModel = null;
    let errorMsg = null;
    const useModel = model || cfg.model || providers.PROVIDERS[provider].defaultModel;
    // 模型常常搞錯自己的版本（訓練資料比較舊），直接告訴它這次實際呼叫的模型 ID
    const identity = `（系統資訊：這次是透過 ${providers.PROVIDERS[provider].label} API 呼叫，使用的模型 ID 是「${useModel}」。如果使用者問你是什麼模型或哪個版本，請以這個模型 ID 回答，不要依照訓練資料猜測。）`;
    const agentHint = canSpawn ? '你可以用 spawn_agent 建立平行的子 agent（可以指定 codex / gpt / claude / deepseek / gemini / grok / meta / ablit / lmstudio 任一模型），再用 wait_agents 取得結果並彙整。只在任務能拆成獨立部分、或使用者要求多 agent 時使用。' : '';
    const capability = browserPolicy.toolGuidance(runSettings.browser || {});
    try {
      const r = await providers.streamChat({
        provider,
        cfg,
        model: useModel,
        system: [runSettings.systemPrompt, `目前對話 ${key}；工作專案：${cwd || '未指定'}。只處理這段對話的任務，不要套用其他專案的進度。`, capability, agentHint, extHint, identity].filter((x) => x && x.trim()).join('\n\n'),
        history,
        options: {
          reasoningEffort: options.reasoningEffort || cfg.reasoningEffort,
          deepseekThinking: options.thinking || cfg.thinking,
          maxTokens: cfg.maxTokens,
          tools: toolDefs,
          executeTool: planNoTools ? async()=>{throw Error('Plan 階段不允許使用本機工具');} : runTool,
        },
        signal: controller.signal,
        onDelta: (d) => { out += d; emit('delta', { text: d }); },
        onReasoning: (d) => { reasoning += d; emit('reasoning', { text: d }); },
        onStatus: (message) => emit('status', { message }),
      });
      if (r.incomplete) errorMsg = '已自動接續多次仍達到輸出長度上限；內容已保留，請按「繼續」。';
      usage = r.usage;
      servedModel = r.servedModel || null;
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) errorMsg = null;
      else errorMsg = String((err && err.message) || err);
    }
    const tools = streamedTools();
    if (out || reasoning || tools.length) {
      chat.messages.push({
        id: newId('m'), role: 'assistant', text: out, reasoning: reasoning || undefined, ts: new Date().toISOString(),
        provider, model: useModel, servedModel: servedModel || undefined, tools:tools.length ? tools : undefined, partial: controller.signal.aborted || !!errorMsg || undefined,
        partialReason: errorMsg ? errorMsg.slice(0, 500) : (controller.signal.aborted ? (task.paused ? '已暫停' : '已停止') : undefined),
      });
      await writeChat(chat);
    }
    if (errorMsg) emit('error', { message: errorMsg });
    else emit('done', { usage, cancelled: controller.signal.aborted });
  } catch (err) {
    emit('error', { message: String((err && err.message) || err) });
  }
}

// ---------------- 監看 Codex 資料夾 ----------------
let watchers = [];
let watchTimer = null;
function startWatching() {
  for (const w of watchers) { try { w.close(); } catch { /* */ } }
  watchers = [];
  const home = codexStore.codexHome(settings.codexHome);
  const notify = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { try { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('sidebar:changed'); } catch {} }, 1500);
  };
  for (const target of [path.join(home, 'sessions'), home]) {
    try {
      const recursive = target.endsWith('sessions') && (process.platform === 'win32' || process.platform === 'darwin');
      const watcher = fs.watch(target, { recursive }, (_ev, file) => {
        if (!file || /rollout-|session_index|state_\d+\.sqlite/.test(String(file))) notify();
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} });
      watchers.push(watcher);
    } catch { /* 資料夾不存在 */ }
  }
}

// ---------------- 桌面捷徑 ----------------
function createDesktopShortcut(force) {
  if (process.platform !== 'win32') return { ok: false, message: '桌面捷徑目前只支援 Windows' };
  const lnk = path.join(app.getPath('desktop'), `${SHORTCUT_NAME}.lnk`);
  if (!force && fs.existsSync(lnk)) return { ok: true, path: lnk, existed: true };
  const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: APP_TITLE,
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: 'tw.wangpin.workbench.opensource',
  });
  return { ok, path: lnk };
}

// ---------------- 視窗 ----------------
function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    show: !smokeData,
    width: b.width || 1320,
    height: b.height || 860,
    // 自動測試（隔離資料夾）開的視窗放到螢幕外、不進工作列：模型跑介面測試時不會突然蓋住使用者的畫面
    ...(smokeData ? { x: -32000, y: -32000, skipTaskbar: true } : { x: b.x, y: b.y }),
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#1b202b',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  require('./windowState').bindWindowMode(win);
  const recoveryWindow = win;
  require('./rendererRecovery').bind(recoveryWindow, path.join(__dirname, 'renderer', 'index.html'), {
    onCrash: details => failureDiagnostics.record('renderer',details),
    onRecovered: () => { if (!recoveryWindow.isDestroyed() && (!smokeData || recoveryWindow.isVisible())) { recoveryWindow.show(); if (recoveryWindow.isMinimized()) recoveryWindow.restore(); } },
    onFailure: error => {
      failureDiagnostics.record('renderer-recovery-failed',{code:error.code});
      dialog.showErrorBox('畫面無法恢復', '對話資料仍保存在電腦。請重新開啟工作台，並提供 crash-events.jsonl 協助調查。');
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('page-title-updated', (ev) => { ev.preventDefault(); win.setTitle(`${APP_TITLE} ${APP_VERSION}`); });
  win.setTitle(`${APP_TITLE} ${APP_VERSION}`);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('context-menu', (_event, params) => {
    const template = require('./editMenu').template(params);
    if (params.linkURL && /^https?:/i.test(params.linkURL)) template.push(
      { type: 'separator' },
      { label: '複製連結網址', click: () => clipboard.writeText(params.linkURL) },
      { label: '在瀏覽器開啟', click: () => shell.openExternal(params.linkURL) },
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  win.webContents.on('will-navigate', (ev, url) => { ev.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); });
  win.webContents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  const createdWindow = win;
  require('./windowState').bindBounds(createdWindow, bounds => { settings.bounds = bounds; saveSettings(); }, error => {
    failureDiagnostics.record('bounds-save-failed',{code:error.code});
  });
  createdWindow.on('focus', () => { if (!createdWindow.isDestroyed() && !createdWindow.webContents.isDestroyed()) createdWindow.webContents.send('sidebar:changed'); });
  createdWindow.on('closed', () => { if (win === createdWindow) win = null; });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  loadSettings();
  // A requested destructive cleanup must finish before any tasks can start.
  if (fs.existsSync(path.join(userDir(),'pending-conversation-cleanup.json'))) {
    try{await applyRequestedCleanup();}catch(error){dialog.showErrorBox('對話清理未完成',String(error.message||error));}
  }
  registerIpc();
  createWindow();
  if (!smokeData) startWatching();
  // Pre-read conversation relations off the startup path so the first permanent delete plans from cache.
  if (!smokeData) setTimeout(() => { require('./chatDeletionInventory').inventory(userDir()).catch(() => {}); }, 6000).unref();
  // 啟動後自動同步一次 Brave 登入（測試用的隔離設定檔不碰使用者的 Brave，除非測試明確要求）
  if (useAppBrowser() && (!smokeData || process.env.CM_TEST_LOGIN_SYNC)) setTimeout(() => { syncBraveLogin({ reason: 'startup' }).catch(() => {}); }, smokeData ? 0 : 3000);
  if (!smokeData && !portableMode && app.isPackaged && process.platform === 'win32' && !settings.shortcutCreated) {
    try { createDesktopShortcut(false); } catch { /* */ }
    settings.shortcutCreated = true;
    saveSettings();
  }
});

app.on('window-all-closed', () => {
  gptLoginController?.abort();
  if (appBrowserHost) appBrowserHost.destroyAll();
  claudeCode.cancelLogin();
  try { require('./searxng').stop(); } catch { /* 沒啟動過 */ }
  for (const r of running.values()) { try { r.cancel(); } catch { /* */ } }
  app.quit();
});
// 背景模式的 Brave 沒有視窗，使用者關不掉它：App 結束時一起收掉（最多等 2 秒）。
// 放在 will-quit：從選單、app.quit() 結束時不會觸發 window-all-closed。
let hiddenBraveStopped = false;
// SearXNG 是沒有視窗的背景 Python，App 結束時一定要收掉（stop 重複呼叫無害）
app.on('will-quit', () => { try { require('./searxng').stop(); } catch { /* 沒啟動過 */ } });
app.on('before-quit', () => { grokBotBridgeInst?.close(); });
app.on('will-quit', () => { chatReader.close(); codexStore.closeIo(); });
app.on('will-quit', (e) => {
  const b = browserController && browserController.browser;
  const web = require('./chatgptWeb');
  const webModels = require('./webModelsBrowser');
  if (hiddenBraveStopped || (!(b && b.hidden && b.live) && !web.hiddenRunning() && !webModels.hasRunning() && !browserChoiceManager?.size() && ![...wangpinBrowsers.values()].some(entry=>entry.browser.conn || entry.browser.child || entry.browser.starting))) return;
  hiddenBraveStopped = true;
  e.preventDefault();
  Promise.race([Promise.allSettled([browserChoiceManager?.dispose(), b && b.hidden && b.live ? b.stop() : null, web.shutdown(), webModels.shutdown(), ...[...wangpinBrowsers.values()].map(entry=>entry.browser.stop())]), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.quit());
});

// 隔離的測試設定檔才開放：讓自動測試直接呼叫模型用的瀏覽器工具
if (smokeData) module.exports.__test = {
  stabilityStats: () => ({sidebar:sidebarMetadata.stats()}),
  listSidebarMetadata: () => sidebarMetadata.list(),
  recordDiagnostic: (type,details) => failureDiagnostics.record(type,details),
  tool: (scope, name, args) => apiTools.execute(name, args || {}, { mode: 'workspace-write', cwd: '', browser: browserForChat(scope) }),
  capture: async (file) => {
    fs.writeFileSync(file, (await win.capturePage()).toPNG());
    const views = [];
    for (const t of (appBrowserHost ? appBrowserHost.tabs.values() : [])) {
      if (!t.view.getVisible()) continue;
      const out = file.replace(/\.png$/, `-view-${t.id}.png`);
      fs.writeFileSync(out, (await t.wc.capturePage(undefined, { stayHidden: true })).toPNG());
      views.push({ file: out, bounds: t.view.getBounds(), url: t.wc.getURL() });
    }
    return { file, views, contentSize: win.getContentSize(), host: appBrowserHost && { open: appBrowserHost.open, scope: appBrowserHost.visibleScope, tabs: [...appBrowserHost.tabs.values()].map(t => [t.id, t.scope, t.view.getVisible(), t.wc.getURL()]) } };
  },
};
