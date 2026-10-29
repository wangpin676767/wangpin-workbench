/* global marked, DOMPurify */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const api = window.api;
  const inputComposition = window.WangpinInputComposition.createCompositionGuard(document);
  let viewEpoch = 0;
  let chatSelectionReady = Promise.resolve({});
  let starting = false;
  let sendGeneration = 0;
  const drafts = new Map();
  function saveDraft() { drafts.set(state.current?.key || '__new', { text:$('#input').value, attachments:[...pendingAttachments] }); }
  function restoreDraft(key) { const draft = drafts.get(key) || {text:'',attachments:[]}; $('#input').value=draft.text; pendingAttachments=[...draft.attachments]; renderAttachments(); autosize(); }

  const LABELS = { codex: 'Codex', gpt: 'GPT', deepseek: 'DeepSeek', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', meta: 'Meta', ablit: 'Abliteration', lmstudio: 'LM Studio', antigravity: 'Antigravity', grokbot: 'Grok Bot', grokbuild: 'Grok Build' };
  // Ctrl+1～9 照這個順序；Antigravity、Grok Bot 放最後，不改動原本的快捷鍵
  const ORDER = ['codex', 'gpt', 'claude', 'deepseek', 'meta', 'ablit', 'lmstudio', 'antigravity', 'grokbuild'];
  const API_ORDER = ['gpt', 'claude', 'deepseek', 'meta', 'ablit', 'lmstudio'];
  const REMOVED_PROVIDERS = new Set(['gemini', 'grok']);
  const KEY_PAGES = { gpt: 'https://platform.openai.com/api-keys', claude: 'https://console.anthropic.com/settings/keys', deepseek: 'https://platform.deepseek.com/api_keys', gemini: 'https://aistudio.google.com/app/apikey', grok: 'https://console.x.ai', meta: 'https://ai.developer.meta.com/', ablit: 'https://abliteration.ai/' };
  const SUBTITLE = { gpt: 'OpenAI', claude: 'Anthropic', deepseek: 'DeepSeek', gemini: 'Google AI Studio', grok: 'xAI', meta: 'Meta Model API（Muse Spark）', ablit: 'Abliteration.ai（OpenAI 相容）', lmstudio: 'LM Studio 本機伺服器（免金鑰，預設 http://localhost:1234/v1）' };
  const PAGE = 8;

  const state = {
    settings: null,
    sidebar: { items: [], projects: [] },
    current: null, // { key, chatId, threadId, title, cwd, messages }
    provider: 'codex',
    busy: null, // { reqId, el, text, reasoning, tools: Map, agentBlocks: Map }
    search: '',
    expanded: new Set(),
    codexInfo: null,
    codexModels: null,
    pendingCwd: null,
    pendingExtensions: [],  // 還沒送出第一則訊息的新對話所勾的擴充（只屬於這段新對話）
    pendingHarness: '',     // 新對話選的 Harness 腳本（送出第一則時一起存進去）
    pendingSystemPrompt: '', // 新對話設定的 System Prompt（送出第一則時一起存進去）
    renaming: null,
    runs: new Map(),     // reqId -> 進行中的回覆（可以同時在不同對話跑）
    unread: new Set(),   // 在背景完成、還沒看過的對話
    usage: null,
    extensions: null,  // { packs, enabled }：能力擴充清單與全域預設
  };

  // GPT 可以走 Codex 帳號、Claude 可以走 Claude Code 帳號（都是訂閱，不用 API 餘额）
  const SUBS = {
    gpt: [
      { id: '__web__', via: 'web', name: 'ChatGPT 網頁版', desc: '使用工作台專用 Brave 保存的登入；回覆同步至 App，可在連線選單登入、切換與管理帳號' },
    ],
    claude: [{ id: '__claudecode__', via: 'claudecode', name: 'Claude Code 帳號', desc: '用你 Claude Code 登入的 Claude 訂閱，不需要 API 餘額' }],
  };
  const subsOf = (p) => SUBS[p] || [];
  const activeSub = (p, settings = state.settings) => { const via = settings && settings.providers[p] && settings.providers[p].via; return subsOf(p).find((x) => x.via === via) || null; };
  const gptWeb = (settings = state.settings) => !!(settings && settings.providers.gpt && settings.providers.gpt.via === 'web');
  const catalogOf = (p) => (state.settings && state.settings.catalog && state.settings.catalog[p]) || { models: [], defaultBase: '' };
  const viaSub = (p, settings = state.settings) => !!activeSub(p, settings);
  const runForKey = (key) => { for (const r of state.runs.values()) if (r.key === key) return r; return null; };
  const currentRun = () => (state.current ? runForKey(state.current.key) : null);

  // ---------------- 工具函式 ----------------
  marked.setOptions({ gfm: true, breaks: true });
  DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const raw = node.getAttribute('href');
      if (raw && /^(?:https?:\/\/|file:|sandbox:|\/?[a-z]:(?:[\\/]|%(?:5c|2f))|\/mnt\/)/i.test(raw)) node.setAttribute('data-chat-link', raw);
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      if (node.hasAttribute('data-chat-link')) { node.setAttribute('href', '#'); node.removeAttribute('target'); node.setAttribute('title', '開啟連結'); }
      else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener'); }
    }
  });

  function renderMarkdown(el, text) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    el.querySelectorAll('pre').forEach((pre) => {
      const b = document.createElement('button');
      b.className = 'copy'; b.type = 'button'; b.textContent = '複製';
      b.onclick = () => { navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText); b.textContent = '已複製'; setTimeout(() => { b.textContent = '複製'; }, 1200); };
      pre.appendChild(b);
    });
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  function relTime(ms) {
    if (!ms) return '';
    const d = (Date.now() - ms) / 1000;
    if (d < 60) return '剛剛';
    if (d < 3600) return `${Math.floor(d / 60)} 分`;
    if (d < 86400) return `${Math.floor(d / 3600)} 小時`;
    if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天`;
    if (d < 86400 * 35) return `${Math.floor(d / 86400 / 7)} 週`;
    const dt = new Date(ms);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  }

  function baseName(p) {
    if (!p) return '';
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // 錯誤訊息裡的網址可以直接點開
  function errEl(message) {
    const el = h('div', { class: 'err' });
    const parts = String(message || '').split(/(https?:\/\/[^\s，。）)]+)/g);
    for (const part of parts) {
      if (/^https?:\/\//.test(part)) {
        const url = part.replace(/[.,]+$/, '');
        el.append(h('a', { href: '#', text: url, onclick: (e) => { e.preventDefault(); api.openExternal(url); } }), part.slice(url.length));
      } else if (part) el.append(part);
    }
    return el;
  }

  function toast(msg, ms = 2600) {
    // 主程序丟回來的錯誤會帶 "Error invoking remote method ..." 前綴，使用者不需要看到
    const text = String(msg ?? '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
    const t = h('div', { class: 'toast', text });
    // 置中在對話區，避免被右側的內建瀏覽器蓋住；多則提示往上疊
    const r = $('#main').getBoundingClientRect();
    t.style.left = `${r.left + r.width / 2}px`;
    t.style.maxWidth = `${Math.max(240, r.width - 40)}px`;
    const stacked = [...document.querySelectorAll('.toast')].reduce((y, el) => y + el.offsetHeight + 8, 0);
    t.style.bottom = `${22 + stacked}px`;
    // 點一下就關掉，不必等它自己消失
    t.onclick = () => t.remove();
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------------- 側欄 ----------------
  let sidebarRefreshActive = null, sidebarRefreshPending = null;
  function refreshSidebar() {
    if (sidebarRefreshActive) {
      // Requests arriving during a read need one fresh follow-up, including
      // settings changes; sharing the older result could hide new choices.
      if (!sidebarRefreshPending) {
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        sidebarRefreshPending = {promise, resolve};
      }
      return sidebarRefreshPending.promise;
    }
    const work = refreshSidebarOnce();
    sidebarRefreshActive = work;
    const settled = () => {
      sidebarRefreshActive = null;
      const pending = sidebarRefreshPending; sidebarRefreshPending = null;
      if (pending) refreshSidebar().then(pending.resolve, pending.resolve);
    };
    work.then(settled, settled);
    return work;
  }
  async function refreshSidebarOnce() {
    try {
      state.sidebar = await api.listSidebar();
    } catch (e) {
      state.sidebar = { items: [], projects: [], dbError: String(e.message || e) };
    }
    renderSidebar();
    renderComposerBar();
  }

  const normDir = (p) => String(p || '').toLowerCase().replace(/[\\/]+$/, '');
  function projectGroup(p) {
    return { key: `p:${p.id}`, name: p.name || baseName(p.root) || '專案', title: p.root || p.name, dir: p.root ? normDir(p.root) : `p:${p.id}` };
  }
  function groupFor(item, projects, roots) {
    if (item.projectId && projects.has(item.projectId)) return projectGroup(projects.get(item.projectId));
    if (item.originalProject != null || item.cwd) {
      const groupPath = item.originalProject ?? item.cwd;
      if (!groupPath) return { key:'none', name:'未指定資料夾', title:'', dir:'' };
      const dir = normDir(groupPath);
      if (roots && roots.has(dir)) return projectGroup(roots.get(dir));
      return { key: `d:${dir}`, name: baseName(groupPath), title: groupPath, dir };
    }
    return { key: 'none', name: '未指定資料夾', title: '', dir: '' };
  }
  function collectionOf(item) {
    const source = item.source || (item.kind === 'codex' ? 'codex' : 'app');
    if (!['codex', 'claude'].includes(source) || !(state.settings?.sidebarSources || []).includes(source)) return '';
    const selected = state.settings?.sidebarSourceProjects;
    const key = item.sourceProjectKey || normDir(item.cwd || '') || 'none';
    if (selected && !(selected[source] || []).includes(key)) return '';
    const conversations = state.settings?.sidebarSourceConversations;
    const conversationKey = item.sourceConversationKey || item.key;
    return !conversations || (conversations[source] || []).includes(conversationKey) ? source : '';
  }
  const unselectedSource = (item) => ['codex', 'claude'].includes(item.source || (item.kind === 'codex' ? 'codex' : 'app')) && !collectionOf(item);
  const sidebarFilterOn = () => Array.isArray(state.settings?.sidebarProjects) && (!state.sidebarSource || state.sidebarSource === 'all') && !searchQuery();
  function sidebarMaps() {
    const projects = new Map((state.sidebar.projects || []).map((p) => [p.id, p]));
    const roots = new Map((state.sidebar.projects || []).filter((p) => p.root).map((p) => [normDir(p.root), p]));
    return { projects, roots };
  }
  async function setSidebarProjects(list) {
    state.settings = await api.saveSettings({ sidebarProjects: list });
    renderSidebar();
  }
  // 專案被「移除」：側欄不再顯示，「載入專案」也不再列出來。對話一則都不會刪。
  async function removeProject(dir) {
    const removed = new Set(state.settings.removedProjects || []);
    removed.add(dir);
    const list = state.settings.sidebarProjects;
    state.settings = await api.saveSettings({
      removedProjects: [...removed],
      sidebarProjects: Array.isArray(list) ? list.filter((d) => d !== dir) : list,
      sidebarOrder: (state.settings.sidebarOrder || []).filter((d) => d !== dir),
    });
    renderSidebar();
  }
  async function restoreProject(dir) {
    const removed = (state.settings.removedProjects || []).filter((d) => d !== dir);
    const list = state.settings.sidebarProjects;
    state.settings = await api.saveSettings({
      removedProjects: removed,
      sidebarProjects: Array.isArray(list) ? [...new Set([...list, dir])] : list,
    });
    await refreshSidebar();
  }
  const isRemovedProject = (dir) => (state.settings.removedProjects || []).includes(dir);
  // 從檔案總管挑一個資料夾載入側欄（挑到之前移除過的，就等於把它加回來）
  async function addProjectFolder() {
    const dir = await api.pickFolder(currentCwd() || '');
    if (!dir) return '';
    const norm = normDir(dir);
    const base = new Set(Array.isArray(state.settings.sidebarProjects) ? state.settings.sidebarProjects : []);
    base.add(norm);
    state.settings = await api.saveSettings({
      sidebarProjects: [...base],
      removedProjects: (state.settings.removedProjects || []).filter((d) => d !== norm),
    });
    await refreshSidebar();
    toast(`已把「${baseName(dir)}」加入側欄`);
    return dir;
  }

  // 依自訂順序排列：排過的照排好的來，沒排過的維持原本次序接在後面。
  const BOTTOM = Number.MAX_SAFE_INTEGER;
  function orderIndex(list) {
    const m = new Map();
    (list || []).forEach((v, i) => m.set(v, i));
    return (v) => (m.has(v) ? m.get(v) : BOTTOM);
  }
  // 把畫面上排好的順序寫回設定，畫面外的舊順序保留在後面，才不會一拖曳就把別的專案洗掉。
  const mergeOrder = (visible, old) => [...visible, ...(old || []).filter((v) => !visible.includes(v))];

  /**
   * 長按後可拖曳排序。
   * 按住約 0.4 秒該列會浮起來，上下滑動換位置，放開即儲存；
   * 還沒長按就先移動（例如想捲動側欄）則取消，不會誤觸。
   */
  function enableDragSort(el, kind, commit, handle = el) {
    el.dataset.sort = kind;
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const parent = el.parentElement;
      if (!parent) return;
      const startY = e.clientY;
      let dragging = false;
      let timer = setTimeout(begin, 400);
      const siblings = () => [...parent.children].filter((c) => c.dataset.sort === kind);

      function begin() {
        timer = null;
        dragging = true;
        el.classList.add('dragging');
        parent.classList.add('dragging-in');
        navigator.vibrate?.(8);
      }
      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) > 8) finish(false);
          return;
        }
        ev.preventDefault();
        const others = siblings().filter((c) => c !== el);
        const before = others.find((c) => {
          const r = c.getBoundingClientRect();
          return ev.clientY < r.top + r.height / 2;
        });
        if (before) { if (before !== el.nextSibling) parent.insertBefore(el, before); }
        else if (others.length && el !== parent.lastElementChild) parent.append(el);
      }
      function finish(apply) {
        if (timer) { clearTimeout(timer); timer = null; }
        // 指標可能早就滑出這一列了，所以事件一律掛在 document 上追蹤
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onCancel, true);
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        parent.classList.remove('dragging-in');
        // 拖完放開的那一下不要順手觸發點擊（不然會開到對話、或把群組收起來）
        const swallow = (c) => { c.stopPropagation(); c.preventDefault(); document.removeEventListener('click', swallow, true); };
        document.addEventListener('click', swallow, true);
        setTimeout(() => document.removeEventListener('click', swallow, true), 300);
        if (apply) commit(siblings().map((c) => c.dataset.sortId ?? ''));
      }
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onCancel, true);
    });
  }
  async function saveProjectOrder(dirs) {
    state.settings = await api.saveSettings({ sidebarOrder: mergeOrder(dirs, state.settings.sidebarOrder) });
  }
  async function saveThreadOrder(keys) {
    state.settings = await api.saveSettings({ threadOrder: mergeOrder(keys, state.settings.threadOrder) });
  }
  async function clearSidebarOrder() {
    state.settings = await api.saveSettings({ sidebarOrder: [], threadOrder: [] });
    renderSidebar();
    toast('已清除側欄的自訂排序');
  }
  // 把對話所在的分組展開，並捲到看得到的位置
  async function revealInSidebar(key) {
    const it = (state.sidebar.items || []).find((x) => x.key === key);
    if (!it) return;
    const { projects, roots } = sidebarMaps();
    const source = collectionOf(it);
    const dir = it.sourceProjectKey || normDir(it.cwd || '') || 'none';
    const g = source ? { key: `source:${source}:${dir || 'none'}` } : groupFor(it, projects, roots);
    const collapsed = new Set(state.settings.collapsedGroups || []);
    const parentWasCollapsed = source && collapsed.delete(`collection:${source}`);
    if (collapsed.has(g.key) || parentWasCollapsed) {
      collapsed.delete(g.key);
      state.settings = await api.saveSettings({ collapsedGroups: [...collapsed] });
    }
    state.expanded.add(g.key);
    renderSidebar();
    const btn = [...document.querySelectorAll('#threadList .thread')].find((b) => b.dataset.key === key);
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      const row = btn.closest('.group')?.querySelector('.group-row');
      if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    }
  }
  function isShownInSidebar(key) {
    const it = (state.sidebar.items || []).find((x) => x.key === key);
    if (!it) return false;
    if (unselectedSource(it)) return false;
    if (collectionOf(it)) return true;
    const list = state.settings.sidebarProjects;
    if (!Array.isArray(list)) return true;
    const { projects, roots } = sidebarMaps();
    return list.includes(groupFor(it, projects, roots).dir);
  }
  function groupMenu(g, anchor) {
    if (g.collection) {
      const items = g.title ? [{ label: '開啟原始專案資料夾', onSelect: () => api.openPath(g.title) }] : [];
      items.push({ label: '從側欄移除這個專案', desc: '只移除側欄顯示，不刪除原始對話或資料夾', danger: true, onSelect: async () => {
        try {
          const result = await api.removeSourceProject(g.collection, g.projectKey);
          state.settings = result.settings; state.sidebar = result.sidebar; renderSidebar();
        } catch (e) { toast(e.message, 6000); }
      } });
      openMenu(anchor, { title: g.name, items });
      return;
    }
    const list = state.settings.sidebarProjects;
    const filtered = Array.isArray(list);
    const items = [];
    if (g.title && g.key !== 'pinned') items.push({ label: '在這個專案開新對話', onSelect: () => newChatIn(g.title) });
    if (g.title && g.key !== 'pinned') items.push({ label: '開啟專案資料夾', onSelect: () => api.openPath(g.title) });
    if (g.key !== 'pinned') {
      if (filtered && list.includes(g.dir)) items.push({ label: '從側欄收起這個專案', desc: '對話不會被刪除；之後按「載入專案」選回同一個資料夾即可', onSelect: () => setSidebarProjects(list.filter((d) => d !== g.dir)) });
      items.push({ label: '從側欄移除這個專案', desc: '從列表整個拿掉（對話不會被刪除），可在「載入專案」加回來', danger: true, onSelect: () => removeProject(g.dir) });
      if ((state.settings.sidebarOrder || []).length) items.push({ label: '清除自訂排序', desc: '回到原本的時間順序', onSelect: () => clearSidebarOrder() });
    }
    items.push({ label: '開啟側欄管理資料夾', desc: '用檔案總管刪除／搬移對話捷徑來整理側欄', onSelect: openSidebarFolder });
    openMenu(anchor, { title: g.name, items });
  }
  function collectionMenu(source, anchor) {
    openMenu(anchor, { title: source === 'codex' ? 'Codex 專案' : 'Claude Code 專案', items: [
      { label: '載入其他本機對話…', onSelect: () => openSourceProjectPicker(source) },
      { label: '從側欄移除全部專案', desc: '原始對話與資料夾仍會保留', danger: true, onSelect: async () => {
        try {
          const result = await api.removeSidebarSource(source);
          state.settings = result.settings; state.sidebar = result.sidebar; renderSidebar();
        } catch (e) { toast(e.message, 6000); }
      } },
    ] });
  }

  function renderSidebar() {
    const list = $('#threadList');
    const scroll = list.scrollTop;
    list.innerHTML = '';
    if (state.contentSearch) { renderContentResults(list); list.scrollTop = scroll; return; }
    const s = state.settings || {};
    const q = searchQuery();
    const { projects, roots } = sidebarMaps();
    const items = (state.sidebar.items || []).filter((it) => {
      const source = it.source || (it.kind === 'codex' ? 'codex' : 'app');
      if (unselectedSource(it)) return false;
      if (state.sidebarSource && state.sidebarSource !== 'all' && source !== state.sidebarSource) return false;
      if (it.empty && it.kind === 'codex' && !it.chatId) return false;
      if (!s.showArchived && (it.archived || it.hidden)) return false;
      if (!s.showSubagents && (it.subagent || it.parentKey)) return false;
      if (q && !(`${it.title} ${it.cwd} ${it.threadId || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });

    if (!items.length && (q || !sidebarFilterOn())) {
      const msg = state.sidebarSource === 'claude' ? '找不到本機 Claude Code 紀錄。可在 API 設定指定 Claude 設定資料夾，或使用「匯入對話」。' : !state.sidebar.codexAvailable
        ? '找不到 Codex 的資料夾。可以直接開始新對話，或到「設定」指定 CODEX_HOME。'
        : (q ? '沒有符合的對話。' : '還沒有對話。按「新對話」開始。');
      list.append(h('div', { class: 'side-empty', text: msg }));
      return;
    }

    let groups = [];
    const pinned = items.filter((it) => it.pinned && !it.archived && !it.hidden && !collectionOf(it));
    if (pinned.length) groups.push({ key: 'pinned', name: '釘選', title: '', items: pinned });
    const map = new Map();
    for (const it of items) {
      if (it.pinned && !it.archived && !it.hidden && !collectionOf(it)) continue;
      const source = collectionOf(it);
      const dir = it.sourceProjectKey || normDir(it.cwd || '') || 'none';
      const g = source ? { key: `source:${source}:${dir}`, name: it.cwd ? baseName(it.cwd) : '未指定資料夾', title: it.cwd || '', dir: `source:${source}:${dir}`, projectKey: dir, collection: source } : groupFor(it, projects, roots);
      if (!map.has(g.key)) { map.set(g.key, { ...g, items: [] }); groups.push(map.get(g.key)); }
      map.get(g.key).items.push(it);
    }
    // 手動加入的空資料夾也要立即顯示，不能等到裡面先有一段 LLM 對話才出現。
    if (sidebarFilterOn()) {
      for (const dir of s.sidebarProjects) {
        if (!dir || groups.some((g) => g.dir === dir)) continue;
        groups.push({ key: `d:${dir}`, name: baseName(dir), title: dir, dir, items: [] });
      }
    }
    if (sidebarFilterOn()) {
      const shown = new Set(s.sidebarProjects);
      groups = groups.filter((g) => g.key === 'pinned' || g.collection || shown.has(g.dir));
      if (!groups.length) list.append(h('div', { class: 'side-empty', text: '側欄還沒有加入任何專案。按下面的「載入專案」選擇要顯示的專案。' }));
    } else {
      groups = groups.filter((g) => g.key === 'pinned' || !isRemovedProject(g.dir));
    }

    // 自訂順序：專案之間照 sidebarOrder，群組裡的對話照 threadOrder；沒排過的維持原樣
    if (!q) {
      const projectAt = orderIndex(s.sidebarOrder);
      groups = groups.map((g, i) => ({ g, i })).sort((a, b) => {
        if (a.g.key === 'pinned' || b.g.key === 'pinned') return a.g.key === 'pinned' ? -1 : 1;
        return (projectAt(a.g.dir) - projectAt(b.g.dir)) || (a.i - b.i);
      }).map((x) => x.g);
      const threadAt = orderIndex(s.threadOrder);
      for (const g of groups) {
        // 拖曳排序之後才建立的新對話排在最上面；不然會被排到最後、藏進「顯示其餘」，看起來像沒加進專案
        const newest = Math.max(0, ...g.items.filter((it) => threadAt(it.key) !== BOTTOM).map((it) => it.createdAt || 0));
        const rank = (it) => { const at = threadAt(it.key); return at !== BOTTOM ? at : (it.createdAt || 0) > newest ? -1 : BOTTOM; };
        g.items = g.items.map((it, i) => ({ it, i })).sort((a, b) => (rank(a.it) - rank(b.it)) || (a.i - b.i)).map((x) => x.it);
      }
    }

    if (!q && (!state.sidebarSource || state.sidebarSource === 'all')) scheduleSidebarMirror(groups);
    const collapsed = new Set(s.collapsedGroups || []);
    const collectionBodies = new Map();
    for (const g of groups) {
      if (g.collection && !collectionBodies.has(g.collection)) {
        const source = g.collection;
        const key = `collection:${source}`;
        const parent = h('div', { class: `group source-collection${collapsed.has(key) && !q ? ' collapsed' : ''}` });
        const parentHead = h('div', { class: 'group-row' }, h('button', { class: 'group-head', onclick: () => toggleGroup(key), oncontextmenu: (e) => { e.preventDefault(); collectionMenu(source, e.currentTarget); } },
          svgCaret(), h('span', { class: 'gname', text: source === 'codex' ? 'Codex 專案' : 'Claude Code 專案' })));
        const parentBody = h('div', { class: 'source-collection-items' });
        parent.append(parentHead, parentBody);
        collectionBodies.set(source, parentBody);
        list.append(parent);
      }
      const isCollapsed = collapsed.has(g.key) && !q;
      const wrap = h('div', { class: `group${isCollapsed ? ' collapsed' : ''}` });
      const head = h('div', { class: 'group-row' },
        h('button', { class: 'group-head', title: `${g.title || g.name}\n長按可拖曳排序\n右鍵：收起／移除／只保留這個專案`, onclick: () => toggleGroup(g.key), oncontextmenu: (e) => { e.preventDefault(); groupMenu(g, e.currentTarget); } },
          svgCaret(), h('span', { class: 'gname', text: g.name }), h('span', { class: 'gcount', text: g.items.length })));
      const body = h('div', { class: 'group-items' });
      const showAll = state.expanded.has(g.key) || q;
      const visible = showAll ? g.items : g.items.slice(0, PAGE);
      for (const it of visible) {
        const btn = threadButton(it);
        btn.dataset.sortId = it.key;
        if (!q) enableDragSort(btn, 'thread', saveThreadOrder);
        body.append(btn);
      }
      if (!g.items.length) body.append(h('div', { class: 'group-empty', text: '這個資料夾還沒有對話；選取資料夾後按「新對話」開始。' }));
      if (!showAll && g.items.length > PAGE) {
        body.append(h('button', { class: 'more-btn', text: `顯示其餘 ${g.items.length - PAGE} 則`, onclick: () => { state.expanded.add(g.key); renderSidebar(); } }));
      }
      wrap.append(head, body);
      if (g.key !== 'pinned' && !g.collection && !q) {
        wrap.dataset.sortId = g.dir;
        enableDragSort(wrap, 'project', saveProjectOrder, head.querySelector('.group-head'));
      }
      if (g.collection) collectionBodies.get(g.collection).append(wrap);
      else list.append(wrap);
    }
    for (const source of s.sidebarSources || []) {
      if (collectionBodies.has(source) || !['codex', 'claude'].includes(source)) continue;
      const key = `collection:${source}`;
      const parent = h('div', { class: `group source-collection${collapsed.has(key) && !q ? ' collapsed' : ''}` },
        h('div', { class: 'group-row' }, h('button', { class: 'group-head', onclick: () => toggleGroup(key), oncontextmenu: (e) => { e.preventDefault(); collectionMenu(source, e.currentTarget); } },
          svgCaret(), h('span', { class: 'gname', text: source === 'codex' ? 'Codex 專案' : 'Claude Code 專案' }))),
        h('div', { class: 'source-collection-items' }, h('div', { class: 'group-empty', text: '目前找不到本機對話紀錄。' })));
      list.append(parent);
    }
    // 「載入專案」只做一件事：由使用者親自選擇一個資料夾。
    if (!q) {
      const more = h('button', { type: 'button', class: 'load-projects', title: '把專案資料夾載入側欄' }, '＋ 載入專案…',
        h('small', { text: '選擇資料夾' }));
      more.onclick = () => addProjectFolder();
      list.append(more);
    }
    list.scrollTop = scroll;
  }

  // ---- 側欄管理資料夾：側欄鏡像成資料夾裡的捷徑；在檔案總管刪除／搬移會反映回側欄 ----
  let mirrorTimer = null;
  let mirrorBusy = false;
  function scheduleSidebarMirror(groups) {
    const loaded = Array.isArray(state.settings?.sidebarProjects) ? state.settings.sidebarProjects : [];
    const shown = groups.map((g) => ({
      groupKey: g.key,
      name: g.key === 'pinned' ? '釘選' : g.collection ? `${g.collection === 'codex' ? 'Codex' : 'Claude Code'}－${g.name}` : g.name,
      dir: g.key === 'pinned' || g.collection ? '' : (g.title || ''),
      removable: g.key !== 'pinned' && !g.collection && !!g.title && loaded.includes(g.dir),
      items: g.items.map((it) => ({ key: it.key, title: it.title })),
    }));
    const shownKeys = new Set(shown.flatMap((g) => g.items.map((it) => it.key)));
    const others = new Map();
    for (const it of state.sidebar.items || []) {
      if (shownKeys.has(it.key) || it.subagent || it.parentKey || (it.empty && it.kind === 'codex' && !it.chatId)) continue;
      const k = normDir(it.cwd || '') || 'none';
      if (!others.has(k)) others.set(k, { groupKey: `o:${k}`, name: it.cwd ? baseName(it.cwd) : '未指定資料夾', dir: it.cwd || '', items: [] });
      others.get(k).items.push({ key: it.key, title: it.title });
    }
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => runSidebarMirror({ shown, others: [...others.values()] }), 1200);
  }
  async function runSidebarMirror(payload) {
    if (mirrorBusy) { clearTimeout(mirrorTimer); mirrorTimer = setTimeout(() => runSidebarMirror(payload), 1000); return; }
    mirrorBusy = true;
    try {
      const r = await api.syncSidebarMirror(payload);
      if (r && r.changed) {
        state.settings = await api.getSettings();
        await refreshSidebar();
        const parts = [r.removed && `移除 ${r.removed} 則對話`, r.removedProjects && `移除 ${r.removedProjects} 個專案`, r.placed && `放回／移動 ${r.placed} 則對話`].filter(Boolean);
        if (parts.length) toast(`已依側欄管理資料夾${parts.join('、')}`, 5000);
      }
    } catch (e) { console.warn('側欄管理資料夾同步失敗', e); }
    finally { mirrorBusy = false; }
  }
  async function openSidebarFolder() {
    try { const err = await api.openSidebarMirror(); if (err) toast(err, 6000); } catch (e) { toast(e.message, 6000); }
  }

  function searchQuery() {
    const q = state.search.trim().toLowerCase();
    const m = /codex:\/\/threads\/([0-9a-f-]{36})/.exec(q);
    return m ? m[1] : q;
  }

  // 用 codex://threads/<id> 或執行緒 ID 開啟
  async function openByLink(text) {
    const targetCwd = currentCwd();
    const r = await api.resolveCodexLink({ text, cwd: targetCwd, place: true });
    if (!r.ok) { toast(r.message, 8000); return false; }
    $('#linkBox').hidden = true;
    state.search = ''; $('#search').value = '';
    state.settings = await api.getSettings();
    $('#optArchived').checked = !!state.settings.showArchived;
    $('#optSub').checked = !!state.settings.showSubagents;
    if (r.placed || state.sidebarSource === 'claude') {
      state.sidebarSource = 'all';
      document.querySelectorAll('.sidebar-sources button').forEach(b => b.setAttribute('aria-pressed', String(b.id === 'btnSourceAll')));
    }
    await refreshSidebar();
    await openChat(r.key);
    if (r.placed) {
      await revealInSidebar(r.key);
      toast(`已開啟並加入「${baseName(targetCwd) || '未指定資料夾'}」`);
      return true;
    }
    if (!r.subagent && (r.hidden || !isShownInSidebar(r.key))) {
      const item = (state.sidebar.items || []).find((x) => x.key === r.key);
      let placed = { action: 'none' };
      try { placed = await api.askPlaceThread({ key: r.key, title: r.title || item?.title, cwd: item?.cwd || r.cwd }); }
      catch (e) { toast(e.message, 6000); }
      if (placed.action !== 'none') {
        if (r.hidden) await api.unhideThread({ key: r.key, threadId: r.id });
        state.settings = await api.getSettings();
        if (placed.action === 'move' && state.current?.key === r.key) state.current.cwd = placed.cwd;
        state.search = ''; $('#search').value = '';
        await refreshSidebar();
        await revealInSidebar(r.key);
        const note = r.archived ? '（這是已封存的執行緒，要勾選左下角「顯示封存與已移除」才看得到）' : '';
        toast(placed.action === 'move' ? `已把「${r.title || r.id}」移到「${baseName(placed.cwd)}」${note}` : `已在側欄顯示「${baseName(placed.cwd)}」${note}`, 6000);
        return true;
      }
    }
    const notes = [r.archived && '已封存', r.hidden && '已從側欄移除', r.subagent && '子代理'].filter(Boolean);
    toast(`已開啟「${r.title || r.id}」${notes.length ? `（${notes.join('、')}，側欄需勾選左下角選項才看得到）` : ''}。清空搜尋框可回到完整列表。`, 6000);
    return true;
  }

  async function moveThreadTo(it, cwd) {
    if (runForKey(it.key)) { toast('這段對話還在執行，先暫停再移動'); return; }
    try {
      await api.moveThread({ key: it.key, cwd });
      if (state.current?.key === it.key) { state.current.cwd = cwd; renderComposerBar(); }
      state.settings = await api.getSettings();
      await refreshSidebar();
      await revealInSidebar(it.key);
      toast(cwd ? `已移到「${baseName(cwd)}」；之後在這段對話送出的訊息會在這個資料夾工作` : '已改成不指定資料夾', 5000);
    } catch (e) { toast(e.message, 6000); }
  }

  function openMoveMenu(it, anchor) {
    const seen = new Set();
    const items = [];
    const add = (dir, name) => {
      const n = normDir(dir);
      if (!dir || seen.has(n)) return;
      seen.add(n);
      items.push({ label: name || baseName(dir), desc: dir, checked: n === normDir(it.cwd), onSelect: () => moveThreadTo(it, dir) });
    };
    for (const dir of state.settings.sidebarProjects || []) add(dir);
    if (!items.length) items.push({ label: '側欄尚未載入專案', desc: '先按「載入專案」選擇資料夾', onSelect: () => {} });
    openMenu(anchor, {
      title: `把「${it.title}」移到…`, items,
    });
  }

  // ---------------- Codex 多帳號 ----------------
  const planName = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : '');
  const activeCodexAccount = () => (state.codexAccounts?.accounts || []).find((a) => a.active) || null;
  async function loadCodexAccounts() {
    try { state.codexAccounts = await api.codexAccounts(); } catch (e) { state.codexAccounts = { accounts: [], error: String(e.message || e) }; }
    renderComposerBar();
  }
  async function switchCodexAccount(a) {
    try {
      const r = await api.switchCodexAccount(a.id);
      if (r.cancelled) return;
      if (!r.unchanged) toast(`已切換到「${a.label}」；正在執行的回合沿用原帳號，下一次送出使用新帳號`, 6000);
      state.usage = null;
      await loadCodexAccounts();
      refreshUsage();
    } catch (e) { toast(e.message, 7000); }
  }
  async function openCodexAccountMenu(anchor = $('#keyBtn')) {
    if (openPop && openPop.anchor === anchor) { closeMenu(); return; }
    await loadCodexAccounts();
    const data = state.codexAccounts || { accounts: [] };
    const items = [];
    if (data.error) items.push({ label: '讀不到帳號清單', desc: data.error, onSelect: () => {} });
    if (!data.accounts.length) items.push({ label: '還沒有登入 Codex', desc: '按下面的「登入 Codex 帳號」', onSelect: () => loginCodexAccount() });
    for (const a of data.accounts) {
      items.push({
        label: a.label, checked: a.active,
        desc: [a.active ? '使用中' : '', planName(a.plan), a.workspace, a.name ? a.email : ''].filter(Boolean).join(' · '),
        onSelect: () => { if (!a.active) switchCodexAccount(a); },
      });
    }
    openMenu(anchor, {
      title: 'Codex 帳號（Codex 與 GPT 共用）', items,
      footer: [
        ...(data.accounts.length ? [{ label: '重新登入／更新目前 Codex 帳號…', onSelect: () => loginCodexAccount() }] : []),
        { label: data.accounts.length ? '登入其他 Codex 帳號…' : '登入 Codex 帳號…', onSelect: () => loginCodexAccount() },
        ...(data.accounts.length ? [{ label: '管理帳號（改名／移除）…', onSelect: () => manageCodexAccounts(anchor) }] : []),
      ],
    });
  }
  function manageCodexAccounts(anchor) {
    const data = state.codexAccounts || { accounts: [] };
    openMenu(anchor, {
      title: '選擇要管理的帳號',
      items: data.accounts.map((a) => ({ label: a.label, desc: a.email || a.hint || '', checked: a.active, onSelect: () => editCodexAccount(a, anchor) })),
    });
  }
  function editCodexAccount(a, anchor) {
    openMenu(anchor, {
      title: `帳號：${a.label}`,
      items: [
        { label: '恢復顯示 email', desc: '清除自訂名稱', onSelect: async () => { await api.renameCodexAccount({ id: a.id, name: '' }); await loadCodexAccounts(); } },
        { label: '從這個 App 移除', desc: a.active ? '使用中的帳號要先切換到別的帳號' : '只刪除 App 裡存的登入資料', danger: true, onSelect: async () => {
          try { const r = await api.removeCodexAccount(a.id); if (r.message) toast(r.message, 6000); else if (r.ok) toast(`已移除「${a.label}」`); }
          catch (e) { toast(e.message, 6000); }
          await loadCodexAccounts();
        } },
      ],
      inputPlaceholder: '輸入自訂名稱後按 Enter，例如：公司帳號',
      onInput: async (v) => { await api.renameCodexAccount({ id: a.id, name: v }); await loadCodexAccounts(); toast('已改名'); },
    });
  }
  async function loginCodexAccount() {
    const dlg = $('#codexLoginDlg');
    if (dlg.open) return;
    let url = '';
    $('#cxLoginStatus').textContent = '正在啟動 Codex 登入，瀏覽器會自動開啟…';
    $('#cxLoginOpen').hidden = true; $('#cxLoginCopy').hidden = true;
    const off = api.onCodexLoginInfo((d) => {
      if (!url && d && /^https:\/\//.test(d.url || '')) {
        url = d.url;
        $('#cxLoginOpen').hidden = false; $('#cxLoginCopy').hidden = false;
        $('#cxLoginStatus').textContent = '請在瀏覽器完成登入。沒有自動開啟的話，按「再次開啟登入頁」。';
      }
    });
    $('#cxLoginOpen').onclick = () => { if (url) api.openExternal(url); };
    $('#cxLoginCopy').onclick = async () => { if (url) { await api.copyText(url); toast('已複製登入網址，可以貼到無痕視窗登入另一個帳號'); } };
    $('#cxLoginCancel').onclick = () => { $('#cxLoginStatus').textContent = '正在取消…'; api.cancelCodexLogin(); };
    dlg.oncancel = (e) => { e.preventDefault(); api.cancelCodexLogin(); };
    dlg.showModal();
    try {
      const r = await api.loginCodexAccount({ switchAfter: $('#cxSwitchAfter').checked });
      if (r.ok) {
        state.usage = null;
        toast(r.renewed ? `「${r.account.label}」重新登入完成，使用中的憑證已更新` : r.switched ? `已登入並切換到「${r.account.label}」` : `已新增 Codex 帳號「${r.account.label}」`, 6000);
        refreshUsage();
      } else if (!r.cancelled) toast(r.message || 'Codex 登入沒有完成', 8000);
    } catch (e) { toast(e.message, 8000); }
    finally { off(); if (dlg.open) dlg.close(); await loadCodexAccounts(); }
  }

  async function backupKeys(keys, title) {
    try {
      const r = await api.backupChats(keys ? { keys, title } : { all: true });
      if (!r.ok) { if (r.message) toast(r.message, 5000); return; }
      toast(`已備份 ${r.count} 段對話到 ${r.file}${r.errors?.length ? `；${r.errors.length} 段失敗：${r.errors.slice(0, 2).join('；')}` : ''}`, 8000);
    } catch (e) { toast(`備份失敗：${e.message}`, 8000); }
  }

  function svgCaret() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'caret');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M4 6l4 4 4-4');
    svg.append(p);
    return svg;
  }

  function threadButton(it) {
    const active = state.current && state.current.key === it.key;
    if (state.renaming === it.key) {
      const input = h('input', { class: 'thread-rename', value: it.title, maxlength: '120' });
      const finish = async (save) => {
        if (state.renaming !== it.key) return;
        state.renaming = null;
        const v = input.value.trim();
        if (save && v && v !== it.title) {
          const rr = await api.renameThread({ key: it.key, threadId: it.threadId, title: v });
          if (it.threadId) toast(rr.synced ? '已改名，Codex App 也會顯示新名稱' : `只改了這個 App 裡的名稱${rr.error ? `（Codex 回報：${rr.error.slice(0, 80)}）` : ''}`, 3500);
          if (state.current && state.current.key === it.key) { state.current.title = v; $('#chatTitle').value = v; }
          await refreshSidebar();
        } else renderSidebar();
      };
      input.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.key === 'Enter' && !e.isComposing) finish(true); if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return h('div', { class: 'thread renaming' }, input);
    }
    const running = !!runForKey(it.key);
    const btn = h('button', {
      class: `thread${active ? ' active' : ''}${it.archived || it.hidden ? ' archived' : ''}${running ? ' running' : ''}${state.unread.has(it.key) ? ' unread' : ''}`,
      dataset: { lp: it.lastProvider || '', key: it.key },
      title: `${it.title}${it.cwd ? `\n${it.cwd}` : ''}${it.hidden ? '\n（已從側欄移除）' : ''}`,
      onclick: () => openChat(it.key),
    }, h('span', { class: 'dot' }), h('span', { class: 't', text: it.title }), h('span', { class: 'time', text: relTime(it.updatedAt) }));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); threadMenu(it, btn); });
    return btn;
  }

  async function threadMenu(it, btn) {
    btn.classList.add('menu-open');
    const action = await api.threadMenu({ key: it.key, threadId: it.threadId, cwd: it.cwd, pinned: !!it.pinned, hidden: !!it.hidden, title: it.title, source: collectionOf(it) });
    btn.classList.remove('menu-open');
    switch (action) {
      case 'open': openChat(it.key); break;
      case 'rename': state.renaming = it.key; renderSidebar(); break;
      case 'pin': await api.pinThread({ key: it.key, pinned: !it.pinned }); await refreshSidebar(); break;
      case 'openCodex': api.openCodexThread(it.threadId); break;
      case 'openFolder': api.openPath(it.cwd); break;
      case 'copyId': await api.copyText(it.threadId); toast(`已複製工作 ID：${it.threadId}`); break;
      case 'copyLink': await api.copyText(`codex://threads/${it.threadId}`); toast('已複製 Codex 連結，可貼到「用連結開啟」'); break;
      case 'copyChatId': await api.copyText(it.chatId || it.key.slice(4)); toast('已複製對話 ID'); break;
      case 'copyClaudeId': await api.copyText(it.key.slice('localclaude:'.length)); toast('已複製 Claude Code 工作階段 ID'); break;
      case 'copyCwd': await api.copyText(it.cwd); toast(`已複製專案資料夾路徑：${it.cwd}`, 4000); break;
      case 'copyLog': case 'showLog': {
        const r = await api.threadLogPath({ item: { key: it.key }, reveal: action === 'showLog' });
        toast(r.ok ? (action === 'copyLog' ? `已複製紀錄檔路徑：${r.path}` : '已在檔案總管顯示紀錄檔') : r.message, 5000);
        break;
      }
      case 'backup': await backupKeys([it.key], it.title); break;
      case 'removeSourceConversation': {
        try {
          const r = await api.removeSourceConversation(collectionOf(it), it.sourceConversationKey || it.key);
          state.settings = r.settings; state.sidebar = r.sidebar; renderSidebar();
          toast('已從側欄移除這則對話，原始紀錄仍保留');
        } catch (e) { toast(e.message, 6000); }
        break;
      }
      case 'move': openMoveMenu(it, btn); break;
      case 'unhide': await api.unhideThread({ key: it.key, threadId: it.threadId }); await refreshSidebar(); toast('已放回側欄'); break;
      case 'delete': {
        if (runForKey(it.key)) { toast('這段對話還在回覆中，先停止再刪除'); break; }
        toast('正在盤點要刪除的紀錄，第一次可能需要一分鐘…', 8000);
        let r;
        try { r = await api.removeThread({ key: it.key, threadId: it.threadId, title: it.title }); }
        catch (e) { toast(`永久刪除失敗：${String(e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`, 8000); break; }
        if (!r.ok) break;
        if (state.current && (state.current.key === it.key || (it.threadId && state.current.threadId === it.threadId))) {
          state.current = null; try {sessionStorage.removeItem('wangpin-recovery-chat');} catch {} renderHeader(); renderMessages();
        }
        await refreshSidebar();
        toast(r.removed === 'archived' ? '已在 Codex 封存' : r.removed === 'hidden' ? '已從側欄移除' : '已刪除');
        break;
      }
      default: break;
    }
  }

  function newChatIn(cwd) {
    viewEpoch++;
    chatSelectionReady = Promise.resolve({});
    state.current = null; try {sessionStorage.removeItem('wangpin-recovery-chat');} catch {}
    state.pendingCwd = cwd;
    state.pendingExtensions = [];
    state.pendingHarness = ''; state.pendingSystemPrompt = '';
    renderHeader();
    renderMessages();
    renderSidebar();
    updateSendButton();
    $('#input').focus();
  }

  async function toggleGroup(key) {
    const set = new Set(state.settings.collapsedGroups || []);
    if (set.has(key)) set.delete(key); else set.add(key);
    state.settings.collapsedGroups = [...set];
    renderSidebar();
    state.settings = await api.saveSettings({ collapsedGroups: [...set] });
  }

  // ---------------- 對話 ----------------
  async function waitChatSelection(epoch = viewEpoch) {
    const restored = await chatSelectionReady;
    if (viewEpoch !== epoch) throw Error('對話已切換，請在目前對話重新開啟流程。');
    if (restored?.error) throw Error('無法還原這段對話的模型：' + restored.error);
  }
  async function yieldChatView(epoch, chat) {
    // A macrotask lets input, paint and progress updates run between native DOM work.
    await new Promise(resolve => {
      if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
    return epoch === viewEpoch && state.current === chat;
  }
  async function openChat(key, { keepScroll = false, terminalGeneration = null } = {}) {
    const epoch = ++viewEpoch;
    let finishSelection, selectionError = '';
    chatSelectionReady = new Promise(resolve => { finishSelection = resolve; });
    try {
    const reloadGeneration = key === state.current?.key ? sendGeneration : null;
    if (key.startsWith('localclaude:')) {
      try {
        const loaded = await api.openClaudeConversation(key.slice('localclaude:'.length));
        await refreshSidebar();
        if (epoch !== viewEpoch) return;
        key = loaded.key;
        toast('已載入 Claude Code 對話副本；操作檔案前請選擇專案', 5000);
      } catch (e) { toast(e.message, 6000); return; }
    }
    if (state.current?.key !== key) saveDraft();
    if (state.current?.key !== key) { draftRevision++; pendingAttachments = []; renderAttachments(); }
    const r = await api.openChat(key);
    if (epoch !== viewEpoch) return;
    if (reloadGeneration !== null && reloadGeneration !== sendGeneration) return;
    if (terminalGeneration !== null && terminalGeneration !== sendGeneration) return;
    if (r.error) { selectionError = r.error; toast(r.error); return; }
    const changed = state.current?.key !== key;
    if (changed && !$('#findBar').hidden) closeFind();
    // Hide the previous chat's editor before asynchronous settings restoration;
    // otherwise the next footer click merely folds that stale editor.
    state.current = r;
    try { sessionStorage.setItem('wangpin-recovery-chat',key); } catch {}
    if (!await yieldChatView(epoch, r)) return;
    if (changed) restoreDraft(key);
    if (!await yieldChatView(epoch, r)) return;
    if (changed) { try { await restorePick(r.modelPick); } catch(error) { selectionError = error.message || String(error); } if (epoch !== viewEpoch) return; }
    if (changed && r.importedCwd) toast(`這段對話原本的專案資料夾：${r.importedCwd}。要讓模型操作檔案，請從下方專案選單選回該資料夾。`, 7000);
    state.unread.delete(key);
    renderHeader();
    if (!await yieldChatView(epoch, r)) return;
    if (!await renderSelectedMessages(epoch, r, { keepScroll })) return;
    attachRun(runForKey(key));
    updateSendButton();
    if (!await yieldChatView(epoch, r)) return;
    renderSidebar();
    if (!await yieldChatView(epoch, r)) return;
    renderExtPill();
    if (!await yieldChatView(epoch, r)) return;
    if (!keepScroll) $('#input').focus();
    } catch(error) { selectionError = error.message || String(error); throw error; }
    finally { finishSelection({error:selectionError}); }
  }

  // 切回正在回覆的對話時，把還沒存檔的使用者訊息和回覆中的區塊放回畫面
  function attachRun(run) {
    if (!run) return;
    const box = $('#messages');
    box.querySelector('.empty-note')?.remove();
    const hasUser = run.provider !== 'codex';
    if (!hasUser || !(state.current.messages || []).some((m) => m.role === 'user' && m.text === run.userText)) box.append(run.userEl);
    box.append(run.el);
    if (!run.terminal) scheduleRender(run);
    box.scrollTop = box.scrollHeight;
  }


  function updateSendButton() {
    const run = currentRun();
    const btn = $('#btnSend');
    const stopping = !!run;
    btn.textContent = stopping ? '停止' : '送出';
    btn.classList.toggle('stop', stopping);
    btn.title = stopping ? '停止（Esc）' : '送出（Enter）';
    const pause = $('#btnPause');
    if (pause) { pause.hidden = !run; pause.disabled=!!run?.pausing; }
    const resume = $('#btnResume');
    if (resume) resume.hidden=!!run || !state.current || !(state.current.paused || state.current.messages?.at(-1)?.partial);
  }

  function openDistillExport() {
    if (!state.current) return;
    const key = state.current.key;
    let busy = false, samples = 0, epoch = 0;
    const dlg = h('dialog', { id: 'distillDlg', 'aria-labelledby': 'distillHeading' });
    const format = h('select', { id: 'distillFormat', 'aria-label': '樣本格式' },
      h('option', { value: 'messages', text: 'messages JSONL（多輪對話）' }), h('option', { value: 'alpaca', text: 'Alpaca JSONL（逐筆問答）' }));
    format.value = state.settings.distillExport?.format || 'messages';
    const folder = h('input', { id: 'distillFolder', type: 'text', placeholder: '請選擇輸出資料夾', 'aria-label': '輸出資料夾', value: state.settings.distillExport?.folder || '' });
    const attachments = h('input', { id: 'distillAttachments', type: 'checkbox' });
    const summary = h('p', { id: 'distillSummary', class: 'set-intro', role: 'status', text: '正在讀取對話…' });
    const result = h('p', { id: 'distillResult', class: 'distill-result', role: 'status' });
    const openFolder = h('button', { type: 'button', class: 'btn-small', text: '開啟輸出資料夾', hidden: true });
    const close = h('button', { type: 'button', class: 'btn-small', text: '關閉', onclick: () => { if (!busy) dlg.close(); } });
    const exportBtn = h('button', { id: 'distillSave', type: 'button', class: 'btn-small primary', text: '匯出 JSONL', disabled: true });
    const choose = h('button', { id: 'distillChoose', type: 'button', class: 'btn-small', text: '選擇資料夾…', onclick: async () => {
      try { const picked = await api.pickDistillFolder(folder.value); if (picked) { folder.value = picked; resetResult(); } }
      catch (e) { result.textContent = e.message; }
    } });
    const enable = () => { exportBtn.disabled = busy || !samples || !folder.value.trim(); };
    const resetResult = () => { result.textContent = ''; openFolder.hidden = true; enable(); };
    const options = () => ({ key, format: format.value, includeAttachmentText: attachments.checked });
    const describe = (s) => `${s.samples} 筆樣本，${s.turns} 輪完整問答。` +
      (s.excludedResponses ? ` 略過 ${s.excludedResponses} 則未完成／錯誤訊息。` : '') +
      (s.ignoredProgress ? ` 略過 ${s.ignoredProgress} 則推理／進度訊息。` : '') +
      (s.excludedAttachmentMessages ? ` 附件回合起的 ${s.excludedAttachmentMessages} 則訊息未匯出。` : '') +
      (s.attachmentTurns && attachments.checked ? ' 只包含附件回合的文字，請檢視是否缺少必要上下文。' : '') +
      (s.unanswered ? ` ${s.unanswered} 個尚未回答的問題未匯出。` : '') +
      (s.liveExcluded ? ' 執行中的這一輪未匯出。' : '');
    const refresh = async () => {
      const ticket = ++epoch; samples = 0; resetResult(); summary.textContent = '正在讀取對話…';
      try {
        const preview = await api.previewDistill(options());
        if (ticket !== epoch || !dlg.open) return;
        samples = preview.stats.samples; summary.textContent = describe(preview.stats);
        if (!samples) summary.textContent += ' 目前沒有可匯出的完整文字問答。';
      } catch (e) { if (ticket === epoch) summary.textContent = e.message; }
      enable();
    };
    format.onchange = refresh; attachments.onchange = refresh; folder.oninput = resetResult;
    exportBtn.onclick = async () => {
      busy = true; enable(); result.textContent = '正在匯出…';
      for (const control of [format, folder, attachments, choose, close]) control.disabled = true;
      try {
        const exported = await api.exportDistill({ ...options(), folder: folder.value.trim() });
        state.settings.distillExport = { folder: folder.value.trim(), format: format.value };
        summary.textContent = describe(exported.stats);
        result.textContent = `已匯出 ${exported.stats.samples} 筆：\n${exported.file}${exported.warning ? '\n' + exported.warning : ''}`;
        openFolder.hidden = false; const outputFolder = folder.value.trim();
        openFolder.onclick = () => api.openPath(outputFolder).catch(e => { result.textContent = e.message; });
      } catch (e) { result.textContent = e.message; }
      finally { busy = false; for (const control of [format, folder, attachments, choose, close]) control.disabled = false; enable(); }
    };
    dlg.append(h('div', { class: 'dlg-shell' },
      h('div', { class: 'dlg-head' }, h('h2', { id: 'distillHeading', text: '匯出蒸餾樣本' })),
      h('div', { class: 'dlg-body distill-body' },
        h('p', { class: 'set-intro', text: '把這段對話的完整回答整理成文字訓練樣本。' }),
        h('label', {}, '樣本格式', format),
        h('p', { class: 'set-note', text: 'messages：每段多輪對話一筆；Alpaca：每輪問答一筆，保留前文 history。' }),
        h('label', {}, '輸出資料夾', h('div', { class: 'distill-folder' }, folder, choose)),
        h('label', { class: 'chk' }, attachments, h('span', { text: '包含附件回合與後續的文字（附件不會匯出）' })),
        h('p', { class: 'set-note', text: '預設匯出第一個附件回合之前的完整問答。工具紀錄、推理／進度與未完成的回答會略過；正在執行時可匯出先前已完成的內容。' }), summary, result),
      h('div', { class: 'dlg-foot' }, openFolder, close, exportBtn)));
    dlg.oncancel = e => { if (busy) e.preventDefault(); };
    dlg.addEventListener('close', () => { epoch++; dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); refresh();
  }

  function renderHeader() {
    const c = state.current;
    $('#chatHeader').hidden = !c;
    renderComposerBar();
    syncPanels();
    if (!c) return;
    $('#chatTitle').value = c.title || '';
    $('#btnOpenCodex').hidden = !c.threadId;
  }

  let panelSyncQueued = false;
  function syncPanels() {
    if (panelSyncQueued) return;
    panelSyncQueued = true;
    const run = () => {
      if (!panelSyncQueued) return;
      panelSyncQueued = false;
      syncBrowser();
      syncGptWebView();
      if (agentUi.key !== (state.current?.key || null)) refreshAgents(); else renderAgents();
    };
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }

  let messageRenderRevision = 0;
  const RECENT_MESSAGE_BATCH = 50;
  let messageWindowKey = null, messageWindowStart = 0, messageWindowExpanded = false;
  // A page of 32 multi-megabyte messages is much heavier than 50 ordinary ones.
  function recentMessageStart(messages) {
    let start=messages.length,chars=0;
    while(start>0 && messages.length-start<RECENT_MESSAGE_BATCH) {
      const message=messages[start-1],cost=String(message.text||'').length+String(message.reasoning||'').length;
      if(start<messages.length && chars+cost>256*1024)break;
      chars+=cost;start--;
    }
    return start;
  }
  function savedText(container,text,{markdown=false}={}) {
    text=String(text||'');
    const render=value=>{if(markdown)renderMarkdown(container,value);else container.textContent=value;};
    if(text.length<=65536){render(text);return;}
    render(text.slice(0,4096)+'\n\n…\n\n'+text.slice(-8192));
    const expand=()=>{render(text);button.remove();};
    container.__expandSavedText=expand;
    const button=h('button',{type:'button',class:'btn-small expand-saved-text',text:`展開完整訊息（${text.length.toLocaleString()} 字元）`,onclick:()=>{expand();delete container.__expandSavedText;}});
    container.append(button);
  }
  let messageRenderBusy = false;
  function updateOlderMessageControl() {
    const box = $('#messages');
    const old = box.querySelector?.('#loadOlderMessages');
    if (!state.current || messageWindowStart === 0) { old?.remove(); return; }
    const button = old || h('button', { id: 'loadOlderMessages', type: 'button', class: 'btn-small older-messages', onclick: () => loadOlderMessages().catch(error => toast(error.message)) });
    button.textContent = '載入較早訊息（還有 ' + messageWindowStart + ' 則）';
    if (!old) box.insertBefore(button, box.firstChild || null);
  }
  async function loadOlderMessages() {
    const chat = state.current, epoch = viewEpoch, box = $('#messages');
    if (!chat || messageRenderBusy || messageWindowKey !== chat.key || !messageWindowStart) return;
    const revision = ++messageRenderRevision;
    messageRenderBusy = true;
    const beforeHeight = box.scrollHeight, beforeTop = box.scrollTop;
    const end = messageWindowStart, start = Math.max(0, end - RECENT_MESSAGE_BATCH);
    const before = box.querySelector('[data-idx]') || null;
    const anchorIndex = before?.dataset?.idx;
    const anchorTop = before?.getBoundingClientRect?.().top;
    const valid = () => state.current === chat && viewEpoch === epoch && revision === messageRenderRevision;
    let committed = false;
    try {
      let started = performance.now();
      for (let i = start; i < end; i++) {
        if (!valid()) return;
        const message = chat.messages[i], el = messageEl(message);
        if (el) { el.dataset.idx = String(i); box.insertBefore(el, anchorIndex === undefined ? null : box.querySelector('[data-idx="' + anchorIndex + '"]') || null); }
        if (performance.now() - started >= 8) {
          if (!await yieldChatView(epoch, chat) || !valid()) return;
          started = performance.now();
        }
      }
      if (!valid()) return;
      messageWindowStart = start; messageWindowExpanded = true; committed = true;
      updateOlderMessageControl();
      const anchor = anchorIndex === undefined ? null : box.querySelector('[data-idx="' + anchorIndex + '"]');
      if (Number.isFinite(anchorTop) && anchor?.getBoundingClientRect) box.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      else box.scrollTop = beforeTop + box.scrollHeight - beforeHeight;
      if (!$('#findBar').hidden) findRun({ keepIndex: true });
    } finally {
      if (!committed && state.current === chat && revision === messageRenderRevision) {
        // A rejected target selection can leave this chat visible. Undo only
        // our unfinished page, including flow nodes replaced during the yield.
        for (const el of box.querySelectorAll('[data-idx]')) {
          const index = Number(el.dataset.idx);
          if (index >= start && index < end) el.remove();
        }
        updateOlderMessageControl();
        box.scrollTop = beforeTop;
      }
      if (revision === messageRenderRevision) messageRenderBusy = false;
    }
  }

  function* messageRenderSteps({ keepScroll = false, fullHistory = false } = {}) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const prevTop = box.scrollTop;
    // Keep the inline iframe attached: detaching destroys its editor document.
    for (const child of [...box.children]) {
      child.remove();
      yield;
    }
    const c = state.current;
    if (!c) { messageWindowKey = null; renderWelcome(); return; }
    if (messageWindowKey !== c.key) {
      messageWindowKey = c.key; messageWindowExpanded = false;
    }
    if (fullHistory) messageWindowExpanded = true;
    messageWindowStart = fullHistory ? 0 : messageWindowExpanded ? Math.min(messageWindowStart, c.messages.length) : recentMessageStart(c.messages);
    updateOlderMessageControl();
    if (c.codexError) box.append(h('div', { class: 'msg note', text: c.codexError }));
    if (!c.messages.length) {
      box.append(h('div', { class: 'msg note empty-note', text: '這段對話還沒有內容。可以隨時切換下方的模型。' }));
    }
    for (let i = messageWindowStart; i < c.messages.length; i++) {
      const m = c.messages[i];
      const el = messageEl(m);
      if (el) { el.dataset.idx = String(i); box.insertBefore(el, null); }
      yield;
    }
    yield;
    if (keepScroll && !atBottom) box.scrollTop = prevTop;
    else box.scrollTop = box.scrollHeight;
    // 尋找列開著時，重畫後要重新標亮（位置保持在原本那一個）
    if (!$('#findBar').hidden) findRun({ keepIndex: true });
  }
  function renderMessages(options = {}) {
    const revision = ++messageRenderRevision;
    messageRenderBusy = true;
    try { for (const step of messageRenderSteps(options)) { /* drain recent window */ } }
    finally { if (revision === messageRenderRevision) messageRenderBusy = false; }
  }
  async function renderSelectedMessages(epoch, chat, options = {}) {
    const revision = ++messageRenderRevision;
    messageRenderBusy = true;
    const valid = () => epoch === viewEpoch && state.current === chat && revision === messageRenderRevision;
    const steps = messageRenderSteps(options);
    let started = performance.now();
    try {
      while (valid()) {
        if (steps.next().done) return true;
        if (performance.now() - started >= 8) {
          if (!await yieldChatView(epoch, chat) || !valid()) return false;
          started = performance.now();
        }
      }
      return false;
    } finally { if (revision === messageRenderRevision) messageRenderBusy = false; }
  }
  // ---------------- 對話內容搜尋（所有對話）----------------
  async function runContentSearch(query) {
    const q = String(query || '').trim();
    if (!q) { api.cancelChatSearch(); state.contentSearch = null; renderSidebar(); return; }
    const token = {};
    state.contentSearch = { query: q, loading: true, token, results: [] };
    renderSidebar();
    try {
      const visible = new Set(state.settings?.sidebarProjects || []);
      const { projects, roots } = sidebarMaps();
      const allowedKeys = (state.sidebar.items || []).filter(it => {
        const source = it.source || (it.kind === 'codex' ? 'codex' : 'app');
        if (state.sidebarSource && state.sidebarSource !== 'all' && source !== state.sidebarSource) return false;
        if (unselectedSource(it)) return false;
        if (!state.settings?.showArchived && (it.archived || it.hidden)) return false;
        if (!state.settings?.showSubagents && (it.subagent || it.parentKey)) return false;
        if (it.pinned && !it.archived && !it.hidden) return true;
        if (collectionOf(it)) return true;
        return visible.has(groupFor(it, projects, roots).dir);
      }).map(it => it.key);
      const r = await api.searchChats({ query: q, allowedKeys, budgetMs: 0, limit: allowedKeys.length });
      if (state.contentSearch?.token !== token) return;
      state.contentSearch = { query: q, loading: false, token, ...r };
    } catch (e) {
      if (state.contentSearch?.token !== token) return;
      state.contentSearch = { query: q, loading: false, token, results: [], error: e.message || '搜尋失敗' };
    }
    renderSidebar();
  }

  function markedText(text, marks) {
    const out = h('span', { class: 'cs-snippet' });
    let at = 0;
    for (const [i, len] of marks || []) {
      if (i < at) continue;
      if (i > at) out.append(document.createTextNode(text.slice(at, i)));
      out.append(h('mark', { text: text.slice(i, i + len) }));
      at = i + len;
    }
    out.append(document.createTextNode(text.slice(at)));
    return out;
  }

  function renderContentResults(list) {
    const cs = state.contentSearch;
    const head = h('div', { class: 'cs-head' },
      h('span', { class: 'cs-title', text: cs.loading ? `正在搜尋「${cs.query}」…` : cs.error ? `搜尋失敗：${cs.error}`
        : `「${cs.query}」：${cs.total || 0} 段對話${cs.partial ? `（先搜了最近的 ${cs.scanned}/${cs.of} 段，時間到先停）` : `（共搜尋 ${cs.scanned || 0} 段）`}` }),
      h('button', { type: 'button', class: 'btn-small', text: '返回列表', onclick: () => { state.contentSearch = null; $('#search').value = ''; state.search = ''; renderSidebar(); } }));
    list.append(head);
    if (cs.loading || cs.error) return;
    if (!cs.results.length) { list.append(h('div', { class: 'cs-empty', text: '沒有找到。可以換個關鍵字，或用引號包住整句，例如 "禁止刪除"。' })); return; }
    const terms = cs.terms || [];
    for (const r of cs.results) {
      const folder = r.cwd ? r.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
      const card = h('div', { class: 'cs-item' + (state.current?.key === r.key ? ' active' : '') },
        h('div', { class: 'cs-item-title' },
          h('span', { text: r.title || '（未命名）' }),
          h('span', { class: 'cs-meta', text: [folder, r.titleOnly ? '標題相符' : `${r.total} 則訊息`, r.archived || r.hidden ? '已封存' : '', r.subagent ? '子代理' : ''].filter(Boolean).join(' · ') })));
      card.onclick = () => openSearchHit(r.key, r.hits[0]?.index, terms);
      for (const hit of r.hits.slice(0, 3)) {
        const row = h('div', { class: 'cs-hit' }, h('span', { class: 'cs-role', text: hit.role === 'user' ? '你' : (LABELS[hit.provider] || '模型') }), markedText(hit.text, hit.marks));
        row.onclick = (e) => { e.stopPropagation(); openSearchHit(r.key, hit.index, terms); };
        card.append(row);
      }
      if (r.total > 3) card.append(h('div', { class: 'cs-more', text: `還有 ${r.total - 3} 則相符的訊息，開啟後用 Ctrl+F 逐一查看` }));
      list.append(card);
    }
  }

  async function openSearchHit(key, index, terms) {
    if (state.current?.key !== key) await openChat(key, { keepScroll: true });
    // Claude Code 原始紀錄第一次開啟時會建立 App 內的唯讀副本，key 因而改變。
    if (state.current?.key !== key && !key.startsWith('localclaude:')) return;
    const term = (terms || []).find(Boolean) || '';
    openFind(term, { index });
  }

  // ---------------- 目前對話內尋找（Ctrl+F）----------------
  // 用 CSS Custom Highlight 只標亮訊息區，不動 DOM，也不會找到輸入框裡的字
  let findOpenRevision = 0;
  const find = { ranges: [], at: -1, supported: typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' };

  function findCollect(term) {
    const box = $('#messages');
    const ranges = [];
    const needle = term.toLowerCase();
    if (!needle) return ranges;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() && !n.parentElement?.closest('button, .msg-edit-btn')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.toLowerCase();
      let i = text.indexOf(needle);
      while (i >= 0 && ranges.length < 5000) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        ranges.push(r);
        i = text.indexOf(needle, i + needle.length);
      }
    }
    return ranges;
  }

  function findPaint() {
    if (!find.supported) return;
    CSS.highlights.delete('cm-find');
    CSS.highlights.delete('cm-find-current');
    if (find.ranges.length) CSS.highlights.set('cm-find', new Highlight(...find.ranges));
    const cur = find.ranges[find.at];
    if (cur) CSS.highlights.set('cm-find-current', new Highlight(cur));
  }

  function findShow() {
    const cur = find.ranges[find.at];
    $('#findCount').textContent = $('#findInput').value ? (find.ranges.length ? `${find.at + 1} / ${find.ranges.length}` : '找不到') : '';
    findPaint();
    if (!cur) return;
    // 命中在收合的「思考過程」「工具呼叫」裡時先展開
    for (let el = cur.startContainer.parentElement; el; el = el.parentElement) if (el.tagName === 'DETAILS' && !el.open) el.open = true;
    const rect = cur.getBoundingClientRect();
    const box = $('#messages');
    const boxRect = box.getBoundingClientRect();
    if (rect.top < boxRect.top + 40 || rect.bottom > boxRect.bottom - 40) box.scrollTop += rect.top - boxRect.top - box.clientHeight / 3;
  }

  function findRun({ keepIndex = false, index } = {}) {
    const term = $('#findInput').value;
    // Flow updates can insert a fresh preview while Find is already open.
    for(const element of $('#messages').querySelectorAll('.bubble > div, .md')) {
      if(element.__expandSavedText){element.__expandSavedText();delete element.__expandSavedText;}
    }
    const prev = find.at;
    find.ranges = findCollect(term);
    if (Number.isInteger(index)) {
      // 從搜尋結果點進來：跳到那一則訊息裡的第一個命中
      const target = $('#messages').querySelector(`[data-idx="${index}"]`);
      const hit = target ? find.ranges.findIndex((r) => target.contains(r.startContainer)) : -1;
      find.at = hit >= 0 ? hit : (find.ranges.length ? 0 : -1);
      if (target) { target.classList.remove('search-flash'); void target.offsetWidth; target.classList.add('search-flash'); if (hit < 0) target.scrollIntoView({ block: 'center' }); }
    } else find.at = find.ranges.length ? (keepIndex ? Math.min(Math.max(prev, 0), find.ranges.length - 1) : 0) : -1;
    findShow();
  }

  function findStep(delta) {
    if (!find.ranges.length) return;
    find.at = (find.at + delta + find.ranges.length) % find.ranges.length;
    findShow();
  }

  async function openFind(term, { index } = {}) {
    if (!state.current) return;
    const ticket = ++findOpenRevision, chat = state.current, epoch = viewEpoch;
    const valid = () => ticket === findOpenRevision && state.current === chat && epoch === viewEpoch && !$('#findBar').hidden;
    const bar = $('#findBar'); bar.hidden = false;
    const input = $('#findInput');
    if (typeof term === 'string' && term) input.value = term;
    input.focus(); input.select();
    await chatSelectionReady;
    if (!valid()) return;
    input.focus();
    while (messageWindowStart > 0) {
      $('#findCount').textContent = '正在搜尋完整對話…';
      if (messageRenderBusy) { if (!await yieldChatView(epoch, chat)) return; }
      else await loadOlderMessages();
      if (!valid()) return;
    }
    // Explicit full-history search must include text omitted from the initial preview.
    for(const element of $('#messages').querySelectorAll('.bubble > div, .md')) {
      if(element.__expandSavedText){element.__expandSavedText();delete element.__expandSavedText;}
      if(!await yieldChatView(epoch,chat) || !valid())return;
    }
    findRun({ index });
  }
  function closeFind() {
    ++findOpenRevision;
    $('#findBar').hidden = true;
    find.ranges = []; find.at = -1;
    if (find.supported) { CSS.highlights.delete('cm-find'); CSS.highlights.delete('cm-find-current'); }
  }

  function bindSearchUi() {
    $('#messages').addEventListener('scroll', () => {
      if ($('#messages').scrollTop < 80 && $('#findBar').hidden) loadOlderMessages().catch(error => toast(error.message));
    }, { passive: true });
    $('#btnContentSearch').onclick = () => runContentSearch($('#search').value);
    $('#findInput').addEventListener('input', debounce(() => findRun(), 120));
    $('#findInput').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#findNext').onclick = () => findStep(1);
    $('#findPrev').onclick = () => findStep(-1);
    $('#findClose').onclick = closeFind;
    document.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (!e.ctrlKey || e.altKey || e.isComposing) return;
      if (!e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(window.getSelection()?.toString().trim().slice(0, 80) || undefined); }
      if (e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); const s = $('#search'); s.focus(); s.select(); if (s.value.trim()) runContentSearch(s.value); }
    });
  }


  function whoLabel(provider, model, via) {
    const subName = via === 'codex' ? 'Codex 帳號' : via === 'claudecode' ? 'Claude Code 帳號' : via === 'web' ? 'ChatGPT 網頁版' : null;
    const extra = subName ? `${model ? `${model}，` : ''}${subName}` : model;
    return h('div', { class: 'who' }, LABELS[provider] || provider || '模型', extra ? h('span', { class: 'model', text: extra }) : null);
  }

  function messageEl(m) {
    if (m.role === 'note') return h('div', { class: 'msg note', text: m.text });
    if (m.role === 'user') {
      const to = m.wangpinPlan?.config ? '送給 wangpinplan · Plan → 執行' : m.source === 'app' && m.provider ? `送給 ${LABELS[m.provider] || m.provider}` : null;
      const refs = [...(m.attachments || [])].filter(a => a.mime?.startsWith('image/'));
      const text = String(m.text || '').replace(/<image\b[^>]*path="([^"]+)"[^>]*>[\s\S]*?<\/image>/g, (tag, path) => {
        if (!refs.some(a => a.path === path)) refs.push({ path, name: '圖片' });
        return '';
      }).replace(/\n?\[圖片\s+\d+\/\d+：[^\]\n]+\]/g, '').trim();
      const userText=h('div');savedText(userText,text);
      const bubble = h('div', { class: 'bubble' }, userText);
      if (refs.length) {
        const gallery = h('div', { class: 'message-images', 'aria-label': `圖片附件，共 ${refs.length} 張` });
        refs.forEach((ref, index) => gallery.append(imageButton(ref, index + 1)));
        bubble.append(gallery);
      }
      const wrap = h('div', { class: 'msg user' }, bubble, to ? h('div', { class: 'to', text: to }) : null);
      if (m.id) wrap.append(h('button', {type:'button',class:'msg-edit-btn',text:'編輯並重新送出',onclick:()=>editMessage(m,wrap)}));
      return wrap;
    }
    if (m.role === 'assistant' && m.webRound) return webRoundElement(m);
    if (m.role === 'assistant') {
      const p = m.provider || 'codex';
      // 陪伴角色的回覆標她的名字，模型放在旁邊的小字
      const el = h('div', { class: 'msg assistant', dataset: { p } }, m.companion ? h('div', { class: 'who' }, m.companion.name, h('span', { class: 'model', text: `${LABELS[p] || p}${m.model ? `・${m.model}` : ''}` })) : whoLabel(p, m.servedModel || m.model, m.via));
      if(m.wangpinPlan?.stage)el.querySelector('.who').replaceChildren(document.createTextNode(`wangpinplan · ${m.wangpinPlan.stage==='plan'?'Plan':'執行'}`),h('span',{class:'model',text:`${m.wangpinPlan.target} / ${m.servedModel || m.model || '預設模型'}`}));
      if (m.reasoning) { const fold = foldEl(m.wangpinPlan?'工作進度':'思考過程', m.reasoning); if (m.partial) fold.open = true; el.append(fold); }
      if (m.tools && m.tools.length) {
        const body = h('div', { class: 'fold-body' });
        for (const t of m.tools) {
          const line=h('div',{class:'tool-line'});
          if(m.wangpinPlan)appendPlanTool(line,t);else appendOrdinaryTool(line,t);
          body.append(line);
        }
        el.append(h('details', { class: 'fold' }, h('summary', { text: `工具呼叫 ${m.tools.length} 次` }), body));
      }
      if (m.text) {
        const md = h('div', { class: 'md' }); savedText(md, m.text,{markdown:true});
        if (m.phase === 'commentary' || m.phase === 'analysis') el.append(h('details', { class: 'fold progress-fold' }, h('summary', { text: '推理／工作進度（點擊展開）' }), md));
        else el.append(md);
      }
      if (m.partial) {
        const why = String(m.partialReason || '').trim();
        const failed = why && !/^已(暫停|停止)$/.test(why);
        el.append(h('div', { class: failed ? 'partial failed' : 'partial', text: why ? `（回覆未完成：${why}）` : '（回覆未完成）' }));
      }
      if (!m.text && !(m.tools && m.tools.length) && !m.reasoning) return null;
      return el;
    }
    return null;
  }

  function foldEl(title, text) {
    return h('details', { class: 'fold reasoning' }, h('summary', { text: title }), h('div', { class: 'fold-body', text }));
  }

  function editMessage(message, wrap) {
    if (currentRun()) { toast('請先暫停，再編輯訊息'); return; }
    if (wrap.querySelector('textarea')) return;
    const key=state.current.key; const provider=state.provider;
    const input=h('textarea',{class:'msg-edit-area'}); input.value=message.text || '';
    const panel=h('div',{class:'msg-edit-panel'});
    const submit=h('button',{type:'button',class:'btn-small primary',text:'儲存並送出',onclick:async()=>{
      if (!input.value.trim()) return;
      submit.disabled=true;
      try {
        if (state.current?.key !== key) throw new Error('已切換對話，請回到原對話編輯');
        const r=await api.editBranch({key,messageId:message.id,text:input.value});
        if (state.current?.key !== key) { toast('編輯分支已儲存，請從側欄開啟'); await refreshSidebar(); return; }
        await openChat(r.key);
        pendingAttachments=r.items || []; renderAttachments(); $('#input').value=r.text;
        const ok=await startRun(r.text,provider,{attachmentIds:pendingAttachments.map(a=>a.id)});
        if(ok) {$('#input').value='';pendingAttachments=[];renderAttachments();}
        await refreshSidebar();
      } catch(e) {toast(e.message,6000);} finally {submit.disabled=false;}
    }});
    panel.append(input,h('div',{class:'msg-edit-bar'},h('span',{text:'從這裡建立新分支，原對話保留。'}),submit,h('button',{type:'button',class:'btn-small',text:'取消',onclick:()=>panel.remove()})));
    input.addEventListener('keydown',e=>{if(inputComposition.isComposing(e))return;if(e.key==='Escape'){e.stopPropagation();panel.remove();} if(e.key==='Enter'&&e.ctrlKey){e.preventDefault();submit.click();}});
    wrap.append(panel); input.focus();
  }

  // 陪伴角色：自由編輯人物設定與提示詞（記憶、關係不受影響）
  // mode：full＝整份 TXT（人物、Prompt、她記得的事全部在一個文字框）；fields＝分欄編輯
  async function openCompanionEditor(onSaved, { mode = 'full', note = '' } = {}) {
    let data;
    try { data = await api.companionGetProfile(); } catch (e) { toast(e.message || '讀不到角色設定', 6000); return; }
    let curMode = mode;
    const dlg = h('dialog', { class: 'comp-edit', 'aria-label': '編輯陪伴角色' });
    const body = h('div', { class: 'comp-body' });
    const fields = {};
    const area = (key, label, hint, rows = 3, value = data[key]) => {
      const t = h('textarea', { rows: String(rows), spellcheck: 'false', 'aria-label': label });
      t.value = value || '';
      fields[key] = t;
      return h('label', { class: 'comp-field' }, h('span', { class: 'comp-label', text: label }), hint ? h('span', { class: 'comp-hint', text: hint }) : null, t);
    };
    const nameIn = h('input', { type: 'text', maxlength: '20', value: data.name || '', 'aria-label': '名字' });
    const ageIn = h('input', { type: 'text', maxlength: '20', value: data.age || '', 'aria-label': '年齡' });
    body.append(
      h('h4', { text: '人物' }),
      h('div', { class: 'comp-row' }, h('label', { class: 'comp-field' }, h('span', { class: 'comp-label', text: '名字' }), nameIn), h('label', { class: 'comp-field' }, h('span', { class: 'comp-label', text: '年齡' }), ageIn)),
      area('identity', '身分、生活與人際關係', '每行一件事', 6),
      area('facets', '個性面向', '', 2),
      area('cognitiveStyle', '想事情的方式', '', 2),
      area('speech', '講話方式', '', 3),
      area('values', '在乎的事', '每行一項', 3),
      area('likes', '喜歡', '每行一項', 3),
      area('dislikes', '討厭', '每行一項', 3),
      area('habits', '習慣', '每行一項', 3),
      area('boundaries', '界線', '每行一項', 3),
      area('lifeEpisodes', '刻在心裡的事', '每行一件，開頭 [1–10] 是重要程度，例如「[9] 十六歲時……」', 3));
    // 性格數值
    const TRAITS = [['openness', '開放性（好奇、愛嘗鮮）'], ['conscientiousness', '盡責性（有條理）'], ['extraversion', '外向性'], ['agreeableness', '親和性（好相處、順著人）'], ['neuroticism', '情緒起伏（容易急躁上火）']];
    const traitIns = {};
    const traitBox = h('div', { class: 'comp-traits' });
    for (const [k, label] of TRAITS) {
      const out = h('span', { class: 'comp-hint', text: Number(data.traits[k]).toFixed(2) });
      const r = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(data.traits[k]), 'aria-label': label });
      r.oninput = () => { out.textContent = Number(r.value).toFixed(2); };
      traitIns[k] = r;
      traitBox.append(h('label', { class: 'comp-trait' }, h('span', { text: label }), r, out));
    }
    body.append(h('h4', { text: '性格數值（Big Five，0–1）' }), h('p', { class: 'comp-hint', text: '這是出廠性格；她會隨相處在這個值上下 0.12 內慢慢變。' }), traitBox);
    // 作息
    const schedWrap = area('schedule', '作息', '留空＝用內建作息。自訂格式每行：「哪幾天 開始-結束 在做什麼 | 狀態」，天數可寫 每天／平日／週末／週一～週五／週三,週五；狀態：睡、想睡、忙、外出、有空。', 5);
    fields.schedule.placeholder = data.defaults.scheduleExample;
    const schedWarn = h('span', { class: 'comp-hint warn', text: data.scheduleOk ? '' : '目前的自訂作息沒有任何一行符合格式，會被當成「在做自己的事」。' });
    schedWrap.append(h('div', { class: 'comp-row' }, h('button', { type: 'button', class: 'btn-small', text: '填入範例', onclick: () => { fields.schedule.value = data.defaults.scheduleExample; } }), schedWarn));
    body.append(h('h4', { text: '生活作息（決定她「現在在幹嘛」）' }), schedWrap);
    // 提示詞
    const PROMPTS = [['intro', '開場定位', '模型最先讀到的「她是誰」。{name} 會換成名字。'], ['principles', '做人原則', '每行一條，會列成「【你這個人】」。'], ['mind', '心聲規則（角色內推理）', '要求模型先以她的身分想，再決定怎麼回。'], ['reply', '回覆規則', '真正傳給你的訊息要長怎樣。'], ['extra', '額外指示', '想加什麼都寫在這裡（預設空白）。']];
    const promptBox = h('div');
    for (const [k, label, hint] of PROMPTS) {
      const wrapEl = area(`p_${k}`, label, hint, k === 'extra' ? 3 : 5, data.prompt[k]);
      const restore = h('button', { type: 'button', class: 'btn-small', text: '還原這段', onclick: () => { fields[`p_${k}`].value = data.defaults.prompt[k] || ''; } });
      wrapEl.append(h('div', { class: 'comp-row' }, restore, data.promptCustom.includes(k) ? h('span', { class: 'comp-hint', text: '（目前是自訂的）' }) : null));
      promptBox.append(wrapEl);
    }
    body.append(h('h4', { text: 'Prompt' }), h('p', { class: 'comp-hint', text: '回覆的輸出格式（<mind>、<reply>、<update>）和記憶更新的 JSON 格式是程式要解析的，固定不能改；其他都可以改。' }), promptBox);
    // 情境反應
    const sc = h('details', { class: 'comp-sc' }, h('summary', { text: '情境反應（偵測到特定情況時額外提醒她的話）' }));
    for (const s of data.scenarios) {
      const wrapEl = area(`s_${s.id}`, s.label, s.custom ? '（目前是自訂的）' : '', 3, s.guide);
      wrapEl.append(h('div', { class: 'comp-row' }, h('button', { type: 'button', class: 'btn-small', text: '還原這段', onclick: () => { fields[`s_${s.id}`].value = s.default; } })));
      sc.append(wrapEl);
    }
    body.append(sc);
    // 預覽
    const sample = h('input', { type: 'text', placeholder: '想測試的訊息（例如：你好厲害喔）', 'aria-label': '預覽用訊息' });
    const pre = h('pre', { class: 'comp-preview', hidden: true });
    body.append(h('h4', { text: '預覽' }), h('p', { class: 'comp-hint', text: '顯示這一刻真正會送給模型的完整 prompt（包含她的記憶與你們的關係）。先按儲存，預覽才會套用剛改的內容。' }),
      h('div', { class: 'comp-row' }, sample, h('button', { type: 'button', class: 'btn-small', text: '預覽完整 prompt', onclick: async () => { try { pre.textContent = await api.companionPreview(sample.value); pre.hidden = false; } catch (e) { toast(e.message, 6000); } } })), pre);

    const status = h('span', { class: 'comp-hint' });
    const collect = () => ({
      name: nameIn.value.trim(), age: ageIn.value.trim(),
      ...Object.fromEntries(['identity', 'facets', 'cognitiveStyle', 'speech', 'values', 'likes', 'dislikes', 'habits', 'boundaries', 'lifeEpisodes', 'schedule'].map((k) => [k, fields[k].value])),
      traits: Object.fromEntries(Object.entries(traitIns).map(([k, r]) => [k, Number(r.value)])),
      prompt: Object.fromEntries(PROMPTS.map(([k]) => [k, fields[`p_${k}`].value])),
      scenarios: Object.fromEntries(data.scenarios.map((s) => [s.id, fields[`s_${s.id}`].value])),
    });
    const save = h('button', { type: 'button', class: 'btn-small primary', text: '儲存', onclick: async () => {
      if (curMode === 'full') {
        save.disabled = true;
        try {
          const r = await api.companionSaveFullText(full.value);
          state.settings = await api.getSettings();
          onSaved?.();
          const res = r.result || {};
          const parts = [`已儲存 ${res.found || 0} 個欄位`, res.memory && res.memory.length ? `她記得的事有改：${res.memory.join('、')}` : '她記得的事沒有變動'];
          dlg.close();
          openCompanionEditor(onSaved, { mode: 'full', note: `${parts.join('；')}。下一則訊息開始生效。${(res.warnings || []).length ? `\n${res.warnings.join('；')}` : ''}` });
        } catch (e) { status.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); save.disabled = false; }
        return;
      }
      if (!nameIn.value.trim()) { status.textContent = '名字不能空白'; return; }
      save.disabled = true;
      try {
        data = await api.companionSaveProfile(collect());
        state.settings = await api.getSettings();
        status.textContent = `已儲存到 ${data.personaFile.split(/[\\/]/).pop()}。${data.scheduleOk ? '' : '（作息沒有任何一行符合格式）'}下一則訊息開始生效；她的記憶與你們的關係沒有變動。`;
        onSaved?.();
      } catch (e) { status.textContent = e.message; } finally { save.disabled = false; }
    } });
    // TXT：存檔用目前編輯器上的內容（含還沒儲存的修改）；載入只填進編輯器，按儲存才生效
    const exportText = h('button', { type: 'button', class: 'btn-small', text: '另存 TXT…', title: '把編輯器上的內容另存一份文字檔到別的地方', onclick: async () => {
      try { const r = curMode === 'full' ? await api.companionExportText({ name: data.name }, full.value) : await api.companionExportText(collect()); if (r && r.ok) status.textContent = `已存成 ${r.file}（含她記得的事）`; } catch (e) { status.textContent = e.message; }
    } });
    const importText = h('button', { type: 'button', class: 'btn-small', text: '從 TXT 載入…', title: '選擇角色文字檔（舊版另存的 HTML 表格也可以），把內容填進編輯器', onclick: async () => {
      let r;
      try { r = await api.companionImportText(); } catch (e) { status.textContent = e.message; return; }
      if (!r || r.cancelled) return;
      // TXT：整份放進全文編輯框，按儲存才生效（她記得的事只套用和目前不同的行）
      if (r.format === 'txt' && typeof r.text === 'string') {
        full.value = r.text;
        full.classList.add('comp-imported');
        setMode('full');
        const hasMem = r.patch && r.patch.memory;
        status.textContent = r.found && r.found.length
          ? `已從 ${r.file.split(/[\\/]/).pop()} 載入 ${r.found.length} 個欄位${hasMem ? '（含她記得的事）' : '（沒有她記得的事，記憶不會變動）'}。先看過，按「儲存」才會生效。${(r.warnings || []).length ? `\n${r.warnings.join('；')}` : ''}`
          : `這個檔案裡找不到角色欄位（每個欄位要以一行「【名字】」這樣的標題開頭）。${(r.warnings || []).join('；')}`;
        return;
      }
      setMode('fields');
      const p = r.patch || {};
      const changed = [];
      const put = (el, v) => { if (!el || v === undefined) return; if (el.value !== String(v)) { el.value = String(v); el.classList.add('comp-imported'); changed.push(el); } };
      put(nameIn, p.name); put(ageIn, p.age);
      for (const k of ['identity', 'facets', 'cognitiveStyle', 'speech', 'values', 'likes', 'dislikes', 'habits', 'boundaries', 'lifeEpisodes', 'schedule']) put(fields[k], p[k]);
      for (const [k, v] of Object.entries(p.prompt || {})) put(fields[`p_${k}`], v);
      for (const [k, v] of Object.entries(p.scenarios || {})) put(fields[`s_${k}`], v);
      for (const [k, v] of Object.entries(p.traits || {})) { const el = traitIns[k]; if (el && Number(el.value) !== v) { el.value = String(v); el.dispatchEvent(new Event('input')); el.classList.add('comp-imported'); changed.push(el); } }
      if (changed.some((el) => el.closest('.comp-sc'))) sc.open = true;
      const notes = [...(r.format === 'html' && (r.unknown || []).length ? [`對不上的列：${r.unknown.join('、')}`] : []), ...(r.warnings || [])];
      status.textContent = r.found && r.found.length
        ? `已從 ${r.file.split(/[\\/]/).pop()} 載入 ${r.found.length} 個欄位，其中 ${changed.length} 個和目前不同（已標色）。按「儲存」才會生效。${notes.length ? `\n${notes.join('；')}` : ''}`
        : `這個檔案裡找不到角色欄位（每個欄位要以一行「【名字】」這樣的標題開頭）。${notes.join('；')}`;
      changed[0]?.scrollIntoView({ block: 'center' });
    } });
    const resetAll = h('button', { type: 'button', class: 'btn-small danger', text: '全部還原預設', onclick: async () => {
      const r = await api.companionResetProfile();
      if (r && !r.cancelled) { dlg.close(); toast('人物設定與 Prompt 已還原預設（記憶保留）'); onSaved?.(); }
    } });
    // 角色本身就存成 .txt：用記事本改【欄位】底下的內容，存檔後下一則訊息生效
    const fileBar = h('div', { class: 'comp-file' },
      h('span', { class: 'comp-hint', text: '角色檔（TXT）：' }),
      h('code', { class: 'comp-path', text: data.personaFile || '', title: data.personaFile || '' }),
      h('button', { type: 'button', class: 'btn-small', text: '開啟 TXT', title: '用記事本（系統預設的程式）打開角色檔，改【欄位】底下的內容後存檔就會生效', onclick: async () => { try { await api.companionOpenFile(false); status.textContent = '已開啟角色檔。改好存檔後，她的下一則回覆就會套用；也可以按「重新讀取」在這裡看到結果。'; } catch (e) { status.textContent = e.message; } } }),
      h('button', { type: 'button', class: 'btn-small', text: '在資料夾中顯示', onclick: () => api.companionOpenFile(true).catch((e) => { status.textContent = e.message; }) }),
      h('button', { type: 'button', class: 'btn-small', text: '重新讀取', title: '重新讀取角色檔（編輯器上還沒儲存的修改會被取代）', onclick: () => { dlg.close(); openCompanionEditor(onSaved, { mode: curMode }); } }));
    const sync = data.personaSync;
    if (sync && Date.now() - Date.parse(sync.at) < 10 * 60 * 1000) {
      const notes = sync.warnings || [];
      fileBar.append(h('span', { class: `comp-hint${sync.applied ? '' : ' warn'}`, text: sync.applied ? `已套用角色檔裡的 ${sync.found} 個欄位。${notes.join('；')}` : `角色檔裡找不到任何【欄位】，沒有套用。${notes.join('；')}` }));
    }
    // 整份 TXT：人物、Prompt、她記得的事全部在一個文字框裡，和 persona.txt 內容一樣
    const full = h('textarea', { class: 'comp-full', spellcheck: 'false', 'aria-label': '整份角色檔' });
    const fullPanel = h('div', { class: 'comp-body comp-full-panel' },
      h('p', { class: 'comp-hint', text: '這裡就是整份角色檔：人物設定、所有 Prompt、她記得的事（核心筆記、長期記憶、目前成立的事、還在意的事、關係數值、印象）都在同一份文字裡。改好按「儲存」。她記得的事只套用你改動的那幾行：刪掉一行＝讓她忘掉（標成已遺忘，不會真的刪），新增一行＝讓她記住。' }),
      full);
    let fullLoaded = false;
    const loadFull = async () => {
      if (fullLoaded) return;
      fullLoaded = true;
      try { const r = await api.companionGetFullText(); if (!full.value) full.value = r.text.replace(/^\uFEFF/, ''); } catch (e) { status.textContent = e.message; }
    };
    const tabFull = h('button', { type: 'button', class: 'comp-tab', role: 'tab', text: '整份 TXT（全部內容）', onclick: () => setMode('full') });
    const tabFields = h('button', { type: 'button', class: 'comp-tab', role: 'tab', text: '分欄編輯', onclick: () => setMode('fields') });
    function setMode(m) {
      if (m === 'fields' && curMode === 'full' && fullLoaded && full.classList.contains('comp-imported')) status.textContent = '全文框裡載入的內容還沒儲存；切回「整份 TXT」按儲存才會套用。';
      curMode = m;
      fullPanel.hidden = m !== 'full'; body.hidden = m === 'full';
      tabFull.classList.toggle('active', m === 'full'); tabFields.classList.toggle('active', m !== 'full');
      tabFull.setAttribute('aria-selected', String(m === 'full')); tabFields.setAttribute('aria-selected', String(m !== 'full'));
      if (m === 'full') loadFull();
    }
    const fileWrap = h('div', { class: 'comp-filewrap' }, fileBar, h('div', { class: 'comp-tabs', role: 'tablist' }, tabFull, tabFields));
    dlg.append(
      h('div', { class: 'comp-head' }, h('h3', { text: '編輯陪伴角色' }), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'icon-btn', text: '✕', title: '關閉', onclick: () => dlg.close() })),
      fileWrap, fullPanel,
      body,
      h('div', { class: 'comp-foot' }, status, h('span', { class: 'spacer' }), importText, exportText, resetAll, h('button', { type: 'button', class: 'btn-small', text: '關閉', onclick: () => dlg.close() }), save));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
    setMode(curMode);
    if (note) status.textContent = note;
    (curMode === 'full' ? full : nameIn).focus();
  }

  async function resolveImageUrl(ref) {
    const r = ref.url && /^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/.test(ref.url) ? { url: ref.url }
      : ref.data && /^image\/(png|jpeg|gif|webp)$/.test(ref.mime) ? { url: `data:${ref.mime};base64,${ref.data}` }
        : await api.previewImage({ id: ref.id, path: ref.path });
    if (!r?.url || !/^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/.test(r.url)) throw new Error('找不到圖片內容');
    return r.url;
  }
  async function openClaudeAccountMenu(anchor = $('#keyBtn')) {
    if (openPop && openPop.anchor === anchor) { closeMenu(); return; }
    try {
      const data = await api.claudeAccounts();
      state.claudeAccounts = data;
      const items = data.accounts.map(a => ({ label: a.label, desc: [a.email, planName(a.plan), a.loginStatus === 'loggedOut' ? '尚未登入' : a.loginStatus === 'unknown' ? (a.message || '登入狀態暫時讀不到') : '已登入'].filter(Boolean).join(' · '), checked: a.active, onSelect: async () => {
        if (a.active) return;
        try {
          const r = await api.switchClaudeAccount(a.id);
          applySettings(await api.getSettings());
          state.claudeAccounts = null; state.claudeModels = null; state.usage = null;
          renderComposerBar();
          refreshUsage();
          toast(`已切換到「${r.label}」；執行中的回合繼續使用原帳號`, 5000);
        } catch (e) { toast(e.message, 6000); }
      } }));
      const current = data.accounts.find(a => a.active);
      openMenu(anchor, { title: 'Claude Code 帳號', items, footer: [
        ...(current ? [{ label: '重新登入／更新目前 Claude 帳號…', onSelect: () => loginClaudeAccount(current.id) }] : []),
        { label: '登入其他 Claude 帳號…', onSelect: () => loginClaudeAccount() },
        { label: '管理帳號（改名／移除）…', onSelect: () => manageClaudeAccounts(data, anchor) },
        { label: '重新讀取帳號狀態', onSelect: async () => { await api.claudeAccounts({ refresh: true }); await openClaudeAccountMenu(anchor); } },
        { label: '沿用 Claude 桌面版登入／檢查連線…', onSelect: () => openSettings() },
        { label: '改用 API 金鑰／管理金鑰…', onSelect: () => openKeyMenu(true) },
      ] });
      renderComposerBar();
    } catch (e) { toast(e.message, 6000); }
  }
  function manageClaudeAccounts(data, anchor) {
    openMenu(anchor, { title: '選擇要管理的 Claude 帳號', items: data.accounts.map(a => ({
      label: a.label, desc: a.email || a.configDir, checked: a.active, onSelect: () => openMenu(anchor, {
        title: `Claude 帳號：${a.label}`,
        inputPlaceholder: '輸入自訂名稱後按 Enter，例如：公司帳號',
        onInput: async name => {
          try { await api.renameClaudeAccount({ id: a.id, name }); applySettings(await api.getSettings()); state.claudeAccounts = null; renderComposerBar(); toast('已改名'); }
          catch (e) { toast(e.message, 6000); }
        },
        items: [
          { label: '重新登入這個 Claude 帳號…', onSelect: () => loginClaudeAccount(a.id) },
          { label: '恢復顯示 email', onSelect: async () => { await api.renameClaudeAccount({ id: a.id, name: '' }); applySettings(await api.getSettings()); state.claudeAccounts = null; renderComposerBar(); } },
          { label: '從這個 App 移除', desc: a.active ? '請先切換到另一個帳號；執行中帳號也不能移除' : '只移除 App 清單；不刪除登入資料或對話', danger: true, onSelect: async () => {
            try { const r = await api.removeClaudeAccount(a.id); toast(r.message || '已移除帳號', 5000); applySettings(await api.getSettings()); state.claudeAccounts = null; renderComposerBar(); }
            catch (e) { toast(e.message, 6000); }
          } },
        ],
      }),
    })) });
  }
  async function loginClaudeAccount(id) {
    if (document.querySelector('#claudeAccountLoginDlg')) return;
    let url = '';
    const status = h('p', { text: '正在啟動 Claude 官方登入…', id: 'claudeAccountLoginStatus' });
    const open = h('button', { class: 'btn-small', text: '開啟登入頁', hidden: true, onclick: () => { if (url) api.openExternal(url); } });
    const copy = h('button', { class: 'btn-small', text: '複製登入網址', hidden: true, onclick: () => { if (url) api.copyText(url); } });
    const code = h('input', { placeholder: '若網頁提供授權碼，貼在這裡', type: 'text' });
    const submit = h('button', { class: 'btn-small', text: '送出授權碼', onclick: async () => { const value = code.value; code.value = ''; const r = await api.submitClaudeCode(value); status.textContent = r.message; } });
    const cancel = h('button', { class: 'btn-small', text: '取消', id: 'claudeAccountLoginCancel', onclick: () => api.cancelClaudeLogin() });
    const dlg = h('dialog', { class: 'settings-dialog', id: 'claudeAccountLoginDlg' },
      h('h3', { text: id ? '重新登入 Claude 帳號' : '登入其他 Claude 帳號' }), status,
      h('p', { text: '完成登入後才更新帳號。執行中的回合會繼續使用原本的登入資料。' }),
      h('div', { class: 'row' }, open, copy), h('div', { class: 'row' }, code, submit), cancel);
    const off = api.onClaudeAuthURL(value => { url = value; open.hidden = false; copy.hidden = false; status.textContent = '請在瀏覽器完成登入；登入另一個帳號可複製網址到無痕視窗。'; });
    dlg.oncancel = e => { e.preventDefault(); api.cancelClaudeLogin(); };
    document.body.append(dlg); dlg.showModal();
    try {
      const result = await api.loginClaudeAccount({ id: id || null, switchAfter: true });
      toast(result.message || (result.ok ? 'Claude 登入完成' : '登入未完成'), 7000);
      if (result.ok) {
        applySettings(await api.getSettings()); state.claudeAccounts = null; state.claudeModels = null; state.usage = null;
        $('#sClaudeConfig').value = state.settings.providers.claude.configDir || '';
        renderComposerBar(); refreshUsage();
      }
    } catch (e) { toast(e.message, 7000); }
    finally { off(); dlg.close(); dlg.remove(); }
  }
  async function previewImage(ref) {
    try {
      const img = h('img', { src: await resolveImageUrl(ref), alt: ref.name || '圖片', class: 'preview-image' });
      const dlg = h('dialog', { class: 'image-preview', 'aria-label': '圖片預覽' });
      const close = h('button', { type: 'button', class: 'btn-small', text: '關閉', onclick: () => dlg.close() });
      const zoom = h('button', { type: 'button', class: 'btn-small', text: '原始大小／符合視窗', onclick: () => img.classList.toggle('actual-size') });
      dlg.append(h('div', { class: 'preview-toolbar' }, h('span', { text: ref.name || '圖片' }), zoom, close), h('div', { class: 'preview-canvas' }, img));
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg); dlg.showModal(); close.focus();
    } catch (e) { toast(e.message || '無法預覽圖片', 6000); }
  }
  function imageButton(ref, order = null) {
    const frame = h('span', { class: 'image-thumb-frame' }, h('span', { class: 'image-thumb-loading', text: '載入中…' }));
    const button = h('button', { type: 'button', class: 'image-open', title: `預覽 ${ref.name || '圖片'}`, onclick: () => previewImage(ref) },
      frame,
      h('span', { class: 'image-file-name', text: ref.name || '圖片' }),
      order == null ? null : h('span', { class: 'image-order', text: String(order), title: `第 ${order} 張圖片` }));
    resolveImageUrl(ref).then((url) => {
      if (!button.isConnected) return;
      frame.replaceChildren(h('img', { src: url, alt: ref.name || `圖片 ${order || ''}`, loading: 'lazy' }));
    }).catch(() => {
      if (button.isConnected) frame.replaceChildren(h('span', { class: 'image-thumb-loading err', text: '無法預覽' }));
    });
    return button;
  }

  async function renderWelcome() {
    const box = $('#messages');
    const s = state.settings;
    const wrap = h('div', { class: 'welcome' },
      h('h1', { text: '接著任何一段對話，換任何一個模型' }),
      h('p', { text: '左側保留 Codex App 的專案與執行緒。點開其中一則繼續聊，或直接在下方輸入開始新對話；下方可以隨時切換 Codex、GPT、Claude、DeepSeek、Gemini。' }));
    const checks = h('div', { class: 'checks' });
    const codexState = h('span', { class: 'state', text: '檢查中…' });
    const codexRow = h('div', { class: 'check' }, h('span', { class: 'bar', style: 'background:var(--p-codex)' }), 'Codex', codexState);
    checks.append(codexRow);
    for (const p of API_ORDER) {
      const cfg = s && s.providers[p];
      const keys = (cfg && cfg.keys) || [];
      const active = keys.find((k) => k.id === cfg.activeKeyId);
      const viaCodex = viaSub(p, s);
      const text = viaCodex ? `使用 ${activeSub(p, s).name}` : active ? (keys.length > 1 ? `使用「${active.name}」，共 ${keys.length} 把金鑰` : `使用「${active.name}」`) : '還沒有金鑰';
      const stateEl = h('span', { class: `state ${active || viaCodex ? 'ok' : 'miss'}`, text });
      if (p === 'claude' && viaCodex) {
        api.detectClaude().then((r) => {
          if (r.ok) stateEl.textContent = `使用 Claude Code 帳號（${String(r.message || '').replace(/\s*\(Claude Code\)/, '')}）`;
          else { stateEl.textContent = '找不到 Claude Code，請先安裝並登入'; stateEl.className = 'state miss'; }
        });
      }
      checks.append(h('div', { class: 'check' }, h('span', { class: 'bar', style: `background:var(--p-${p})` }), LABELS[p],
        stateEl,
        active || viaCodex ? null : h('button', { class: 'btn-small', type: 'button', text: '新增金鑰', onclick: () => openKeyEditor(p) })));
    }
    wrap.append(checks);
    box.append(wrap);
    const info = state.codexInfo || await detectCodexQuiet();
    codexState.textContent = info.ok ? '可以使用（沿用 Codex App 的登入）' : '找不到 Codex CLI';
    codexState.className = `state ${info.ok ? 'ok' : 'miss'}`;
    if (!info.ok) {
      const btn = h('button', { class: 'btn-small', type: 'button', text: '安裝', title: '自動安裝 Codex CLI（需要 Node.js）' });
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '安裝中…';
        const r = await api.installCodex();
        state.codexInfo = null;
        const again = await detectCodexQuiet();
        toast(again.ok ? 'Codex CLI 安裝完成' : r.message, 6000);
        if (!state.current) renderMessages();
      };
      codexRow.append(btn);
    }
  }

  let detecting = null;
  function detectCodexQuiet() {
    if (!detecting) detecting = runDetect().finally(() => { detecting = null; });
    return detecting;
  }
  async function runDetect() {
    try { state.codexInfo = await api.detectCodex(); } catch (e) { state.codexInfo = { ok: false, message: String(e.message || e) }; }
    const el = $('#codexStatus');
    const ver = state.settings && state.settings.appVersion ? `v${state.settings.appVersion}，` : '';
    el.textContent = `${ver}${state.codexInfo.ok ? `Codex CLI ${String(state.codexInfo.message || '').replace(/^codex-cli\s*/, '')}` : 'Codex CLI 未找到'}`;
    el.className = `status-line${state.codexInfo.ok ? '' : ' bad'}`;
    el.title = state.codexInfo.path || '';
    return state.codexInfo;
  }

  // ---------------- 模型切換與輸入區選單 ----------------
  const EFFORT_LABEL = { none: '不推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '極限' };
  let pendingAttachments = [];
  let pendingPastes = 0;
  let draftRevision = 0;
  let draftEditRevision = 0;
  const CLAUDE_PERMS = [
    { value: 'default', label: '預設權限', desc: '沿用 Claude 權限規則，需要許可時顯示詢問' },
    { value: 'chat', label: '僅聊天', desc: '停用工具，可分析已加入的附件' },
    { value: 'plan', label: '規劃模式', desc: '使用 Claude Code plan 模式分析與規劃' },
    { value: 'acceptEdits', label: '自動接受編輯', desc: '允許 Claude Code 自動編輯；其他操作依權限詢問' },
    { value: 'auto', label: '自動審核（Auto）', desc: 'Claude Code 自動判斷操作是否安全；有風險才問你' },
    { value: 'bypassPermissions', label: '完全存取', desc: 'Claude Code 略過工具權限詢問' },
  ];
  const API_PERMS = [
    { value: 'chat', label: '僅聊天', desc: '不讀寫本機檔案、不執行指令；下方勾選的瀏覽器仍可操作' },
    { value: 'read-only', label: '唯讀', desc: '專案檔案唯讀；可操作網頁' },
    { value: 'workspace-write', label: '工作區寫入', desc: '讀寫專案內的檔案；執行程式前會先問你，也能操作瀏覽器' },
    { value: 'danger-full-access', label: '完全存取', desc: '可執行任何指令、操作整台電腦，請小心使用' },
  ];
  const APPROVALS = [
    { value: 'on-request', label: '需要時詢問', desc: '要執行指令前先跳出來問你（建議）' },
    { value: 'never', label: '不詢問', desc: '一律不執行指令，其他工具照常使用' },
  ];
  const ANTIGRAVITY_PERMS = [
    { value: 'default', label: '預設權限', desc: '可讀專案；寫入檔案或執行指令前顯示同意卡' },
    { value: 'codex-review', label: '自動審核（由 Codex 判斷）', desc: '會消耗 Codex 一般額度；逐次審核寫檔／指令，結果不明改手動確認，刪檔仍需授權' },
    { value: 'chat', label: '僅聊天', desc: '不讀寫專案、不執行指令；已啟用的瀏覽器仍可操作' },
    { value: 'plan', label: '規劃模式', desc: '唯讀分析專案；不能寫入檔案或執行指令' },
    { value: 'acceptEdits', label: '自動接受編輯', desc: '自動讀寫專案；執行指令前顯示同意卡' },
    { value: 'bypassPermissions', label: '完全存取', desc: '可執行指令，略過一般同意卡；仍遵守下方刪除保護' },
  ];
  const GROKBUILD_PERMS = [
    { value: 'ask', label: '逐次同意', desc: '可讀檔與搜尋；寫入檔案或執行指令前顯示同意卡' },
    { value: 'read-only', label: '唯讀', desc: '只能讀檔與搜尋；寫入與指令一律拒絕' },
    { value: 'full', label: '完全存取', desc: '自動允許寫檔與指令；刪除仍遵守刪除保護設定' },
  ];
  function permissionOptions(p) { return p === 'grokbuild' ? GROKBUILD_PERMS : p === 'antigravity' ? ANTIGRAVITY_PERMS : p === 'claude' && viaSub('claude') ? CLAUDE_PERMS : p === 'codex' ? PERMS : API_PERMS; }
  function permissionField(p) { return p==='codex' ? 'sandbox' : p==='claude'&&!viaSub(p) ? 'apiPermission' : 'permission'; }
  function renderAttachments() {
    const box = $('#attachmentList'); box.replaceChildren();
    let imageOrder = 0;
    for (const a of pendingAttachments) {
      const chip = h('span', { class: 'attachment-chip' });
      if (a.mime?.startsWith('image/')) chip.append(imageButton(a, ++imageOrder));
      else chip.append(h('span', { text: a.name }));
      chip.append(h('button', { type: 'button', class: 'attachment-remove', text: '×', title: `移除 ${a.name}`, onclick: () => { pendingAttachments = pendingAttachments.filter(x => x.id !== a.id); renderAttachments(); } }));
      box.append(chip);
    }
  }
  const PERMS = [
    { value: 'read-only', label: '唯讀', desc: 'Codex 只能讀取檔案，不會修改任何東西' },
    { value: 'workspace-write', label: '預設權限', desc: '可修改專案內的檔案、執行指令；需要額外權限的操作會直接失敗' },
    { value: 'auto-review', label: '自動審核（Auto-review）', desc: '同預設權限；需要額外權限時由 Codex 自動審核放行或拒絕' },
    { value: 'danger-full-access', label: '完全存取', desc: '可以修改電腦上任何檔案、執行任何指令，請小心使用' },
  ];

  function setProvider(p, { save = true } = {}) {
    if (REMOVED_PROVIDERS.has(p)) { toast('Gemini 與 Grok 已從工作台選項移除'); p = 'codex'; }
    const plan=save?activeWangpinPlan():null;
    const ordinaryPlan=plan?.enabled?{...plan,enabled:false}:null;
    if(ordinaryPlan&&state.current)state.current.modelPick={...(state.current.modelPick || {}),wangpinPlan:ordinaryPlan};
    if(ordinaryPlan&&!state.current)state.settings={...state.settings,wangpinPlan:ordinaryPlan};
    if (p === 'grokbot') p = 'grokbuild';  // Grok Bot 按鈕已改成 Grok Build
    state.provider = p;
    $('#app').dataset.provider = p;
    document.querySelectorAll('#providerSwitch button[data-p]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.p === p)));
    $('#input').placeholder = `傳訊息給 ${LABELS[p]}…`;
    if (p === 'antigravity' && !state.antigravity) loadAntigravity();
    if (p === 'grokbuild' && !state.grokBuild) loadGrokBuild();
    renderComposerBar();
    if (save) { api.saveSettings({ lastProvider: p,...(ordinaryPlan?{wangpinPlan:ordinaryPlan}:{}) }).then((ns) => { state.settings = ns; renderComposerBar(); }); rememberPick(p); }
  }

  const WEB_DEFAULT_PROMPT = '請以繁體中文整合各模型的答案，核對共識與矛盾，保留有用細節，標示無法確認的資訊，最後直接給我一份完整、清楚的回應。';
  const WEB_LABELS = {gpt:'GPT',claude:'Claude',gemini:'Gemini'};
  const webDrafts = new Map();
  const webLogins = {};
  const webModelMenus = new Map();
  const webMenuKey = site => site+':'+(site==='gpt' ? state.settings?.providers.gpt.webAccountId || 'default' : 'website');
  function webModelSelect(site,value,attrs={}) {
    const select=h('select',{...attrs,'aria-label':attrs['aria-label'] || WEB_LABELS[site]+' 網頁模型'});
    select.append(h('option',{value:'',text:'沿用網站模型'}));
    const menu=webModelMenus.get(webMenuKey(site));
    const models=menu?.models || [];
    for(const m of models)select.append(h('option',{value:m.slug,text:(m.title || m.slug)+(m.description?' · '+m.description:''),title:m.description || m.title || m.slug}));
    if(value && !models.some(m=>m.slug===value))select.append(h('option',{value,text:value+'（尚未確認）'}));
    select.value=value || '';
    return select;
  }
  async function refreshWebModels(site) {
    const key=webMenuKey(site),draftKey=webDraftKey();
    if(webModelMenus.get(key)?.loading)return;
    webDrafts.set(draftKey,readWebForm());
    webModelMenus.set(key,{...webModelMenus.get(key),loading:true,error:''});renderWebEnsemblePanel();
    try {
      const r=await api.webModelModels(site);
      if(r.cancelled)throw Error('模型清單讀取已取消');
      if(site==='gpt' && r.accountId && key!=='gpt:'+r.accountId)throw Error('GPT 帳號已切換，請重新讀取');
      webModelMenus.set(key,{models:r.models || [],loading:false,error:''});
    } catch(error) {webModelMenus.set(key,{...webModelMenus.get(key),loading:false,error:error.message});}
    // A late discovery must not read/write or rerender another chat's draft.
    if(key===webMenuKey(site) && draftKey===webDraftKey()) {
      webDrafts.set(draftKey,readWebForm());renderWebEnsemblePanel();
    }
  }
  let webSaveTail = Promise.resolve();
  let webOptionsOpen = false;
  let webPanelOpen = false;
  function updateWebPanelToggle() {
    const button=$('#modelBtn');
    setPill(button,webPanelOpen?'網頁設定 ▾':'網頁設定 ▸');
    button.setAttribute('aria-expanded',String(webPanelOpen));button.setAttribute('aria-controls','webEnsemblePanel');
    button.title=(webPanelOpen?'收合':'展開')+'網頁模型、MCP 與統合設定';
  }
  const webDraftKey = () => state.current?.key || '__new';
  function webConfig() {
    const cfg = webDrafts.get(webDraftKey()) || state.settings?.providers.gpt.webEnsemble || {};
    const value={enabled:false,sites:['gpt'],models:{},mcp:state.settings?.providers.gpt.webAgent===true,synthesize:true,target:'web:gpt',model:'',prompt:WEB_DEFAULT_PROMPT,...structuredClone(cfg)};
    value.models ||= {};
    value.connections ||= {};
    if(state.settings?.webWebsiteHttpOnly===true)value.connections={gpt:'site-http',claude:'site-http',gemini:'site-http'};
    if(state.settings?.webBrowserModeRestored===true)value.connections={gpt:'account',claude:'account',gemini:'account'};
    value.apiModels ||= {};
    if(!Object.hasOwn(value.models,'gpt'))value.models.gpt=state.settings?.providers.gpt.webModel || '';
    if(value.mcp){value.sites=[value.sites?.[0] || 'gpt'];value.enabled=true;}
    return value;
  }
  function readWebForm() {
    const panel = $('#webEnsemblePanel');
    if(panel.hidden || !panel.querySelector('#webEnabled'))return webConfig();
    const current=webConfig();
    const httpSynthesis=$('#webSynthesisModel').dataset.synthesisTransport==='http';
    return {enabled:$('#webEnabled').checked,mcp:$('#webMcp').checked,sites:[...panel.querySelectorAll('[data-web-site]:checked')].map(el=>el.dataset.webSite),
      connections:Object.fromEntries([...panel.querySelectorAll('[data-web-connection]')].map(el=>[el.dataset.webConnection,el.value])),
      apiModels:{...webConfig().apiModels,...Object.fromEntries([...panel.querySelectorAll('[data-web-api-model]')].map(el=>[el.dataset.webApiModel,el.value.trim()]))},
      models:{...webConfig().models,...Object.fromEntries([...panel.querySelectorAll('[data-web-model]')].map(el=>[el.dataset.webModel,el.value.trim()]))},
      synthesize:$('#webAutoSynthesis').checked,target:$('#webSynthesisTarget').value,
      model:httpSynthesis ? current.model : $('#webSynthesisModel').value.trim(),
      httpSynthesisModel:httpSynthesis ? $('#webSynthesisModel').value.trim() : current.httpSynthesisModel || '',prompt:$('#webSynthesisPrompt').value};
  }
  function saveWebEnsemble(notify = false) {
    const value = readWebForm();
    if(!value.enabled && !value.sites.length)value.sites=['gpt'];
    if(!value.sites.length)return Promise.reject(Error('請至少勾選一個網頁模型'));
    webDrafts.set(webDraftKey(),value);
    const cur = state.current;
    const work = webSaveTail.catch(()=>{}).then(async()=>{
      state.settings=await api.saveSettings({providers:{gpt:{webEnsemble:value}}});
      if(cur)await rememberPick('gpt',state.settings,cur,true);
      if(cur?.key===state.current?.key && state.provider==='gpt' && gptWeb()) {
        updateWebPanelToggle();
      }
      if(notify)toast('網頁模型與統合 Prompt 已保存');
      return value;
    });
    webSaveTail=work;return work;
  }
  function renderWebEnsemblePanel() {
    const panel=$('#webEnsemblePanel');
    panel.hidden=state.provider!=='gpt'||!gptWeb()||!webPanelOpen;
    if(panel.hidden)return;
    const cfg=webConfig();
    panel.replaceChildren();
    const row=h('div',{class:'web-source-row'},h('label',{class:'web-enable'},h('input',{id:'webEnabled',type:'checkbox',checked:cfg.enabled,disabled:cfg.mcp}),h('span',{text:cfg.mcp?'單選回應（MCP）':'複選回應'})));
    for(const site of ['gpt','claude','gemini']){
      const checkbox=h('input',{type:cfg.mcp?'radio':'checkbox',name:cfg.mcp?'webMcpSource':undefined,checked:cfg.sites.includes(site),dataset:{webSite:site}});
      const login=h('button',{type:'button',class:'web-login-btn',text:webLogins[site]?'取消登入':'登入',title:`登入 ${WEB_LABELS[site]} 網頁帳號`,onclick:async()=>{
        if(site==='gpt'){const oldKey=webMenuKey(site);await loginGptWebAccount();webModelMenus.delete(oldKey);webModelMenus.delete(webMenuKey(site));renderWebEnsemblePanel();return;}
        if(webLogins[site]){await api.webModelCancelLogin(site);return;}
        webLogins[site]=true;renderWebEnsemblePanel();toast(state.settings?.webWebsiteHttpOnly===true?`正在同步王品瀏覽器的 ${WEB_LABELS[site]} 登入資料…`:`請在開啟的 ${WEB_LABELS[site]} 視窗登入，完成後會保存登入資料。`,8000);
        try{const r=await api.webModelLogin(site);toast(r.ok?'登入資料已保存':r.message||'登入已取消',6000);}catch(error){toast(error.message,7000);}
        finally{webLogins[site]=false;webModelMenus.delete(webMenuKey(site));renderWebEnsemblePanel();}
      }});
      login.disabled=cfg.connections?.[site]==='guest' || cfg.connections?.[site]==='http';
      row.append(h('div',{class:'web-site-chip'},h('label',{},checkbox,h('span',{text:WEB_LABELS[site]})),login));
    }
    row.append(h('label',{class:'web-enable',title:'來源模型可使用已勾選的 MCP；統合模型只整理答案。'},h('input',{id:'webMcp',type:'checkbox',checked:cfg.mcp}),h('span',{text:'MCP 工具'})),
      h('label',{class:'web-enable',title:'勾選＝網頁在背景不顯示（預設）；取消勾選則顯示網頁視窗。登入或人機驗證時一定會顯示。'},h('input',{id:'webShowWindow',type:'checkbox',checked:state.settings?.webHideWindow!==false,onchange:async event=>{try{state.settings=await api.saveSettings({webHideWindow:event.target.checked});}catch(e){toast(e.message);}}}),h('span',{text:'隱藏網頁視窗'})),
      h('button',{type:'button',class:'btn-small',text:'設定 MCP…',onclick:()=>{openSettings();$('#extSection').open=true;$('#extSection').scrollIntoView({block:'nearest'});}}));
    panel.append(row);
    const connections=new Map();
    for(const site of ['gpt','claude','gemini']){
      const select=h('select',{dataset:{webConnection:site},'aria-label':WEB_LABELS[site]+' 連線方式'});
      for(const [value,label] of [['account','網站帳號（瀏覽器登入與對話）']])select.append(h('option',{value,text:label}));
      select.value=cfg.connections?.[site]==='http'?'site-http':cfg.connections?.[site] || 'account';
      select.disabled=true;
      connections.set(site,h('label',{class:'web-connection-label'},h('span',{text:WEB_LABELS[site]+' 連線'}),select));
    }
    panel.append(h('div',{class:'web-connection-help',text:'已恢復瀏覽器網頁模式：在網站登入，使用同一份網站設定檔讀取模型與對話，不使用 API Key。',title:'網站驗證在登入視窗內完成；不再複製 Cookie 到另一個 HTTP 聊天環境。'}));
    if(cfg.mcp)panel.append(h('div',{class:'web-connection-help',text:'MCP 單選回答，不另外統合。'}));
    const modelRow=h('div',{class:'web-source-models'});
    for(const site of ['gpt','claude','gemini']) {
      const menu=webModelMenus.get(webMenuKey(site));
      const mode=cfg.connections?.[site]==='http'?'site-http':cfg.connections?.[site] || 'account';
      const picker=mode==='http' ? h('input',{type:'text',value:cfg.apiModels?.[site] || '',placeholder:state.settings?.providers[site]?.model || '沿用 API 設定模型',maxLength:200,dataset:{webApiModel:site},'aria-label':WEB_LABELS[site]+' HTTP 模型'}) : webModelSelect(site,cfg.models[site],{dataset:{webModel:site}});
      if(mode==='guest'){picker.value='';picker.disabled=true;delete picker.dataset.webModel;}
      picker.disabled=mode==='guest' || (cfg.mcp && !cfg.sites.includes(site));
      const refresh=h('button',{type:'button',class:'btn-small',dataset:{webRefresh:site},text:menu?.loading?'取消讀取':'讀取模型',onclick:()=>menu?.loading?api.webModelCancelModels(site):refreshWebModels(site)});
      refresh.disabled=mode==='guest';
      if(mode==='http')refresh.onclick=async()=>{try{const ids=await api.listModels(site);toast(ids.join('、'),15000);}catch(error){toast(error.message,7000);}};
      modelRow.append(h('div',{class:'web-source-card'},connections.get(site),h('div',{class:'web-source-model'},h('label',{},h('span',{text:WEB_LABELS[site]+' 回答模型'}),picker),refresh,
        ...(menu?.error?[h('span',{class:'web-model-error',text:menu.error})]:[]))));
    }
    panel.append(modelRow);
    const details=h('details',{id:'webEnsembleOptions',class:'web-ensemble-options',open:webOptionsOpen});
    details.hidden=cfg.mcp;
    details.append(h('summary',{text:'統合模型與 Prompt'}));
    details.ontoggle=()=>{webOptionsOpen=details.open;};
    const targets=h('select',{id:'webSynthesisTarget','aria-label':'統合來源'});
    for(const [value,label]of [['web:gpt','GPT 網頁版'],['web:claude','Claude 網頁版'],['web:gemini','Gemini 網頁版'],['codex','Codex'],['claudecode','Claude Code'],...['gpt','claude','gemini','deepseek','grok','meta','ablit','lmstudio'].map(p=>['api:'+p,(LABELS[p]||p)+' API'])])targets.append(h('option',{value,text:label}));
    targets.value=cfg.target;
    const synthSite=cfg.target.startsWith('web:') && cfg.connections?.[cfg.target.slice(4)]!=='http'?cfg.target.slice(4):'';
    const httpSynthesis=cfg.target.startsWith('web:') && cfg.connections?.[cfg.target.slice(4)]==='http';
    const synthPicker=synthSite?webModelSelect(synthSite,cfg.model,{id:'webSynthesisModel','aria-label':'統合模型'}):h('input',{id:'webSynthesisModel',type:'text',value:httpSynthesis?cfg.httpSynthesisModel || '':cfg.model,maxLength:200,placeholder:'留空沿用該來源的模型'});
    synthPicker.dataset.synthesisTransport=httpSynthesis?'http':'other';
    const grid=h('div',{class:'web-settings-grid'},h('label',{},h('span',{text:'統合來源'}),targets),h('label',{},h('span',{text:'統合模型（獨立於回答模型）'}),synthPicker));
    details.append(grid,h('label',{class:'web-auto-synthesis'},h('input',{id:'webAutoSynthesis',type:'checkbox',checked:cfg.synthesize}),h('span',{text:'全部回答後自動統合（會多送出一次模型請求）'})),
      h('label',{class:'web-prompt-label'},h('span',{text:'統合 Prompt：決定回應方式'}),h('textarea',{id:'webSynthesisPrompt',rows:3,maxLength:20000,value:cfg.prompt,spellcheck:'false','aria-label':'統合 Prompt'})),
      h('div',{class:'web-settings-footer'},h('span',{text:'各家答案會保留；也能稍後重新統合。'}),h('button',{type:'button',class:'btn-small',text:'保存設定',onclick:()=>saveWebEnsemble(true).catch(e=>toast(e.message,6000))})));
    panel.append(details);
    $('#webSynthesisPrompt').value=cfg.prompt;
    panel.oninput=event=>{
      if(event.target.id!=='webEnabled' && !event.target.dataset.webModel)$('#webEnabled').checked=true;
      webDrafts.set(webDraftKey(),readWebForm());
    };
    targets.onchange=()=>{const next=readWebForm();if(next.target!==cfg.target)next.model='';webDrafts.set(webDraftKey(),next);renderWebEnsemblePanel();saveWebEnsemble(false).catch(e=>toast(e.message,6000));};
    panel.onchange=event=>{
      if(event.target===targets)return;
      const next=readWebForm();
      if(next.mcp){next.sites=[next.sites[0] || 'gpt'];next.enabled=true;}
      webDrafts.set(webDraftKey(),next);
      if(event.target.id==='webMcp' || event.target.dataset.webConnection || (next.mcp && event.target.dataset.webSite))renderWebEnsemblePanel();
      saveWebEnsemble(false).catch(e=>toast(e.message,6000));
    };
  }
  function webRoundElement(message) {
    const round=message.webRound;
    const el=h('div',{class:'msg assistant web-round',dataset:{p:'gpt'}},h('div',{class:'who',text:'網頁模型回答'}));
    for(const result of round.results||[]){
      const body=h('div',{class:'md'});renderMarkdown(body,result.text||'');
      const detail=h('details',{class:'fold web-answer',open:result.status!=='completed'},h('summary',{text:`${WEB_LABELS[result.site]||result.site}${result.model?' · '+result.model:''} · ${result.status==='completed'?'完成':result.status==='cancelled'?'已停止':'未完成'}`}),body);
      if(result.error)detail.append(h('div',{class:'partial failed',text:result.error}));
      el.append(detail);
    }
    if(message.tools?.length){
      const tools=h('details',{class:'fold web-mcp-tools'},h('summary',{text:`MCP／本機工具 ${message.tools.length} 次`}));
      for(const item of message.tools)tools.append(h('div',{class:'ext-note',text:`${item.label || item.name} · ${item.status}`}),h('pre',{class:'ext-note',text:String(item.output || (typeof item.args === 'string' ? item.args : JSON.stringify(item.args || {}))).slice(0,4000)}));
      el.append(tools);
    }
    el.append(h('button',{type:'button',class:'btn-small web-resynthesize',text:'統合此輪回答',onclick:async()=>{
      if(currentRun()){toast('請先等目前的回應結束，或按停止');return;}
      if(gptWeb() && webConfig().mcp){toast('請先關閉 MCP，再選擇統合模型。');return;}
      if(!gptWeb())applySettings(await api.setActiveKey({provider:'gpt',id:'__web__'}));
      setProvider('gpt',{save:false});
      await startRun('統合此輪回答','gpt',{webSynthesisRoundId:round.id,attachmentIds:[]});
    }}));
    return el;
  }

  // 每段對話各自記住的模型選擇：供應商，以及各供應商的模型與推理強度
  function wangpinPlanDefaults() {
    const provider=state.provider, cfg=state.settings?.providers?.[provider] || {};
    const target=provider==='codex'?'codex':provider==='antigravity'?'antigravity':provider==='claude'&&cfg.via!=='api'?'claudecode':provider==='gpt'&&cfg.via==='web'?'web:gpt':'api:'+provider;
    const model=target==='claudecode'?cfg.cliModel:target.startsWith('web:')?cfg.webModel:cfg.model;
    return {enabled:false,plan:{target,model:model || ''},execute:{target,model:model || ''}};
  }
  function activeWangpinPlan() {
    const saved=state.current ? state.current.modelPick?.wangpinPlan : state.settings?.wangpinPlan;
    return structuredClone(saved || {...(state.settings?.wangpinPlan || wangpinPlanDefaults()),enabled:false});
  }
  async function wangpinPlanModels(target, snapshot) {
    if(target==='codex')return (await api.codexModels({})).models.map(m=>({value:m.slug,label:m.name || m.slug,efforts:m.efforts || []}));
    if(target==='claudecode'){
      const result=await api.claudeModels(false);
      return [{value:'opusplan',label:'opusplan · Opus 規劃／Sonnet 執行'},...(result.models || []).filter(m=>m.slug!=='opusplan').map(m=>({value:m.slug,label:m.name || m.slug,efforts:m.efforts || []}))];
    }
    if(target==='antigravity'){
      const result=await api.antigravityStatus({});if(!result.ok)throw Error(result.message || 'Antigravity 尚未就緒');
      return (result.families || []).map(m=>({value:m.name,label:m.name,efforts:(m.variants || []).map(v=>v.effort).filter(Boolean)}));
    }
    if(target.startsWith('web:')){
      const site=target.slice(4), result=await api.webModelModels(site);
      if(result.cancelled)throw Error('讀取模型已取消');
      if(site==='gpt'&&result.accountId&&result.accountId!==(snapshot.providers.gpt.webAccountId || 'default'))throw Error('GPT 網頁帳號已切換，請重新開啟設定');
      return (result.models || []).map(m=>({value:m.slug,label:m.title || m.slug}));
    }
    const result=await api.listModels(target.slice(4));
    return (Array.isArray(result)?result:result.models || []).map(m=>typeof m==='string'?{value:m,label:m}:{value:m.id,label:m.name || m.id});
  }
  function openWangpinPlan() {
    closeMenu();
    const origin=state.current, epoch=viewEpoch, snapshot=structuredClone(state.settings);
    const ui=WangpinPlanUI.create({getValue:activeWangpinPlan,getDefaults:wangpinPlanDefaults,
      loadModels:target=>wangpinPlanModels(target,snapshot),onError:error=>toast(error?.message || String(error),7000),
      save:async config=>{
        if(origin){
          const previous=origin.modelPick;
          const next={...(previous || {}),provider:previous?.provider || state.provider,byProvider:previous?.byProvider || {},wangpinPlan:structuredClone(config)};
          origin.modelPick=next;
          try{const result=await api.updateChat({key:origin.key,modelPick:next});if(result?.error)throw Error(result.error);}
          catch(error){if(origin.modelPick===next)origin.modelPick=previous;throw error;}
          if(state.current?.key===origin.key&&state.current!==origin)state.current.modelPick={...(state.current.modelPick || next),wangpinPlan:structuredClone(config)};
        }else if(state.current || epoch!==viewEpoch)throw Error('對話已切換，請在要設定的對話重新開啟 wangpinplan');
        const updated=await api.saveSettings({wangpinPlan:structuredClone(config)});
        state.settings=updated;renderComposerBar();
      }});
    ui.open($('#wangpinPlanBtn'));
  }
  function renderWangpinPlanButton() {
    const button=$('#wangpinPlanBtn');if(!button)return;
    const config=activeWangpinPlan();button.textContent=config.enabled?'wangpinplan · 開':'wangpinplan';
    button.classList.toggle('on',!!config.enabled);button.setAttribute('aria-pressed',String(!!config.enabled));
    button.setAttribute('aria-checked',String(!!config.enabled));
    document.querySelectorAll('#providerSwitch button[data-p]').forEach(b=>b.setAttribute('aria-checked',String(!config.enabled&&b.dataset.p===state.provider)));
    button.title=config.enabled?`Plan：${config.plan.target} / ${config.plan.model || '預設'}\n執行：${config.execute.target} / ${config.execute.model || '預設'}\n執行權限沿用選定服務的設定`:'分別選擇 Plan 與執行模型';
  }
  const PICK_FIELDS = ['model', 'effort', 'reasoningEffort', 'thinking', 'cliModel', 'webModel', 'webAgent', 'webEffort', 'webEnsemble'];
  function pickOf(p, settings = state.settings) {
    const cfg = settings.providers?.[p] || {};
    const out = {};
    for (const f of PICK_FIELDS) if (cfg[f] !== undefined) out[f] = cfg[f];
    return out;
  }
  function rememberPick(p = state.provider, settings = state.settings, cur = state.current, strict = false) {
    if (!cur || !p) return;
    const modelPick = { ...(cur.modelPick || {}), provider: p, byProvider: { ...(cur.modelPick?.byProvider || {}), [p]: pickOf(p, settings) } };
    cur.modelPick = modelPick;
    return api.updateChat({ key: cur.key, modelPick }).then(result => {
      if (result?.error) throw Error(result.error);
      return result;
    }).catch(error => { if (strict) throw error; });
  }
  // 切到某段對話：照它上次留下的選擇還原；沒有紀錄的舊對話維持目前的選擇
  async function restorePick(pick) {
    if (pick?.provider === 'grokbot') pick = { ...pick, provider: 'grokbuild' };
    if (!pick || !ORDER.includes(pick.provider)) return;
    const patch = {};
    for (const [p, v] of Object.entries(pick.byProvider || {})) {
      if (!state.settings.providers?.[p] || !v || typeof v !== 'object') continue;
      const cfg = state.settings.providers[p];
      const diff = {};
      for (const f of PICK_FIELDS) if (v[f] !== undefined && v[f] !== cfg[f]) diff[f] = v[f];
      if (Object.keys(diff).length) patch[p] = diff;
    }
    if (Object.keys(patch).length || state.settings.lastProvider !== pick.provider) {
      state.settings = await api.saveSettings({ ...(Object.keys(patch).length ? { providers: patch } : {}), lastProvider: pick.provider });
    }
    if (state.provider !== pick.provider) setProvider(pick.provider, { save: false });
    else renderComposerBar();
  }

  async function saveProvider(p, patch) {
    const cur = state.current;
    state.settings = await api.saveSettings({ providers: { [p]: patch } });
    if (Object.keys(patch).some((f) => PICK_FIELDS.includes(f))) await rememberPick(p, state.settings, cur);
    renderComposerBar();
    if (!state.current) renderMessages();
  }

  async function saveBrowser(patch) {
    state.settings = await api.saveSettings({ browser: patch });
    renderComposerBar();
    if (patch.enabled === true || patch.braveEnabled === true) {
      try {
        const info = await api.browserPrepare({reason:'你已選擇使用外部 Brave，先確認這台電腦的瀏覽器是否就緒。'});
        state.settings = await api.getSettings();
        if (!info.ready) toast('外部 Brave 尚未就緒；安裝完成後可再開啟此選項重新偵測。',6000);
      } catch(error) { toast(`無法檢查 Brave：${error.message}`,6000); }
    }
  }

  // 讓使用者可以自己確認 Brave 控制是否正常
  async function openBraveNow() {
    toast('正在啟動 Brave 的除錯連線…', 4000);
    try {
      const info = await api.browserStart();
      toast(info.running ? `Brave 已就緒（${info.browser || 'Chromium'}，除錯埠 ${info.port}）` : 'Brave 沒有啟動', 6000);
    } catch (e) { toast(e.message, 9000); }
  }

  function codexModelInfo(slug) {
    const cm = state.codexModels;
    if (!cm) return null;
    const target = slug || cm.defaultModel;
    return cm.models.find((m) => m.slug === target) || (target ? null : cm.models[0]) || null;
  }

  function newWorkspaceParent() {
    return currentProject();
  }

  function currentProject() {
    return state.current?.workspace?.originalProject ?? state.current?.originalProject ?? currentCwd();
  }

  function currentCwd() {
    if (state.current) return state.current.cwd || '';
    return state.pendingCwd != null ? state.pendingCwd : (state.settings.defaultCwd || '');
  }

  function setPill(btn, text, show = true) {
    btn.hidden = !show;
    btn.querySelector('span').textContent = text;
  }

  function syncGptWebView() {
  }

  function renderComposerBar() {
    syncGptWebView();
    if (!state.settings) return;
    const p = state.provider;
    const cfg = state.settings.providers[p] || {};
    renderWebEnsemblePanel();
    // 模型
    let modelText;
    if (p === 'codex') {
      const info = cfg.model ? codexModelInfo(cfg.model) : null;
      modelText = cfg.model ? (info ? info.name : cfg.model) : '預設模型';
    } else {
      modelText = p === 'grokbuild' ? (grokBuildModelName(cfg.model) || '沿用 Grok Build 預設') : p === 'antigravity' ? (cfg.model || '沿用 Antigravity 預設') : p === 'claude' && viaSub('claude') ? (cfg.cliModel || '沿用 Claude Code 預設') : p === 'gpt' && gptWeb() ? `${cfg.webModel || '沿用網頁上選的模型'}${cfg.webAgent ? '・Codex 架構' : ''}` : p === 'lmstudio' ? (cfg.model || '用 LM Studio 已載入的模型') : cfg.model || catalogOf(p).models[0];
    }
    setPill($('#modelBtn'), modelText, p !== 'grokbot');
    renderWangpinPlanButton();
    $('#modelBtn').title = `選擇模型（目前：${modelText}）`;
    if(p==='gpt' && gptWeb())updateWebPanelToggle();
    else {$('#modelBtn').removeAttribute('aria-expanded');$('#modelBtn').removeAttribute('aria-controls');}
    // 推理
    if (p === 'codex') setPill($('#effortBtn'), `推理：${cfg.effort && cfg.effort !== 'default' ? (EFFORT_LABEL[cfg.effort] || cfg.effort) : '預設'}`);
    else if (p === 'gpt' && gptWeb()) setPill($('#effortBtn'), `推理：${cfg.webEffort && cfg.webEffort !== 'default' ? (EFFORT_LABEL[cfg.webEffort] || cfg.webEffort) : '沿用網頁'}`);
    else if (p === 'gpt' || p === 'gemini' || p === 'grok' || p === 'meta') setPill($('#effortBtn'), `推理：${cfg.reasoningEffort && cfg.reasoningEffort !== 'default' ? (EFFORT_LABEL[cfg.reasoningEffort] || cfg.reasoningEffort) : '預設'}`);
    else if (p === 'claude' && viaSub('claude')) setPill($('#effortBtn'), `推理：${cfg.effort && cfg.effort !== 'default' ? (EFFORT_LABEL[cfg.effort] || cfg.effort) : '預設'}`);
    else if (p === 'grokbuild') setPill($('#effortBtn'), `推理：${cfg.effort && cfg.effort !== 'default' ? (EFFORT_LABEL[cfg.effort] || cfg.effort) : '預設'}`);
    else if (p === 'antigravity') setPill($('#effortBtn'), `推理：${cfg.effort && cfg.effort !== 'default' ? (EFFORT_LABEL[cfg.effort] || cfg.effort) : '預設'}`);
    else if (p === 'deepseek') setPill($('#effortBtn'), `思考：${cfg.thinking === 'enabled' ? '開' : cfg.thinking === 'disabled' ? '關' : '預設'}`);
    else setPill($('#effortBtn'), '', false);
    // 金鑰
    if (p === 'codex') {
      const acc = activeCodexAccount();
      const short = acc ? (acc.name || (acc.email ? acc.email.split('@')[0] : acc.label)) : '';
      setPill($('#keyBtn'), acc ? `帳號：${short.length > 18 ? short.slice(0, 17) + '…' : short}` : (state.codexAccounts ? '登入 Codex 帳號' : '帳號'));
      $('#keyBtn').title = acc ? `Codex 帳號：${acc.label}${acc.plan ? `（${planName(acc.plan)}）` : ''}\n點一下切換或登入其他帳號` : '切換或登入 Codex 帳號';
      $('#keyBtn').classList.toggle('warn', !!state.codexAccounts && !acc);
    } else if (p === 'grokbuild') {
      const gb = state.grokBuild;
      setPill($('#keyBtn'), !gb ? '檢查連線…' : !gb.installed ? '安裝 CLI' : !gb.signedIn ? '登入 Grok Build' : '帳號：grok.com');
      $('#keyBtn').title = !gb ? 'Grok Build 帳號' : gb.message || `Grok Build CLI ${gb.version || ''}（grok.com 帳號已登入）\n點一下重新登入或重新讀取`;
      $('#keyBtn').classList.toggle('warn', !!gb && !gb.ok);
    } else if (p === 'grokbot') {
      setPill($('#keyBtn'), cfg.hasKey ? '連線：Webhook' : '設定 Grok Bot');
      $('#keyBtn').title = cfg.hasKey ? `Grok Bot routine webhook（金鑰 ${cfg.keyHint || ''}）\n回覆經 ntfy 主題：${cfg.ntfyTopic || ''}\n點一下可修改設定或開啟 Grok Bot 桌面版` : '尚未設定 Grok Bot 的 Webhook URL 與 Key，點一下設定';
      $('#keyBtn').classList.toggle('warn', !cfg.hasKey);
    } else if (p === 'antigravity') {
      const ag = state.antigravity;
      const email = ag?.ok ? (ag.account.email || '') : '';
      const short = email ? email.split('@')[0] : ag?.ok ? 'CLI 已登入' : '';
      setPill($('#keyBtn'), short ? `帳號：${short.length > 18 ? short.slice(0, 17) + '…' : short}` : ag && !ag.ok ? (/not logged in|unauthenticated|please.*login|尚未登入|未登入/i.test(ag.message || '') ? '登入 CLI' : '連線異常・重試') : '檢查連線…');
      $('#keyBtn').title = email ? `Antigravity 帳號：${email}${ag.account.tier ? `（${ag.account.tier}）` : ''}\n點一下查看帳號與額度` : (ag?.message || 'Antigravity 帳號');
      $('#keyBtn').classList.toggle('warn', !!ag && !ag.ok);
    } else {
      $('#keyBtn').title = '使用哪一把金鑰';
      const keys = cfg.keys || [];
      const active = keys.find((k) => k.id === cfg.activeKeyId);
      if (viaSub(p)) {
        const account = p === 'claude' ? (state.claudeAccounts?.accounts || state.settings.claudeAccounts || []).find(a => a.active || normDir(a.configDir) === normDir(cfg.configDir)) : null;
        setPill($('#keyBtn'), account ? `帳號：${account.label}` : `連線：${activeSub(p).name}`);
        if (p === 'gpt' && cfg.via === 'web') {
          const webAccount = state.gptWebAccounts?.accounts.find(a => a.id === state.gptWebAccounts.activeId);
          if (webAccount) setPill($('#keyBtn'), `連線：ChatGPT · ${webAccount.name}`);
          $('#keyBtn').title = '登入、切換與管理 ChatGPT 網頁帳號';
        }
        $('#keyBtn').classList.remove('warn');
      } else {
        if (p === 'lmstudio') {
          const base = (active && active.baseUrl) || catalogOf('lmstudio').defaultBase;
          setPill($('#keyBtn'), `伺服器：${base.replace(/^https?:\/\//, '').replace(/\/v1$/, '')}`);
          $('#keyBtn').title = `LM Studio 伺服器：${base}\n點一下可改網址或填金鑰（LM Studio 有開驗證時才需要）`;
          $('#keyBtn').classList.remove('warn');
        } else {
          setPill($('#keyBtn'), active ? `金鑰：${active.name}` : '新增金鑰');
          $('#keyBtn').classList.toggle('warn', !active);
        }
      }
    }
    // 專案
    const cwd = currentProject();
    const proj = (state.sidebar.recentProjects || []).find((r) => r.path.toLowerCase().replace(/[\\/]+$/, '') === cwd.toLowerCase().replace(/[\\/]+$/, ''));
    $('#projectBtn').querySelector('span').textContent = cwd ? (proj ? proj.name : baseName(cwd)) : '選擇專案';
    $('#projectBtn').title = `Project: ${cwd || 'none'}\nWorking folder: ${currentCwd() || 'none'}`;
    // 權限
    const list = permissionOptions(p);
    const perm = list.find(x => x.value === cfg[permissionField(p)]) || list[0];
    // GPT 走 Codex 訂閱時權限由 Codex 的沙盒決定；走 API 時由本 App 的工具權限決定
    $('#permBtn').hidden = p === 'grokbot';  // Grok Bot 在雲端執行，沒有本機工具權限可選
    $('#permBtn').title = `${LABELS[p]} 預設使用權限（自動儲存）`;
    $('#permBtn').querySelector('span').textContent = perm.label;
    $('#permBtn').classList.toggle('danger', ['danger-full-access', 'bypassPermissions'].includes(perm.value));
    renderExtPill();
    renderUsageLine();

  }

  // ---- 能力擴充（Prime Agent／Zenith／Scrapling／自訂 MCP，三者各自獨立）----
  // 勾選只屬於各自的對話：新對話一律從「全不勾」開始，也不再有會蔓延到其他對話的全域預設
  function activeExtensions() {
    const list = !state.current ? [...(state.pendingExtensions || [])] : Array.isArray(state.current.extensions) ? [...state.current.extensions] : [];
    const known = new Set(extPacks().map(pack => pack.id));
    return list.filter((id) => !HIDDEN_EXT.has(id) && known.has(id));
  }
  const HIDDEN_EXT = new Set(['scriptDoctor', 'companion', 'harness']); // 1.9.50：這四個不再出現在擴充選單
  function extPacks() { return state.extensions?.packs || []; }

  async function loadExtensions() {
    try { state.extensions = await api.listExtensions(); } catch { state.extensions = { packs: [], enabled: [] }; }
    renderExtPill();
    refreshHarnessCache().then(renderExtPill);
    if ($('#settingsDlg').open) renderExtSettings();
  }

  function renderExtPill() {
    const btn = $('#extBtn');
    if (!btn) return;
    const on = activeExtensions();
    const packs = extPacks();
    const names = on.map((id) => packs.find((p) => p.id === id)?.name || id);
    const label = !names.length ? 'skill' : names.length === 1 ? `skill：${names[0]}` : `skill：${names.length} 項`;
    setPill(btn, label);
    btn.classList.toggle('on', names.length > 0);
    btn.title = names.length
      ? `這段對話已開啟：${names.join('、')}${on.includes('harness') ? `（Harness 腳本：${harnessLabel(activeHarness())}）` : ''}（只套用這段對話）`
      : '這段對話要開啟哪些能力擴充（可複選，只套用這段對話）';
  }

  // ---- 自訂 Harness：每段對話各自選腳本 ----
  const HARNESS_AUTO = '__auto__';
  let harnessCache = null;  // 最近一次讀到的腳本清單（選單顯示名稱用）
  function activeHarness() {
    return state.current ? (state.current.harnessScript || '') : (state.pendingHarness || '');
  }
  function harnessDefault() { return ((state.settings?.extensions?.config || {}).harness || {}).defaultScript || '範本-通用流程.txt'; }
  function harnessLabel(file) {
    if (file === HARNESS_AUTO) return '依目標自動建立新腳本';
    const f = file || harnessDefault();
    const hit = (harnessCache || []).find((x) => x.file === f);
    return `${hit ? hit.name : f.replace(/\.txt$/i, '')}${file ? '' : '（預設）'}`;
  }
  async function refreshHarnessCache() { try { harnessCache = (await api.harnessList()).scripts; } catch { harnessCache = harnessCache || []; } return harnessCache; }
  async function setChatHarness(file) {
    if (state.current) {
      state.current.harnessScript = file;
      try { await api.updateChat({ key: state.current.key, harnessScript: file }); }
      catch (e) { toast(e.message || '無法儲存腳本選擇'); }
    } else state.pendingHarness = file;
    renderExtPill();
  }
  async function openHarnessPicker() {
    const scripts = await refreshHarnessCache();
    const cur = activeHarness();
    const items = [
      { label: '依目標自動建立新腳本', desc: '送出的訊息當成目標：模型先設計一份新腳本（存進腳本資料夾），再照它執行。之後這段對話會沿用那份新腳本。', checked: cur === HARNESS_AUTO, onSelect: () => setChatHarness(HARNESS_AUTO) },
      { label: `用預設腳本（${harnessLabel('')}）`, desc: '預設腳本在「API 設定 → 能力擴充 → 自訂 Harness」設定', checked: !cur, onSelect: () => setChatHarness('') },
      { divider: true },
      ...scripts.map((x) => ({
        label: `${x.name}${x.ok ? '' : '（格式有錯，不能執行）'}`,
        desc: `${x.file}｜${x.steps.map((st) => `${st.name}〔${st.type}〕`).join(' → ') || (x.errors[0] || '')}`,
        checked: cur === x.file,
        onSelect: () => { if (!x.ok) toast(`「${x.file}」有格式錯誤：${x.errors.slice(0, 2).join('；')}`, 8000); setChatHarness(x.file); },
      })),
    ];
    openMenu($('#extBtn'), { title: 'Harness 腳本（只套用這段對話）', items, footer: [{ label: '管理腳本…（新增／載入／修改／刪除）', onSelect: () => openHarnessManager(cur && cur !== HARNESS_AUTO ? cur : '') }] });
  }

  // 腳本管理：左邊清單、右邊直接編輯 TXT；存檔前先驗證格式（錯了照樣能存，但會標出第幾行）
  async function openHarnessManager(selectFile = '') {
    let data;
    try { data = await api.harnessList(); } catch (e) { toast(e.message || '讀不到腳本資料夾', 6000); return; }
    harnessCache = data.scripts;
    const dlg = h('dialog', { class: 'comp-edit harness-mgr', 'aria-label': '管理 Harness 腳本' });
    const listBox = h('div', { class: 'hn-list', role: 'listbox', 'aria-label': '腳本清單' });
    const editor = h('textarea', { class: 'comp-full hn-editor', spellcheck: 'false', 'aria-label': '腳本內容' });
    const nameIn = h('input', { type: 'text', class: 'hn-name', 'aria-label': '檔名', placeholder: '檔名' });
    const check = h('pre', { class: 'hn-check' });
    const status = h('span', { class: 'comp-hint' });
    const trashBox = h('details', { class: 'hn-trash' });
    let cur = '';
    let dirty = false;
    const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const showCheck = (r) => {
      check.classList.toggle('bad', !r.ok);
      check.textContent = r.ok
        ? `✓ 格式正確：${r.steps.map((st) => `${st.name}〔${st.type}〕`).join(' → ')}${(r.warnings || []).length ? `\n提醒：${r.warnings.join('\n')}` : ''}`
        : `⚠ 格式有錯，存檔後也不能執行：\n${r.errors.join('\n')}${(r.warnings || []).length ? `\n提醒：${r.warnings.join('\n')}` : ''}`;
    };
    const validate = debounce(async () => { try { showCheck(await api.harnessValidate(editor.value)); } catch (e) { check.textContent = clean(e); } }, 300);
    editor.addEventListener('input', () => { dirty = true; validate(); });
    const confirmDiscard = () => !dirty || confirm('目前的修改還沒儲存，要放棄嗎？');
    const reload = async (pick = cur) => {
      data = await api.harnessList();
      harnessCache = data.scripts;
      renderList();
      if (pick && data.scripts.some((x) => x.file === pick)) await select(pick, true);
      else if (data.scripts[0]) await select(data.scripts[0].file, true);
      else { cur = ''; editor.value = ''; nameIn.value = ''; check.textContent = ''; }
      renderTrash();
      renderExtPill();
    };
    function renderList() {
      listBox.innerHTML = '';
      for (const x of data.scripts) {
        const def = x.file === (data.defaultScript || '範本-通用流程.txt');
        listBox.append(h('button', { type: 'button', role: 'option', class: `hn-item${x.file === cur ? ' active' : ''}`, 'aria-selected': String(x.file === cur), title: x.purpose || x.file,
          onclick: async () => { if (x.file !== cur && confirmDiscard()) await select(x.file); } },
          h('span', { class: 'hn-item-name', text: `${x.ok ? '' : '⚠ '}${x.name}` }),
          h('span', { class: 'hn-item-sub', text: `${x.file}${def ? '・預設' : ''}${x.template ? '・範本' : ''}` })));
      }
      if (!data.scripts.length) listBox.append(h('p', { class: 'comp-hint', text: '還沒有腳本。按「新增」從範本建立。' }));
    }
    function renderTrash() {
      trashBox.innerHTML = '';
      trashBox.hidden = !data.trash.length;
      trashBox.append(h('summary', { text: `已刪除的腳本（${data.trash.length}）` }));
      for (const t of data.trash) {
        trashBox.append(h('div', { class: 'hn-trash-row' }, h('span', { class: 'comp-hint', text: `${t.file}（${t.deletedAt}）` }),
          h('button', { type: 'button', class: 'btn-small', text: '還原', onclick: async () => { try { const r = await api.harnessRestore(t.entry); status.textContent = `已還原成「${r.file}」`; await reload(r.file); } catch (e) { status.textContent = clean(e); } } })));
      }
    }
    async function select(file, force = false) {
      if (!force && !confirmDiscard()) return;
      try {
        const r = await api.harnessRead(file);
        cur = r.file; editor.value = r.text; nameIn.value = r.file.replace(/\.txt$/i, ''); dirty = false;
        showCheck({ ok: r.ok, errors: r.errors, steps: r.steps });
        validate();
        renderList();
      } catch (e) { status.textContent = clean(e); }
    }
    const saveBtn = h('button', { type: 'button', class: 'btn-small primary', text: '儲存', title: 'Ctrl+S', onclick: async () => {
      if (!cur) { status.textContent = '先選一份腳本，或按「新增」。'; return; }
      try {
        let file = cur;
        const want = nameIn.value.trim();
        if (want && `${want}.txt`.toLowerCase() !== cur.toLowerCase()) file = (await api.harnessRename(cur, want)).file;
        const r = await api.harnessSave(file, editor.value);
        dirty = false;
        status.textContent = r.ok ? `已儲存「${r.file}」，下一則訊息開始生效。` : `已儲存「${r.file}」，但格式有錯，修好之前不能執行（錯誤列在上面）。`;
        await reload(r.file);
        state.settings = await api.getSettings();
      } catch (e) { status.textContent = clean(e); }
    } });
    editor.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveBtn.click(); } });
    const tplSel = h('select', { 'aria-label': '新增時用的範本' }, ...['範本-通用流程.txt', '範本-程式代理.txt', '範本-研究查證.txt', '範本-寫作多階段.txt'].map((f) => h('option', { value: f, text: `從「${f.replace(/^範本-|\.txt$/g, '')}」範本` })));
    const newName = h('input', { type: 'text', class: 'hn-newname', placeholder: '新腳本名稱', 'aria-label': '新腳本名稱' });
    const addBtn = h('button', { type: 'button', class: 'btn-small', text: '新增', onclick: async () => {
      if (!confirmDiscard()) return;
      const name = newName.value.trim() || '我的腳本';
      try { const r = await api.harnessCreate(name, tplSel.value); newName.value = ''; status.textContent = `已從範本建立「${r.file}」。改好後按儲存。`; await reload(r.file); } catch (e) { status.textContent = clean(e); }
    } });
    const dupBtn = h('button', { type: 'button', class: 'btn-small', text: '複製一份', title: '把編輯器上的內容另存成一份新腳本', onclick: async () => {
      try { const r = await api.harnessSave(`${nameIn.value.trim() || '腳本'} 副本`, editor.value, false); dirty = false; status.textContent = `已另存成「${r.file}」`; await reload(r.file); } catch (e) { status.textContent = clean(e); }
    } });
    const importBtn = h('button', { type: 'button', class: 'btn-small', text: '載入 TXT…', title: '從別的地方選 .txt 腳本，複製一份進腳本資料夾（原檔不動）', onclick: async () => {
      if (!confirmDiscard()) return;
      try {
        const r = await api.harnessImport();
        if (!r || r.cancelled) return;
        const bad = r.files.filter((x) => !x.ok);
        status.textContent = `已載入 ${r.files.length} 份：${r.files.map((x) => x.file).join('、')}${bad.length ? `；其中 ${bad.length} 份格式有錯，修好之前不能執行` : ''}`;
        await reload(r.files[0]?.path ? r.files[0].file : cur);
      } catch (e) { status.textContent = clean(e); }
    } });
    const exportBtn = h('button', { type: 'button', class: 'btn-small', text: '另存 TXT…', title: '把編輯器上的內容另存到別的地方（備份或分享）', onclick: async () => {
      try { const r = await api.harnessExport(cur || `${nameIn.value.trim() || '腳本'}.txt`, editor.value); if (r && r.ok) status.textContent = `已另存到 ${r.file}`; } catch (e) { status.textContent = clean(e); }
    } });
    const delBtn = h('button', { type: 'button', class: 'btn-small danger', text: '刪除', onclick: async () => {
      if (!cur) return;
      try { const r = await api.harnessRemove(cur); if (r.cancelled) return; dirty = false; status.textContent = `已刪除「${r.file}」（移到「已刪除」資料夾，可以還原）。`; await reload(''); state.settings = await api.getSettings(); } catch (e) { status.textContent = clean(e); }
    } });
    const defBtn = h('button', { type: 'button', class: 'btn-small', text: '設為預設', title: '沒有另外選腳本的對話，勾 Harness 時用這一份', onclick: async () => {
      if (!cur) return;
      try { state.extensions = await api.saveExtensions({ config: { harness: { defaultScript: cur } } }); state.settings = await api.getSettings(); status.textContent = `預設腳本改成「${cur}」。`; data.defaultScript = cur; renderList(); renderExtPill(); } catch (e) { status.textContent = clean(e); }
    } });
    const useBtn = h('button', { type: 'button', class: 'btn-small', text: '用在這段對話', title: '這段對話（勾了 Harness 時）改用這份腳本', onclick: async () => { if (!cur) return; await setChatHarness(cur); status.textContent = `這段對話之後用「${cur}」。記得在擴充選單勾選「自訂 Harness」。`; } });
    const fileBar = h('div', { class: 'comp-file' },
      h('span', { class: 'comp-hint', text: '腳本資料夾：' }),
      h('code', { class: 'comp-path', text: data.root, title: data.root }),
      h('button', { type: 'button', class: 'btn-small', text: '開啟資料夾', onclick: () => api.harnessOpen('', false).catch((e) => { status.textContent = clean(e); }) }),
      h('button', { type: 'button', class: 'btn-small', text: '用記事本開啟', title: '用系統預設的程式開啟這份腳本；改完存檔，下一次執行就會套用', onclick: () => cur && api.harnessOpen(cur, false).catch((e) => { status.textContent = clean(e); }) }),
      h('button', { type: 'button', class: 'btn-small', text: '重新讀取', title: '重新讀取資料夾與這份腳本（在記事本改過之後按）', onclick: async () => { if (confirmDiscard()) { dirty = false; await reload(cur); } } }));
    dlg.append(
      h('div', { class: 'comp-head' }, h('h3', { text: '管理 Harness 腳本' }), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'icon-btn', text: '✕', title: '關閉', onclick: () => { if (confirmDiscard()) dlg.close(); } })),
      h('div', { class: 'comp-filewrap' }, fileBar),
      h('div', { class: 'hn-wrap' },
        h('div', { class: 'hn-side' }, listBox, h('div', { class: 'hn-add' }, tplSel, newName, addBtn, importBtn), trashBox),
        h('div', { class: 'hn-main' },
          h('div', { class: 'comp-row' }, h('span', { class: 'comp-hint', text: '檔名：' }), nameIn, h('span', { class: 'comp-hint', text: '.txt' }), h('span', { class: 'spacer' }), useBtn, defBtn),
          editor, check)),
      h('div', { class: 'comp-foot' }, status, h('span', { class: 'spacer' }), dupBtn, exportBtn, delBtn, h('button', { type: 'button', class: 'btn-small', text: '關閉', onclick: () => { if (confirmDiscard()) dlg.close(); } }), saveBtn));
    dlg.addEventListener('cancel', (e) => { if (!confirmDiscard()) e.preventDefault(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
    renderTrash();
    await reload(selectFile || data.defaultScript || '範本-通用流程.txt');
    editor.focus();
  }

  // ---- System Prompt：每段對話各自一份，所有模型都會套用 ----
  function currentSystemPrompt() { return state.current ? (state.current.systemPrompt || '') : (state.pendingSystemPrompt || ''); }
  async function setChatSystemPrompt(text) {
    const value = String(text || '').trim();
    if (state.current) {
      const previous = state.current.systemPrompt;
      state.current.systemPrompt = value || undefined;
      try { await api.updateChat({ key: state.current.key, systemPrompt: value }); }
      catch (e) { state.current.systemPrompt = previous; toast(e.message || '無法儲存 System Prompt'); return; }
    } else state.pendingSystemPrompt = value;
    renderExtPill();
    toast(value ? 'System Prompt 已設定；下一則訊息開始生效（只套用這段對話）' : '已清除這段對話的 System Prompt');
  }
  function openSystemPromptDialog() {
    const area = h('textarea', { rows: '10', spellcheck: 'false', placeholder: '例如：你是資深後端工程師。回答先給結論，再列步驟；程式碼一律附測試。' });
    area.value = currentSystemPrompt();
    const dlg = h('dialog', { id: 'spDlg' });
    const close = () => { dlg.close(); dlg.remove(); };
    const save = h('button', { type: 'button', class: 'btn-small primary', text: '儲存', onclick: async () => { await setChatSystemPrompt(area.value); close(); } });
    const clear = h('button', { type: 'button', class: 'btn-small', text: '清除', onclick: async () => { await setChatSystemPrompt(''); close(); } });
    const cancel = h('button', { type: 'button', class: 'btn-small', text: '取消', onclick: close });
    dlg.append(h('div', { class: 'dlg-body' },
      h('h3', { text: 'System Prompt（只套用這段對話）' }),
      h('p', { class: 'ext-note', text: '這段文字會加在每一回合給模型的系統提示之後，Codex、Claude、GPT、Antigravity、各家 API 模型都適用，換模型也會沿用。不會寫進對話內容。' }),
      area,
      h('div', { class: 'comp-foot' }, h('span', { class: 'spacer' }), clear, cancel, save)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg); dlg.showModal(); area.focus();
  }
  async function setChatExtensions(ids) {
    const list = [...new Set(ids)];
    if (state.current) {
      state.current.extensions = list;
      try { await api.updateChat({ key: state.current.key, extensions: list }); }
      catch (e) { toast(e.message || '無法儲存擴充設定'); }
    } else {
      state.pendingExtensions = list;  // 新對話還沒建立：先記在這段新對話上，送出時一起存進去
    }
    renderExtPill();
  }

  async function importSkill(mode) {
    try {
      const result = await api.importSkills(mode);
      if (result.cancelled) return;
      state.settings = await api.getSettings(); await loadExtensions();
      toast(`已載入 ${result.count} 個 skill；請在這段對話的 skill 選單勾選使用`);
    } catch (error) { toast(error.message || '載入 skill 失敗', 8000); }
  }
  function openExtMenu() {
    const packs = extPacks().filter((p) => !HIDDEN_EXT.has(p.id));
    const on = new Set(activeExtensions());
    const items = packs.flatMap((p) => [{
      label: `${p.name}［${p.category || '自訂'}］` + (p.available ? '' : '（找不到，需先安裝）'),
      desc: p.summary,
      checked: on.has(p.id),
      onSelect: async () => {
        const next = new Set(on);
        next.has(p.id) ? next.delete(p.id) : next.add(p.id);
        if (!on.has(p.id) && !p.available) toast(p.note, 7000);
        await setChatExtensions([...next]);
        openExtMenu();
      },
    }, ...(p.id === 'harness' && on.has('harness') ? [{
      label: `　└ 腳本：${harnessLabel(activeHarness())}`,
      desc: '點這裡選這段對話要用哪一份腳本，或改成「依目標自動建立」（只套用這段對話）',
      onSelect: () => openHarnessPicker(),
    }] : [])]);
    if (!items.length) items.push({ label: '尚未載入其他 skill', desc: '使用下方按鈕載入 skill 資料夾、Markdown 或 MCP JSON' });
    const sysPrompt = currentSystemPrompt();
    items.unshift({ label: sysPrompt ? 'System Prompt：已設定' : 'System Prompt：未設定', desc: sysPrompt ? sysPrompt.replace(/\s+/g, ' ').slice(0, 80) : '替這段對話加上自訂系統提示，所有模型都會套用；點這裡編輯', checked: !!sysPrompt, onSelect: () => openSystemPromptDialog() }, { divider: true });
    const footer = [];
    if (on.size) footer.push({ label: '全部關閉', onSelect: () => setChatExtensions([]) });
    footer.push({ label: '載入 skill 資料夾…', onSelect: () => importSkill('folder') });
    footer.push({ label: '載入 .md 檔案…', onSelect: () => importSkill('file') });
    footer.push({ label: '載入 MCP JSON…', onSelect: () => $('#btnExtLoad').click() });
    footer.push({ label: '管理 skill…', onSelect: () => { openSettings(); $('#extSection').open = true; $('#extSection').scrollIntoView({ block: 'nearest' }); } });
    openMenu($('#extBtn'), { title: 'skill（只套用這段對話，可複選）', items, footer });
  }

  function renderExtSettings() {
    const box = $('#extList');
    if (!box) return;
    box.innerHTML = '';
    for (const p of state.extensions?.removed || []) {
      const restore = h('button', { type: 'button', class: 'btn-small', text: `載入內建：${p.name}` });
      restore.onclick = async () => {
        try { await api.saveExtensions({ restoreBuiltin: p.id }); state.settings = await api.getSettings(); await loadExtensions(); }
        catch (e) { toast(e.message, 6000); }
      };
      box.append(restore);
    }
    const packs = extPacks();
    if (!packs.length) { box.append(h('p', { class: 'set-note', text: '尚未載入 skill；System Prompt 仍可直接使用。按下方按鈕載入 skill 資料夾或 Markdown 檔案。' })); return; }
    for (const p of packs) {
      const wrap = h('div', { class: 'ext-item' });
      wrap.append(h('div', { class: 'ext-top' },
        h('span', {}, h('span', { class: 'ext-name', text: p.name }),
          h('span', { class: 'ext-tag cat', text: p.category || '自訂' }),
          h('span', { class: `ext-tag ${p.available ? 'ok' : 'no'}`, text: p.available ? '已就緒' : '未安裝' }),
          h('span', { class: 'ext-tag', text: p.kind === 'prompt' ? 'Markdown 提示' : p.kind === 'prime' ? '代理' : p.kind==='ragthoven'?'幽默工具鏈':p.kind==='scriptDoctor'?'劇本工具鏈':p.kind==='companion'?'陪伴角色':p.kind==='harness'?'流程腳本':p.kind==='searxng'?'元搜尋':'MCP' }))));
      wrap.append(h('p', { class: 'ext-sum', text: p.summary }));
      if (p.detail) wrap.append(h('p', { class: 'ext-note', text: p.detail }));
      wrap.append(h('p', { class: 'ext-note', text: p.note }));
      const placeholder = p.kind === 'prime' ? 'prime-agent 執行檔路徑（留空自動尋找）'
        : p.id === 'zenith' ? 'Zenith 專案資料夾（含 pyproject.toml；留空自動尋找）'
                : '執行檔路徑（留空自動尋找）';
      const pathInput = h('input', { type: 'text', placeholder, value: (state.settings?.extensions?.config || {})[p.id]?.path || '' });
      const savePath = debounce(async () => {
        const r = await api.saveExtensions({ config: { [p.id]: { path: pathInput.value.trim() } } });
        state.extensions = r;
        state.settings = await api.getSettings();
      }, 500);
      pathInput.addEventListener('input', savePath);
      const status = h('span', { class: 'ext-note' });
      const test = h('button', { type: 'button', class: 'btn-small', text: p.kind === 'prompt' ? '檢查提示' : '測試連線' });
      test.onclick = async () => {
        status.textContent = '連線中…';
        try { const r = await api.testExtension(p.id); status.textContent = r.message; }
        catch (e) { status.textContent = e.message; }
      };
      const row = h('div', { class: 'ext-row' }, pathInput, test);
      pathInput.hidden = p.kind === 'prompt' || p.kind === 'scriptDoctor' || p.kind === 'companion' || p.kind === 'harness' || p.kind === 'searxng';
      {
        const del = h('button', { type: 'button', class: 'btn-small', text: '移除' });
        del.onclick = async () => {
          try {
            state.extensions = await api.saveExtensions(p.custom ? { removeCustom: p.id } : { removeBuiltin: p.id });
            const remaining = activeExtensions().filter(id => id !== p.id);
            await setChatExtensions(remaining);
            state.settings = await api.getSettings();
            renderExtSettings(); renderExtPill();
          } catch (e) { status.textContent = e.message; }
        };
        row.append(del);
      }
      // 各工具包自己的選項：Zenith 要選派工的 worker，Prime Agent 要選用哪家模型
      const cfgNow = () => (state.settings?.extensions?.config || {})[p.id] || {};
      const saveCfg = async (patch) => {
        state.extensions = await api.saveExtensions({ config: { [p.id]: patch } });
        state.settings = await api.getSettings();
      };
      if (p.kind === 'companion') {
        const nameInput = h('input', { type: 'text', placeholder: '角色名字（留空用預設「葉澄」）', value: cfgNow().name || '', 'aria-label': '陪伴角色名字' });
        nameInput.addEventListener('input', debounce(() => saveCfg({ name: nameInput.value.trim().slice(0, 20) }), 500));
        const view = h('pre', { class: 'ext-note companion-view', hidden: true });
        const show = h('button', { type: 'button', class: 'btn-small', text: '她記得哪些事' });
        show.onclick = async () => {
          if (!view.hidden) { view.hidden = true; return; }
          try { const r = await api.companionInspect(); view.textContent = r.text; view.hidden = false; }
          catch (e) { status.textContent = e.message; }
        };
        const wipe = h('button', { type: 'button', class: 'btn-small danger', text: '清除記憶重來' });
        wipe.onclick = async () => {
          try {
            const r = await api.companionReset();
            if (r.cancelled) return;
            status.textContent = r.removed ? `已清除，下一次聊天會從剛認識開始（舊資料備份在 ${r.backup}）` : '她本來就還沒有任何記憶。';
            view.hidden = true;
          } catch (e) { status.textContent = e.message; }
        };
        const edit = h('button', { type: 'button', class: 'btn-small primary', text: '編輯角色與 Prompt…', onclick: () => openCompanionEditor(() => { nameInput.value = cfgNow().name || ''; }) });
        wrap.append(h('div', { class: 'ext-row' }, h('span', { class: 'ext-note', text: '名字：' }), nameInput, edit, show, wipe), view,
          h('p', { class: 'ext-note', text: '用法：在對話輸入框下方的「能力擴充」勾選「長期陪伴角色」，這段對話的每則訊息都會由她直接回覆（其他擴充這時不會使用）。改名字不會清掉記憶。' }));
      }
      if (p.kind === 'searxng') {
        const install = h('button', { type: 'button', class: 'btn-small primary', text: p.available && !cfgNow().url ? '更新 SearXNG' : '安裝 SearXNG' });
        const open = h('button', { type: 'button', class: 'btn-small', text: '開啟搜尋頁', disabled: !p.available });
        const logBox = h('pre', { class: 'ext-note companion-view searxng-log', hidden: true });
        install.onclick = async () => {
          install.disabled = true; logBox.hidden = false; logBox.textContent = '';
          const off = api.onSearxngLog((line) => { logBox.textContent = `${logBox.textContent}${line}\n`.split('\n').slice(-14).join('\n'); logBox.scrollTop = logBox.scrollHeight; });
          status.textContent = '安裝中，第一次約 1～3 分鐘…';
          try {
            const r = await api.searxngInstall();
            status.textContent = `完成：SearXNG ${r.version} 在 ${r.url} 執行中（${r.engines} 個引擎）。`;
            state.extensions = await api.listExtensions();
            renderExtSettings(); renderExtPill();
          } catch (e) { status.textContent = `安裝失敗：${e.message}`; }
          finally { off(); install.disabled = false; }
        };
        open.onclick = async () => { try { status.textContent = `已在瀏覽器開啟 ${await api.searxngOpen()}`; } catch (e) { status.textContent = e.message; } };
        const urlInput = h('input', { type: 'text', placeholder: '現成的 SearXNG 網址（留空＝用本機安裝的）', value: cfgNow().url || '', 'aria-label': 'SearXNG 網址' });
        urlInput.addEventListener('input', debounce(() => saveCfg({ url: urlInput.value.trim() }), 600));
        const portInput = h('input', { type: 'number', min: '1024', max: '65535', placeholder: '本機埠（預設 8898）', value: cfgNow().port || '', 'aria-label': 'SearXNG 本機埠', style: 'max-width:11em' });
        portInput.addEventListener('input', debounce(() => saveCfg({ port: portInput.value.trim() }), 600));
        const engInput = h('input', { type: 'text', placeholder: '窮搜預設引擎，逗號分隔（留空＝google, bing, yahoo, yandex, duckduckgo web, brave, qwant, mwmbl, yep, naver, wikipedia, google cse）', value: cfgNow().deepEngines || '', 'aria-label': '窮搜預設引擎' });
        engInput.addEventListener('input', debounce(() => saveCfg({ deepEngines: engInput.value.trim() }), 600));
        wrap.append(h('div', { class: 'ext-row' }, install, open), logBox,
          h('div', { class: 'ext-row' }, urlInput, portInput), h('div', { class: 'ext-row' }, engInput),
          h('p', { class: 'ext-note', text: '用法：在對話輸入框下方的「擴充」勾選「SearXNG」。一般查詢用 searxng_search；要找齊資料時模型會用 searxng_deep_search（多種寫法 × 多頁 × 十幾個引擎，合併去重、依被幾個引擎找到排序）。同時勾 Scrapling，模型會先搜再抓全文。部分引擎（例如 Brave、Qwant、百度）偶爾會限流或要驗證碼，SearXNG 會自動暫停它們，結果照樣從其他引擎來；回覆裡會列出哪些引擎被擋。' }));
      }
      if (p.kind === 'harness') {
        const sel = h('select', { 'aria-label': '預設 Harness 腳本' }, h('option', { value: '', text: '讀取中…' }));
        refreshHarnessCache().then((list) => {
          sel.innerHTML = '';
          const curDef = cfgNow().defaultScript || '範本-通用流程.txt';
          for (const x of list) sel.append(h('option', { value: x.file, text: `${x.name}${x.ok ? '' : '（格式有錯）'}` }));
          sel.value = list.some((x) => x.file === curDef) ? curDef : (list[0]?.file || '');
        });
        sel.onchange = async () => { try { await saveCfg({ defaultScript: sel.value }); renderExtPill(); } catch (e) { status.textContent = e.message; } };
        wrap.append(h('div', { class: 'ext-row' }, h('span', { class: 'ext-note', text: '預設腳本：' }), sel,
          h('button', { type: 'button', class: 'btn-small primary', text: '管理腳本…', onclick: () => openHarnessManager(sel.value) }),
          h('button', { type: 'button', class: 'btn-small', text: '開啟腳本資料夾', onclick: () => api.harnessOpen('', false).catch((e) => { status.textContent = e.message; }) })),
        h('p', { class: 'ext-note', text: '用法：在對話輸入框下方的「擴充」勾選「自訂 Harness」，再點它下面那一列「腳本：…」選這段對話要用的腳本，或選「依目標自動建立新腳本」。沒有另外選的對話用這裡的預設腳本。勾選時這段對話由腳本接管回覆（其他擴充這時不會使用）。' }));
      }
      if (p.kind === 'prime') {
        const mode=h('select',{'aria-label':'代理模型來源'});
        mode.append(h('option',{value:'conversation',text:'沿用目前對話模型與登入方式（預設）'}),h('option',{value:'native',text:'原生 Prime Agent：獨立 API 模型與替補'}));
        mode.value=cfgNow().mode==='native'?'native':'conversation';
        mode.onchange=async()=>{try{await saveCfg({mode:mode.value});renderExtSettings();}catch(error){status.textContent=error.message;}};
        wrap.append(h('div',{class:'ext-row'},h('span',{class:'ext-note',text:'代理模型：'}),mode),h('p',{class:'ext-note',text:'沿用模式由工作台代理引擎執行：你在對話選 GPT、Claude、DeepSeek 或 Gemini，就使用同一模型與登入方式；切換後下一次派工生效。原生模式則使用 PrimeIntellect 的 Prime Agent。'}));
        row.hidden=mode.value!=='native';
      }
      if (p.id === 'zenith' || p.kind === 'prime') {
        const opts = p.id === 'zenith'
          ? [['inherit', '沿用目前對話模型與登入方式（預設）'], ['claude', 'Claude Code'], ['codex', 'Codex']]
          : [['', '自動（挑第一組有金鑰的）'], ['anthropic', 'Claude（Anthropic 金鑰）'], ['google', 'Gemini 金鑰'], ['deepseek', 'DeepSeek 金鑰'], ['openai', 'OpenAI 金鑰'], ['xai', 'Grok（xAI 金鑰）']];
        const sel = h('select', {});
        for (const [v, t] of opts) sel.append(h('option', { value: v, text: t }));
        // 舊設定可能只存了 claude／codex；其餘一律當成沿用
        sel.value = (p.id === 'zenith' ? (cfgNow().worker === 'claude' || cfgNow().worker === 'codex' ? cfgNow().worker : 'inherit') : cfgNow().provider || '');
        sel.onchange = () => saveCfg(p.id === 'zenith' ? { worker: sel.value } : { provider: sel.value });
        const label = h('span', { class: 'ext-note', text: p.id === 'zenith' ? '派工用的 worker：' : '使用哪組金鑰：' });
        const extra = h('div', { class: 'ext-row' }, label, sel);
        if(p.kind==='prime') extra.hidden=cfgNow().mode!=='native';
        if (p.kind === 'prime') {
          const modelInput = h('input', { type: 'text', placeholder: '模型（留空用它的預設）', value: cfgNow().model || '' });
          modelInput.addEventListener('input', debounce(() => saveCfg({ model: modelInput.value.trim() }), 500));
          extra.append(modelInput);
        }
        wrap.append(extra);
        if (p.id === 'zenith') wrap.append(h('p', { class: 'ext-note', text: 'Zenith 靠 ACP 轉接器派工（Claude Code／Codex）。沿用模式下，對話用 DeepSeek、Gemini、Grok 或 GPT API 時，worker 由 Claude Code 執行但模型換成你選的那一個：DeepSeek 走官方 Anthropic 相容端點，其餘走工作台本機轉譯代理，費用算在該供應商的金鑰上。' }));
        if (p.kind === 'prime') {
          const fallbackBox = h('div', { class:'prime-fallback' });
          fallbackBox.hidden=cfgNow().mode!=='native';
          const enabled = h('input', {type:'checkbox', 'aria-label':'啟用 Prime Agent 自動替補'});
          enabled.checked = cfgNow().fallbackEnabled === true;
          const rows = h('div', {});
          let entries = (cfgNow().fallbackModels || []).map(entry => ({...entry}));
          const providerMap = {anthropic:'claude',google:'gemini',deepseek:'deepseek',openai:'gpt',xai:'grok'};
          // Prime Agent 只認得它自己載入的模型（有金鑰的供應商才會有），
          // 所以優先用它回報的清單；問不到時才退回工作台的型錄。
          const probe = {models:null, message:'', loading:false};
          const modelsFor = (prov) => {
            const live = (probe.models || []).filter(m => m.provider === prov).map(m => m.id);
            return live.length ? live : catalogOf(providerMap[prov]).models;
          };
          const renderRows = () => {
            rows.replaceChildren();
            entries.forEach((entry, index) => {
              const provider = h('select', {'aria-label':`替補 ${index + 1} 供應商`});
              for (const [value, title] of opts.filter(([value]) => value)) provider.append(h('option', {value, text:title}));
              provider.value = entry.provider;
              const listId = `prime-fallback-models-${index}`;
              const models = h('datalist', {id:listId});
              const warn = h('span', {class:'ext-note'});
              const checkModel = () => {
                if (!probe.models || !entry.model) { warn.textContent = ''; return; }
                const known = modelsFor(entry.provider);
                const has = (probe.models || []).some(m => m.provider === entry.provider);
                warn.textContent = known.includes(entry.model) ? '✓'
                  : has ? '⚠ Prime Agent 沒有這個模型' : '⚠ 這家還沒有 API 金鑰，Prime Agent 看不到它的模型';
              };
              const updateModels = () => {
                models.replaceChildren(...modelsFor(entry.provider).map(model => h('option', {value:model})));
                checkModel();
              };
              const model = h('input', {type:'text',list:listId,value:entry.model,placeholder:'選擇或輸入模型 ID','aria-label':`替補 ${index + 1} 模型`});
              provider.onchange = () => { entry.provider = provider.value; entry.model = ''; model.value = ''; updateModels(); };
              model.oninput = () => { entry.model = model.value.trim(); checkModel(); };
              updateModels();
              const up = h('button', {type:'button',class:'btn-small',text:'上移','aria-label':`上移替補 ${index + 1}`});
              const down = h('button', {type:'button',class:'btn-small',text:'下移','aria-label':`下移替補 ${index + 1}`});
              const remove = h('button', {type:'button',class:'btn-small',text:'移除','aria-label':`移除替補 ${index + 1}`});
              up.disabled = index === 0; down.disabled = index === entries.length - 1;
              up.onclick = () => { [entries[index-1],entries[index]] = [entries[index],entries[index-1]]; renderRows(); };
              down.onclick = () => { [entries[index+1],entries[index]] = [entries[index],entries[index+1]]; renderRows(); };
              remove.onclick = () => { entries.splice(index,1); renderRows(); };
              rows.append(h('div', {class:'ext-row'}, h('span',{text:`${index+1}.`}),provider,model,models,up,down,remove,warn));
            });
          };
          const add = h('button', {type:'button',class:'btn-small',text:'新增替補模型'});
          const save = h('button', {type:'button',class:'btn-small',text:'儲存替補設定'});
          const feedback = h('span', {class:'ext-note',role:'status'});
          const refresh = h('button', {type:'button',class:'btn-small',text:'讀取可用模型'});
          refresh.onclick = async () => {
            if (probe.loading) return;
            probe.loading = true; refresh.disabled = true; feedback.textContent = '正在問 Prime Agent 有哪些模型…';
            try {
              const r = await api.primeModels();
              probe.models = r.ok ? r.models : null;
              feedback.textContent = r.ok
                ? (r.models.length ? `Prime Agent 目前載入 ${r.models.length} 個模型（${r.providers.join('、')}）。下拉選單已換成這份清單。`
                  : 'Prime Agent 沒有載入任何模型：請先在「API 設定」填好至少一組 API 金鑰。')
                : r.message;
            } catch (error) { feedback.textContent = error.message; }
            finally { probe.loading = false; refresh.disabled = false; renderRows(); }
          };
          add.onclick = () => {
            if (entries.length >= 8) { feedback.textContent = '最多 8 個替補模型'; return; }
            entries.push({provider:'deepseek',model:''}); renderRows();
          };
          save.onclick = async () => {
            if (enabled.checked && !entries.length) { feedback.textContent = '請先新增至少一個替補模型'; return; }
            save.disabled = true;
            try {
              await saveCfg({fallbackEnabled:enabled.checked,fallbackModels:entries.map(entry=>({...entry}))});
              feedback.textContent = '已儲存，下次執行任務生效';
            } catch (error) { feedback.textContent = error.message; }
            finally { save.disabled = false; }
          };
          fallbackBox.append(h('label',{},enabled,h('span',{text:'啟用自動替補（依下列順序）'})),
            h('p',{class:'ext-note',text:'額度不足、限流或模型不可用時，依序切換並沿用任務進度。各供應商使用工作台已設定的 API 金鑰；這裡不使用 Codex／Claude Code 訂閱帳號。按「讀取可用模型」可換成 Prime Agent 實際載入的清單——沒有金鑰的供應商在它那邊是看不到任何模型的，填了也只會被跳過。'}),
            rows,h('div',{class:'ext-row'},add,refresh,save,feedback));
          renderRows(); wrap.append(fallbackBox);
        }
      }
      wrap.append(row, status);
      box.append(wrap);
    }
  }

  function openExtDialog() {
    $('#xName').value = ''; $('#xPrefix').value = ''; $('#xCommand').value = ''; $('#xArgs').value = ''; $('#xUrl').value = '';
    $('#xTransport').value = 'stdio';
    $('#xError').hidden = true;
    syncExtDialog();
    $('#extDlg').showModal();
    $('#xName').focus();
  }
  function syncExtDialog() {
    const http = $('#xTransport').value === 'http';
    $('#xCmdField').hidden = http; $('#xArgsField').hidden = http; $('#xUrlField').hidden = !http;
  }

  // ---- 側欄專案管理 ----
  function knownProjects() {
    const { projects, roots } = sidebarMaps();
    const map = new Map();
    const add = (dir, name, title) => {
      const key = dir;
      if (!map.has(key)) map.set(key, { dir, name, title, count: 0 });
      else if (title && !map.get(key).title) map.get(key).title = title;
    };
    for (const it of state.sidebar.items || []) {
      const g = groupFor(it, projects, roots);
      add(g.dir, g.name, g.title);
      map.get(g.dir).count += 1;
    }
    for (const r of state.sidebar.recentProjects || []) add(normDir(r.path), r.name || baseName(r.path), r.path);
    for (const pr of state.sidebar.projects || []) { const g = projectGroup(pr); add(g.dir, g.name, g.title); }
    for (const dir of state.settings.sidebarProjects || []) if (!map.has(dir)) add(dir, dir ? baseName(dir) : '未指定資料夾', dir);
    for (const dir of state.settings.removedProjects || []) map.delete(dir); // 移除過的不再列出，除非使用者自己加回來
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function renderProjectsDialog() {
    const box = $('#projectsList');
    box.innerHTML = '';
    const all = !Array.isArray(state.settings.sidebarProjects);
    const shown = new Set(state.settings.sidebarProjects || []);
    const list = knownProjects();
    if (!list.length) { box.append(h('p', { class: 'set-note', text: '還沒有任何專案。開一段新對話並選擇資料夾，或按下面的「加入其他資料夾」。' })); }
    for (const item of list) {
      const chk = h('input', { type: 'checkbox' });
      chk.checked = all || shown.has(item.dir);
      chk.onchange = async () => {
        const base = new Set(Array.isArray(state.settings.sidebarProjects) ? state.settings.sidebarProjects : list.map((x) => x.dir));
        chk.checked ? base.add(item.dir) : base.delete(item.dir);
        state.settings = await api.saveSettings({ sidebarProjects: [...base] });
        renderSidebar(); renderProjectsDialog();
      };
      const del = h('button', { type: 'button', class: 'btn-small', text: '移除', title: '從側欄與這份清單移除（對話不會被刪除）' });
      del.onclick = async () => { await removeProject(item.dir); renderProjectsDialog(); };
      box.append(h('div', { class: 'proj-row' },
        h('label', {}, chk, h('span', { class: 'p-text' },
          h('span', { class: 'p-name', text: item.name }),
          h('span', { class: 'p-path', text: item.title || '（沒有指定資料夾）' }))),
        h('span', { class: 'p-count', text: item.count ? `${item.count} 則` : '' }), del));
    }
    const removed = (state.settings.removedProjects || []).filter(Boolean);
    if (removed.length) {
      box.append(h('p', { class: 'set-note', text: `已移除的專案（${removed.length}）：對話都還在，按「加回來」就會重新出現。` }));
      for (const dir of removed) {
        const back = h('button', { type: 'button', class: 'btn-small', text: '加回來' });
        back.onclick = async () => { await restoreProject(dir); renderProjectsDialog(); };
        box.append(h('div', { class: 'proj-row removed' },
          h('span', { class: 'p-text' },
            h('span', { class: 'p-name', text: baseName(dir) || dir }),
            h('span', { class: 'p-path', text: dir })), back));
      }
    }
  }

  async function openProjectsDialog() {
    if (!state.sidebar.items) await refreshSidebar();
    renderProjectsDialog();
    $('#projectsDlg').showModal();
  }

  // ---- 通用彈出選單（往上展開，跟 Codex 的輸入區選單一樣） ----
  let openPop = null;
  function closeMenu() {
    if (!openPop) return;
    openPop.el.remove();
    document.removeEventListener('mousedown', openPop.outside, true);
    document.removeEventListener('keydown', openPop.keys, true);
    openPop.anchor.classList.remove('open');
    openPop = null;
  }

  function openMenu(anchor, { title, items, inputPlaceholder, onInput, searchPlaceholder, footer }) {
    if (openPop && openPop.anchor === anchor) { closeMenu(); return; }
    closeMenu();
    const el = h('div', { class: 'pop', role: 'menu' });
    if (title) el.append(h('div', { class: 'pop-title', text: title }));
    let searchInput = null;
    if (searchPlaceholder) {
      searchInput = h('input', { class: 'pop-input', placeholder: searchPlaceholder, spellcheck: 'false' });
      el.append(searchInput);
    }
    const list = h('div', { class: 'pop-list' });
    const buttons = [];
    for (const it of items) {
      if (it.divider) { list.append(h('div', { class: 'pop-div' })); continue; }
      if (it.heading) { list.append(h('div', { class: 'pop-head', text: it.heading })); continue; }
      const b = h('button', {
        type: 'button', role: 'menuitemradio', class: `pop-item${it.checked ? ' checked' : ''}${it.danger ? ' danger' : ''}`,
        'aria-checked': String(!!it.checked),
        onclick: () => { closeMenu(); it.onSelect && it.onSelect(); },
      },
      h('span', { class: 'pop-check', text: it.checked ? '✓' : '' }),
      h('span', { class: 'pop-text' }, h('span', { class: 'pop-label', text: it.label }), it.desc ? h('span', { class: 'pop-desc', text: it.desc }) : null));
      buttons.push(b);
      list.append(b);
    }
    el.append(list);
    if (searchInput) searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      for (const b of buttons) b.hidden = !!q && !b.textContent.toLowerCase().includes(q);
    });
    let input = null;
    if (inputPlaceholder) {
      input = h('input', { class: 'pop-input', placeholder: inputPlaceholder, spellcheck: 'false' });
      input.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
        if (e.key === 'Enter' && input.value.trim() && !e.isComposing) { const v = input.value.trim(); closeMenu(); onInput(v); }
      });
      el.append(input);
    }
    if (footer) for (const f of footer) el.append(h('button', { type: 'button', class: 'pop-foot', text: f.label, onclick: () => { closeMenu(); f.onSelect(); } }));
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const spaceAbove = r.top;
    if (spaceAbove > el.offsetHeight + 12 || spaceAbove > window.innerHeight / 2) el.style.bottom = `${window.innerHeight - r.top + 6}px`;
    else el.style.top = `${r.bottom + 6}px`;
    anchor.classList.add('open');
    const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    const keys = (e) => {
      if (inputComposition.isComposing(e)) return;
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i <= 0 ? buttons.length - 1 : i - 1);
        buttons[next] && buttons[next].focus();
      }
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', keys, true);
    openPop = { el, anchor, outside, keys };
    const checked = buttons.find((b) => b.classList.contains('checked')) || buttons[0];
    if (searchInput) searchInput.focus();
    else if (checked) { checked.scrollIntoView({ block: 'nearest' }); checked.focus(); }
  }

  async function openSourceProjectPicker(source) {
    try {
      const projects = await api.sourceProjects(source);
      const label = source === 'codex' ? 'Codex' : 'Claude Code';
      if (!projects.length) { toast(`找不到 ${label} 的本機專案紀錄`, 6000); return; }
      const selected = state.settings?.sidebarSourceProjects;
      const items = projects.map((project) => ({
        label: project.name,
        desc: `${project.count} 段可選對話・${project.path || project.key}`,
        checked: (state.settings?.sidebarSources || []).includes(source) && (!selected || (selected[source] || []).includes(project.key)),
        onSelect: () => openSourceConversationPicker(source, project),
      }));
      openMenu($('#btnImport'), { title: `先選擇 ${label} 專案`, items, searchPlaceholder: '搜尋本機專案…' });
    } catch (e) { toast(e.message, 6000); }
  }
  async function openSourceConversationPicker(source, project) {
    try {
      const conversations = await api.sourceConversations(source, project.key);
      if (!conversations.length) { toast('這個專案裡找不到可載入的對話', 6000); return; }
      const selectedProjects = state.settings?.sidebarSourceProjects;
      const selectedConversations = state.settings?.sidebarSourceConversations;
      const projectLoaded = (state.settings?.sidebarSources || []).includes(source) &&
        (!selectedProjects || (selectedProjects[source] || []).includes(project.key));
      const items = conversations.map((chat) => ({
        label: chat.title,
        desc: `${project.name}・${chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : '日期不詳'}`,
        checked: projectLoaded && (!selectedConversations || (selectedConversations[source] || []).includes(chat.key)),
        onSelect: async () => {
          try {
            const result = await api.addSourceConversation(source, project.key, chat.key);
            state.settings = result.settings; state.sidebar = result.sidebar; renderSidebar();
            toast(`已載入「${chat.title}」，原始對話仍保留`);
          } catch (e) { toast(e.message, 6000); }
        },
      }));
      openMenu($('#btnImport'), { title: `選擇「${project.name}」內的對話`, items, searchPlaceholder: '搜尋對話標題…' });
    } catch (e) { toast(e.message, 6000); }
  }

  // force：重新讀一次（主程序在快取過期或 CLI 換版時會自動向伺服器要新清單）；refresh：不管快取，直接向伺服器要
  async function ensureCodexModels(force = false, refresh = false) {
    if (!state.codexModels || force || refresh) {
      try { state.codexModels = await api.codexModels({ refresh }); } catch { state.codexModels = { models: [], defaultModel: null }; }
    }
    return state.codexModels;
  }

  // Codex／GPT（Codex 帳號）模型選單底下的「重新取得」與「更新 Codex CLI」
  function codexModelFooter(cm, reopen) {
    const footer = [{ label: '向伺服器重新取得清單', onSelect: async () => { toast('正在向 Codex 伺服器取得最新的模型清單…'); const r = await ensureCodexModels(true, true); toast(r.refreshError ? `取得失敗，先用快取：${r.refreshError}` : `已取得 ${r.models.length} 個模型`); reopen(); } }];
    if (cm.cliUpdate) footer.unshift({ label: `更新 Codex CLI ${cm.cliVersion} → ${cm.cliUpdate}（新模型常要新版才會出現）`, onSelect: async () => {
      toast('正在更新 Codex CLI…（npm install -g @openai/codex@latest）', 60000);
      const r = await api.installCodex();
      state.codexInfo = null;
      if (!r.ok) { toast(`更新失敗：${r.message}`, 8000); return; }
      const m = await ensureCodexModels(true, true);
      toast(`Codex CLI 已更新，取得 ${m.models.length} 個模型`, 6000);
      reopen();
    } });
    return footer;
  }

  async function openModelMenu() {
    const p = state.provider;
    if (p === 'grokbot') { openGrokBotMenu($('#modelBtn')); return; }
    if (p === 'grokbuild') { await openGrokBuildMenu('model'); return; }
    const cfg = state.settings.providers[p];
    const anchor = $('#modelBtn');
    if (p === 'lmstudio') { await openLmStudioMenu(cfg, anchor); return; }
    if (p === 'antigravity') { await openAntigravityMenu('model'); return; }
    if (p === 'codex') {
      const cm = await ensureCodexModels(true);
      const items = [{ label: '預設模型', desc: cm.defaultModel ? `使用 Codex 設定的 ${cm.defaultModel}` : '跟 Codex App 一樣', checked: !cfg.model, onSelect: () => saveProvider('codex', { model: '' }) }, { divider: true }];
      for (const m of cm.models) items.push({ label: m.name, desc: m.name !== m.slug ? m.slug : null, checked: cfg.model === m.slug, onSelect: () => saveProvider('codex', { model: m.slug, effort: 'default' }) });
      if (cfg.model && !cm.models.some((m) => m.slug === cfg.model)) items.push({ label: cfg.model, desc: '自訂', checked: true, onSelect: () => {} });
      openMenu(anchor, { title: 'Codex 模型', items, inputPlaceholder: '輸入其他模型名稱，按 Enter', onInput: (v) => saveProvider('codex', { model: v }), footer: codexModelFooter(cm, openModelMenu) });
      return;
    }
    if (p === 'claude' && viaSub('claude')) {
      const cm = await api.claudeModels(false);
      const cur = cfg.cliModel || '';
      const items = [{ label: '沿用 Claude Code 預設模型', checked: !cur, onSelect: () => saveProvider('claude', { cliModel: '' }) }];
      items.push({ label: 'opusplan', desc: '規劃模式使用 Opus；執行時使用 Sonnet（Claude Code 官方別名）', checked: cur === 'opusplan', onSelect: () => saveProvider('claude', { cliModel: 'opusplan' }) });
      if (cm.models && cm.models.length) {
        items.push({ heading: 'Claude Code 可用的模型' });
        for (const m of cm.models.filter(m => m.slug !== 'opusplan')) items.push({ label: m.name, desc: `${m.slug}${m.resolved && m.resolved !== m.slug ? ` → ${m.resolved}` : ''}`, checked: cur === m.slug, onSelect: () => saveProvider('claude', { cliModel: m.slug }) });
      } else if (cm.error) {
        items.push({ label: '讀不到 Claude Code 的模型清單', desc: cm.error, onSelect: () => {} });
      }
      items.push({ heading: '指定完整模型名稱' });
      for (const id of catalogOf('claude').models) items.push({ label: id, checked: cur === id, onSelect: () => saveProvider('claude', { cliModel: id }) });
      openMenu($('#modelBtn'), { title: 'Claude 模型（Claude Code）', items, inputPlaceholder: '輸入其他模型名稱，按 Enter', onInput: (v) => saveProvider('claude', { cliModel: v }), footer: [{ label: '重新讀取清單', onSelect: async () => { await api.claudeModels(true); openModelMenu(); } }] });
      return;
    }
    if (p === 'gpt' && gptWeb()) {
      if(webPanelOpen)webDrafts.set(webDraftKey(),readWebForm());
      webPanelOpen=!webPanelOpen;renderComposerBar();return;
    }

    let catalog = catalogOf(p).models;
    let liveDeepseek = false, deepseekListError = '';
    const modelAccountSignature = JSON.stringify([cfg.activeKeyId,cfg.baseUrl]);
    if (p === 'deepseek' && cfg.hasKey) {
      try {
        const ids = await api.listModels(p);
        if (state.provider !== p || JSON.stringify([state.settings.providers[p]?.activeKeyId,state.settings.providers[p]?.baseUrl]) !== modelAccountSignature) return;
        state.settings.modelLists[p] = ids;
        catalog = ids;
        liveDeepseek = true;
      } catch (error) { deepseekListError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
      if (state.provider !== p || JSON.stringify([state.settings.providers[p]?.activeKeyId,state.settings.providers[p]?.baseUrl]) !== modelAccountSignature) return;
    }
    let codexCm = null;
    if (p === 'gpt' && cfg.via === 'codex') {
      codexCm = await ensureCodexModels(true);
      if (codexCm.models.length) catalog = codexCm.models.map((m) => m.slug);
    }
    const modelItemDesc = (prov, id) => {
      if (prov === 'deepseek') {
        if (id === 'deepseek-flash') return 'DeepSeek 4.1 Flash（官方 API ID）';
        if (id === 'deepseek-v4-pro') return 'DeepSeek V4 Pro 旗艦';
        if (id === 'deepseek-v4-flash-vision-exp') return 'DeepSeek V4 Flash 視覺實驗';
        if (id === 'deepseek-chat') return 'DeepSeek Chat（相容端點，自動導向最新版）';
        if (id === 'deepseek-reasoner') return 'DeepSeek Reasoner（思考推理端點）';
      }
      return null;
    };
    const fetched = (liveDeepseek ? [] : state.settings.modelLists[p] || []).filter((id) => !catalog.includes(id));
    const current = cfg.model || catalog[0];
    const items = [{ heading: liveDeepseek ? 'API 即時回傳的模型' : '常用' }];
    if (deepseekListError) items.push({label:'即時模型清單讀取失敗，顯示備用清單',desc:deepseekListError,onSelect:()=>{}});
    for (const id of catalog) items.push({ label: id, desc: modelItemDesc(p, id), checked: current === id, onSelect: () => saveProvider(p, { model: id }) });
    if (current && !catalog.includes(current) && !fetched.includes(current)) items.push({ label: current, desc: liveDeepseek ? '目前帳號 API 未列出，請重新選擇' : '自訂', checked: true, onSelect: () => {} });
    if (fetched.length) {
      items.push({ heading: '你的帳戶可用的其他模型' });
      for (const id of fetched.slice(0, 40)) items.push({ label: id, desc: modelItemDesc(p, id), checked: current === id, onSelect: () => saveProvider(p, { model: id }) });
    }
    openMenu(anchor, {
      title: `${LABELS[p]} 模型`, items,
      inputPlaceholder: '輸入其他模型名稱，按 Enter',
      onInput: (v) => saveProvider(p, { model: v }),
      footer: codexCm ? codexModelFooter(codexCm, openModelMenu) : cfg.hasKey ? [{ label: '從 API 更新模型清單', onSelect: refreshModelList }] : null,
    });
  }

  // LM Studio：每次打開都即時讀取，反映你在 LM Studio 剛載入／卸載的模型
  async function openLmStudioMenu(cfg, anchor) {
    let list = null; let error = '';
    try { list = await api.lmstudioModels(); }
    catch (e) { error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    const items = [{ label: '用 LM Studio 已載入的模型', desc: '自動挑目前載入的那一個；都沒載入時用清單第一個（LM Studio 會自動載入）', checked: !cfg.model, onSelect: () => saveProvider('lmstudio', { model: '' }) }, { divider: true }];
    if (error) items.push({ label: '讀不到 LM Studio 的模型', desc: error });
    else if (!list.length) items.push({ label: 'LM Studio 裡還沒有語言模型', desc: '先在 LM Studio 下載一個模型' });
    const loaded = (list || []).filter((m) => m.loaded === true);
    const others = (list || []).filter((m) => m.loaded !== true);
    const row = (m) => ({ label: m.id, desc: [m.loaded === true ? '已載入' : m.loaded === false ? '未載入（選了之後第一次送出會自動載入）' : '', m.tools === false ? '不支援工具呼叫，建議權限用「僅聊天」' : '', m.context ? `上下文 ${m.context}` : ''].filter(Boolean).join('・') || null, checked: cfg.model === m.id, onSelect: () => saveProvider('lmstudio', { model: m.id }) });
    if (loaded.length) { items.push({ heading: '已載入' }); loaded.forEach((m) => items.push(row(m))); }
    if (others.length) { items.push({ heading: loaded.length ? '其他已下載的模型' : '已下載的模型' }); others.slice(0, 60).forEach((m) => items.push(row(m))); }
    if (cfg.model && !(list || []).some((m) => m.id === cfg.model)) items.push({ label: cfg.model, desc: '自訂（LM Studio 目前沒有這個模型）', checked: true, onSelect: () => {} });
    openMenu(anchor, {
      title: 'LM Studio 模型', items,
      inputPlaceholder: '輸入模型 ID，按 Enter',
      onInput: (v) => saveProvider('lmstudio', { model: v }),
      footer: [{ label: '重新讀取', onSelect: () => openLmStudioMenu(state.settings.providers.lmstudio, anchor) }, { label: '改伺服器網址…', onSelect: () => { const c = state.settings.providers.lmstudio; openKeyEditor('lmstudio', (c.keys || []).find((k) => k.id === c.activeKeyId) || null); } }],
    });
  }

  async function refreshModelList() {
    const p = state.provider;
    toast('正在取得模型清單…');
    try {
      const ids = await api.listModels(p);
      state.settings = await api.getSettings();
      renderComposerBar();
      toast(`取得 ${ids.length} 個模型，再點一次模型按鈕就能選`);
    } catch (e) {
      toast(`取得模型清單失敗：${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 6000);
    }
  }

  async function openEffortMenu() {
    const p = state.provider;
    if (p === 'grokbot') return;
    if (p === 'grokbuild') { await openGrokBuildMenu('effort'); return; }
    const cfg = state.settings.providers[p];
    const anchor = $('#effortBtn');
    if (p === 'antigravity') { await openAntigravityMenu('effort'); return; }
    if (p === 'deepseek') {
      const opts = [['default', '預設', '由 DeepSeek 決定'], ['enabled', '開', '先思考再回答，比較慢但比較仔細'], ['disabled', '關', '直接回答，比較快']];
      openMenu(anchor, { title: 'DeepSeek 思考模式', items: opts.map(([v, l, d]) => ({ label: l, desc: d, checked: (cfg.thinking || 'default') === v, onSelect: () => saveProvider('deepseek', { thinking: v }) })) });
      return;
    }
    let levels;
    let field;
    if (p === 'gemini') {
      // Gemini 的 OpenAI 相容介面只接受 none / low / medium / high
      levels = ['none', 'low', 'medium', 'high'];
      field = 'reasoningEffort';
    } else if (p === 'grok') {
      // xAI 的 reasoning_effort 只有 low / medium / high
      levels = ['low', 'medium', 'high'];
      field = 'reasoningEffort';
    } else if (p === 'meta') {
      // Muse Spark 不接受 none（會回 400）
      levels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
      field = 'reasoningEffort';
    } else if (p === 'gpt' && gptWeb()) {
      toast('正在讀取網頁模型支援的推理強度…', 10000);
      try {
        const r = await api.gptWebModels({ model: cfg.webModel || '' });
        state.settings = await api.getSettings();
        if (state.provider !== 'gpt' || !gptWeb()) return;
        const current = state.settings.providers.gpt.webEffort || 'default';
        const items = [{ label: '沿用網頁', checked: current === 'default', onSelect: () => saveProvider('gpt', { webEffort: 'default' }) }];
        for (const e of r.efforts || []) items.push({ label: EFFORT_LABEL[e.id] || e.title || e.id, desc: e.title || e.id, checked: current === e.id, onSelect: () => saveProvider('gpt', { webEffort: e.id }) });
        if (!r.efforts?.length) items.push({ label: '目前模型沒有可調整的推理強度', desc: r.effortError || '沿用網頁設定' });
        openMenu(anchor, { title: 'ChatGPT 網頁版推理強度', items });
      } catch (e) { toast(`讀不到網頁推理選項：${e.message}`, 8000); }
      return;
    } else if (p === 'codex') {
      await ensureCodexModels();
      const info = codexModelInfo(cfg.model);
      levels = info && info.efforts.length ? info.efforts : ['low', 'medium', 'high', 'xhigh'];
      field = 'effort';
    } else if (p === 'claude') {
      if (!viaSub('claude')) { toast('Claude API 目前沒有推理強度可調'); return; }
      levels = ['low', 'medium', 'high', 'xhigh', 'max'];
      field = 'effort';
    } else if (cfg.via === 'codex') {
      await ensureCodexModels();
      const info = codexModelInfo(cfg.model);
      levels = info && info.efforts.length ? info.efforts : ['low', 'medium', 'high', 'xhigh'];
      field = 'reasoningEffort';
    } else {
      levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
      field = 'reasoningEffort';
    }
    const cur = cfg[field] || 'default';
    const items = [{ label: '預設', desc: p === 'codex' ? '跟 Codex 設定一樣' : '由模型決定', checked: cur === 'default', onSelect: () => saveProvider(p, { [field]: 'default' }) }, { divider: true }];
    for (const lv of levels) items.push({ label: EFFORT_LABEL[lv] || lv, desc: lv, checked: cur === lv, onSelect: () => saveProvider(p, { [field]: lv }) });
    openMenu(anchor, { title: '推理強度', items });
  }

  async function refreshGptWebAccounts() {
    state.gptWebAccounts = await api.gptWebAccounts();
    applySettings(await api.getSettings());
    renderComposerBar();
    return state.gptWebAccounts;
  }
  async function loginGptWebAccount(opts = {}) {
    if (state.gptWebLoginPending) { toast('登入視窗已開啟；可在連線選單取消。'); return; }
    state.gptWebLoginPending = true;
    toast(state.settings?.webWebsiteHttpOnly===true?'正在檢查已保存的 HTTP 登入，並同步王品瀏覽器登入資料…':'請在 ChatGPT 登入視窗完成登入；完成後會自動保存。', 8000);
    try {
      const r = await api.gptWebLogin(opts);
      await refreshGptWebAccounts();
      toast(r.ok ? '已保存 ChatGPT 帳號，下一次送出使用此帳號。' : (r.message || '已取消登入'), 6000);
    } catch (e) { toast(e.message, 6000); }
    finally { state.gptWebLoginPending = false; }
  }
  function manageGptWebAccounts(data) {
    const anchor = $('#keyBtn');
    openMenu(anchor, { title: '管理 ChatGPT 網頁帳號', items: data.accounts.map(a => ({
      label: a.name, checked: a.id === data.activeId,
      onSelect: () => openMenu(anchor, {
        title: a.name, inputPlaceholder: '輸入帳號名稱，按 Enter 改名',
        onInput: async name => {
          try { await api.gptWebRenameAccount({ id: a.id, name }); await refreshGptWebAccounts(); toast('帳號已改名'); }
          catch (e) { toast(e.message, 6000); }
        },
        items: [
          { label: '重新登入這個帳號…', onSelect: () => loginGptWebAccount({ id: a.id }) },
          { label: '移除此帳號與保存的登入資料', danger: true, desc: '不刪除對話；正在回覆或排隊的帳號須等工作結束。', onSelect: async () => {
            if (!window.confirm(`移除「${a.name}」及 App 保存的登入資料？對話紀錄會保留。`)) return;
            try { await api.gptWebRemoveAccount(a.id); await refreshGptWebAccounts(); toast('已移除帳號'); }
            catch (e) { toast(e.message, 6000); }
          } },
        ],
      }),
    })), footer: [{ label: '登入其他帳號…', onSelect: () => loginGptWebAccount({ newAccount: true, name: `ChatGPT 帳號 ${data.accounts.length + 1}` }) }] });
  }
  async function openKeyMenu(forceConnection) {
    const p = state.provider;
    if (p === 'grokbot') { openGrokBotMenu($('#keyBtn')); return; }
    if (p === 'grokbuild') { openGrokBuildMenu('account'); return; }
    if (p === 'codex') { openCodexAccountMenu(); return; }
    if (p === 'antigravity') { openAntigravityMenu('account'); return; }
    if (p === 'claude' && viaSub(p) && forceConnection !== true) { openClaudeAccountMenu(); return; }
    const cfg = state.settings.providers[p];
    const keys = cfg.keys || [];
    if (!keys.length && !subsOf(p).length) { openKeyEditor(p); return; }
    const viaCodex = viaSub(p);
    const cur = activeSub(p);
    const items = [];
    for (const sub of subsOf(p)) {
      items.push({
        label: sub.name, desc: sub.desc, checked: cur === sub,
        onSelect: async () => { applySettings(await api.setActiveKey({ provider: p, id: sub.id })); renderComposerBar(); toast(`${LABELS[p]} 改用 ${sub.name}`); },
      });
    }
    if (subsOf(p).length && keys.length) items.push({ heading: 'API 金鑰（另外計費）' });
    items.push(...keys.map((k) => ({
      label: k.name, desc: k.hint, checked: !viaCodex && k.id === cfg.activeKeyId,
      onSelect: async () => { applySettings(await api.setActiveKey({ provider: p, id: k.id })); renderComposerBar(); toast(`${LABELS[p]} 改用「${k.name}」`); },
    })));
    const footer = [{ label: '新增金鑰', onSelect: () => openKeyEditor(p) }, { label: '管理金鑰…', onSelect: openSettings }];
    if (p === 'gpt') {
      try {
        const data = await refreshGptWebAccounts();
        if (state.provider !== p) return;
        items.push({ heading: 'ChatGPT 網頁帳號' });
        items.push(...data.accounts.map(a => ({ label: a.name, desc: a.loggedIn ? '登入資料已保存' : '需要重新登入', checked: cfg.via === 'web' && a.id === data.activeId, onSelect: async () => {
          try { await api.gptWebSwitchAccount(a.id); applySettings(await api.setActiveKey({ provider: 'gpt', id: '__web__' })); await refreshGptWebAccounts(); toast('已切換；正在回覆的對話繼續用原帳號，下一次送出才套用。', 6000); }
          catch (e) { toast(e.message, 6000); }
        } })));
        footer.unshift(
          { label: '登入 ChatGPT／重新登入目前帳號…', onSelect: () => loginGptWebAccount() },
          { label: '登入其他帳號…', onSelect: () => loginGptWebAccount({ newAccount: true, name: `ChatGPT 帳號 ${data.accounts.length + 1}` }) },
          { label: '管理帳號（改名／移除）…', onSelect: () => manageGptWebAccounts(data) },
        );
        if (state.gptWebLoginPending) footer.unshift({ label: '取消正在進行的登入', onSelect: () => api.gptWebCancelLogin() });
      } catch (e) { toast(e.message, 6000); }
    }
    if (p === 'claude' && viaSub(p)) footer.unshift({ label: '切換 Claude Code 帳號…', onSelect: () => openClaudeAccountMenu() });
    openMenu($('#keyBtn'), { title: subsOf(p).length ? `${LABELS[p]} 連線方式` : `${LABELS[p]} 金鑰`, items, footer });
  }

  // ---- Google Antigravity：帳號、模型、推理強度都以 Antigravity App 回報的為準 ----
  let antigravityLoadEpoch = 0;
  let grokBuildLoadEpoch = 0;
  let grokBuildNeedsRefresh = false;
  async function loadGrokBuild(force = false) {
    if (!force && state.grokBuild?.ok && Date.now() - (state.grokBuild.fetchedAt || 0) < 60000) return state.grokBuild;
    const epoch = ++grokBuildLoadEpoch; let result;
    try { result = await api.grokBuildStatus({ force }); } catch (e) { result = { ok: false, installed: false, signedIn: false, models: [], message: String(e.message || e) }; }
    if (epoch !== grokBuildLoadEpoch) return state.grokBuild;
    state.grokBuild = { ...result, fetchedAt: Date.now() };
    renderComposerBar(); renderUsageLine();
    return state.grokBuild;
  }
  function grokBuildModelName(id) {
    if (!id) return '';
    return state.grokBuild?.models?.find(m => m.id === id)?.name || id;
  }
  async function grokBuildLogin() {
    const r = await api.grokBuildLogin();
    toast(r.message || (r.ok ? '已開啟登入視窗' : '無法開啟登入視窗'), 9000);
    grokBuildNeedsRefresh = true;
  }
  window.addEventListener('focus', () => { if (grokBuildNeedsRefresh && state.provider === 'grokbuild') { grokBuildNeedsRefresh = false; loadGrokBuild(true); } });
  async function openGrokBuildMenu(kind) {
    const anchor = kind === 'model' ? $('#modelBtn') : kind === 'effort' ? $('#effortBtn') : $('#keyBtn');
    const cfg = state.settings.providers.grokbuild || {};
    const st = await loadGrokBuild(kind === 'account');
    if (kind === 'account' || !st?.installed || !st?.signedIn) {
      const items = [];
      if (!st?.installed) items.push({ label: '安裝 Grok Build CLI…', desc: '開啟官方安裝視窗（x.ai/cli/install.ps1），安裝到使用者資料夾的 .grok\\bin', onSelect: async () => { const r = await api.grokBuildInstall(); toast(r.message, 9000); grokBuildNeedsRefresh = true; } });
      else items.push({ label: st.signedIn ? '重新登入 grok.com…' : '登入 Grok Build…', desc: '開啟 grok login 視窗，在瀏覽器完成 grok.com 登入', onSelect: () => grokBuildLogin() });
      items.push({ label: '重新讀取', desc: st?.message || (st?.version ? `CLI ${st.version}` : ''), onSelect: () => loadGrokBuild(true) });
      openMenu(anchor, { title: 'Grok Build 帳號', items });
      return;
    }
    const models = st.models || [];
    if (kind === 'model') {
      const items = [{ label: '沿用 Grok Build 預設', desc: st.current ? `目前預設：${grokBuildModelName(st.current)}` : '', checked: !cfg.model, onSelect: () => saveProvider('grokbuild', { model: '', effort: 'default' }) }, { divider: true }];
      for (const m of models) items.push({ label: m.name, desc: [m.id !== m.name ? m.id : '', m.description].filter(Boolean).join(' · '), checked: cfg.model === m.id, onSelect: () => saveProvider('grokbuild', { model: m.id, effort: 'default' }) });
      openMenu(anchor, { title: 'Grok Build 模型', items, inputPlaceholder: '輸入其他模型 ID，按 Enter', onInput: v => saveProvider('grokbuild', { model: v.trim(), effort: 'default' }), footer: [{ label: '重新讀取清單', onSelect: async () => { await loadGrokBuild(true); openGrokBuildMenu('model'); } }] });
      return;
    }
    const model = models.find(m => m.id === (cfg.model || st.current)) || models[0];
    const efforts = model?.efforts || [];
    const items = [{ label: '預設', desc: efforts.find(e => e.default)?.label || '', checked: !cfg.effort || cfg.effort === 'default', onSelect: () => saveProvider('grokbuild', { effort: 'default' }) }];
    for (const e of efforts) items.push({ label: EFFORT_LABEL[e.id] || e.label, desc: e.label, checked: cfg.effort === e.id, onSelect: () => saveProvider('grokbuild', { effort: e.id }) });
    openMenu(anchor, { title: `推理強度（${model?.name || 'Grok Build'}）`, items });
  }
  async function loadAntigravity(force = false) {
    if (!force && state.antigravity?.ok && Date.now() - (state.antigravity.fetchedAt || 0) < 60000) return state.antigravity;
    const epoch=++antigravityLoadEpoch;let result;
    try { result=await api.antigravityStatus({force}); } catch(e) {result={ok:false,message:String(e.message||e)};}
    if(epoch!==antigravityLoadEpoch)return state.antigravity;
    state.antigravity=result;
    renderComposerBar();
    renderUsageLine();
    return state.antigravity;
  }
  let antigravitySwitchPending = false;
  let antigravitySwitchNeedsRefresh = false;
  window.addEventListener('focus', () => {
    if (antigravitySwitchNeedsRefresh) loadAntigravity(true).then(st => { if (!st?.changing) antigravitySwitchNeedsRefresh = false; });
  });
  async function switchAntigravityAccount() {
    if (antigravitySwitchPending) return;
    antigravitySwitchPending = true;
    closeMenu();
    try {
      const r = await api.switchAntigravityAccount();
      if (!r.ok) { toast(r.message, 8000); return; }
      ++antigravityLoadEpoch;
      state.antigravity = null;
      renderComposerBar();
      toast('已開啟新增帳號：原帳號已保存並保持登入；在瀏覽器選另一個 Google 帳號並同意，其餘自動完成。', 16000);
      antigravitySwitchNeedsRefresh = true;
    } catch (e) { toast(String(e.message || e), 8000); }
    finally { antigravitySwitchPending = false; }
  }
  async function antigravityAccountItems(anchor, kind) {
    const list = await api.antigravityAccounts();
    const items = [];
    const accounts = (list && list.accounts) || [];
    if (accounts.length) {
      items.push({ heading: '已登入的帳號（點一下即可切換，不會登出其他帳號）' });
      for (const a of accounts) {
        items.push({
          label: a.email || a.name || '已登入帳號', desc: a.current ? '目前使用中' : [a.name, '點擊切換'].filter(Boolean).join('・'), checked: !!a.current,
          onSelect: async () => {
            if (a.current) return;
            closeMenu(); toast('正在切換帳號…', 3000);
            const r = await api.selectAntigravityAccount(a.id);
            if (!r.ok) { toast(r.message, 9000); return; }
            ++antigravityLoadEpoch; state.antigravity = null; renderComposerBar(); loadAntigravity(true);
            toast('已切換到 ' + (a.email || '所選帳號') + '；其他帳號仍保持登入。', 5000);
          }
        });
      }
      items.push({ heading: '管理' });
      for (const a of accounts.filter((x) => !x.current)) {
        items.push({ label: '移除 ' + (a.email || a.name), desc: '只移除保存的登入，不影響其他帳號', onSelect: async () => {
          closeMenu();
          if (!confirm('移除帳號「' + (a.email || a.name) + '」的保存登入？其他帳號不受影響。')) return;
          const r = await api.removeAntigravityAccount(a.id); toast(r.ok ? '已移除' : r.message, 5000);
        } });
      }
    }
    items.push({ label: '新增 Google 帳號…', desc: '自動登入並保存；原本的帳號保持登入，不執行登出', onSelect: switchAntigravityAccount });
    return items;
  }
  async function openAntigravityApp() {
    const r = await api.openAntigravity();
    toast(r.ok ? '已開啟登入終端；網站顯示的授權碼請貼回 CLI（不是 API Key）。完成後回來按「重新讀取」；失敗訊息會留在終端。' : r.message, 12000);
  }
  async function openAntigravityMenu(kind, force = false) {
    const anchor = kind === 'model' ? $('#modelBtn') : kind === 'effort' ? $('#effortBtn') : $('#keyBtn');
    if (openPop && openPop.anchor === anchor) { closeMenu(); return; }
    let st = state.antigravity; if (force || !st || !st.ok) st = await loadAntigravity(force);
    if (state.provider !== 'antigravity') return;
    const cfg = state.settings.providers.antigravity || {};
    const footer = [{ label: '重新讀取', onSelect: () => { closeMenu(); openAntigravityMenu(kind, true); } }, { label: '新增 Google 帳號…', onSelect: switchAntigravityAccount }, { label: '登入 CLI…', onSelect: openAntigravityApp }, { label: '安裝 CLI…', onSelect: async () => { toast('正在安裝官方 Antigravity CLI…', 10000); const r = await api.installAntigravity(); toast(r.ok ? 'CLI 已安裝；按登入完成首次授權' : r.message, 6000); } }];
    if (!st.ok) {
      const saved = await antigravityAccountItems(anchor, kind);
      openMenu(anchor, { title: 'Google Antigravity CLI', items: [{ label: 'CLI 尚未就緒', desc: st.message || '請先安裝 CLI 並完成首次登入', onSelect: openAntigravityApp }, ...saved], footer });
      return;
    }
    const quota = (list) => { const left = list.map((v) => v.remaining).filter((x) => typeof x === 'number'); return left.length ? `額度剩 ${Math.round(Math.min(...left) * 100)}%` : ''; };
    const fam = st.families.find((f) => f.name === cfg.model);
    if (kind === 'account') {
      const a = st.account;
      const accountItems = await antigravityAccountItems(anchor, kind);
      const hasList = accountItems.some((x) => x.checked);
      openMenu(anchor, { title: 'Antigravity 帳號', items: [
        ...(hasList ? [] : [{ label: a.email || '已登入', desc: [a.name, a.tier || a.plan].filter(Boolean).join('・') || null, checked: true, onSelect: () => {} }]),
        ...accountItems,
      ], footer });
      return;
    }
    if (kind === 'model') {
      const def = st.models.find((m) => m.id === st.defaultModel);
      const items = [{ label: '沿用 Antigravity 預設', desc: def ? def.label : null, checked: !cfg.model, onSelect: () => saveProvider('antigravity', { model: '' }) }, { heading: '你的 Antigravity 帳號可用的模型' }];
      for (const f of st.families) {
        const efforts = f.variants.map((v) => EFFORT_LABEL[v.effort] || v.effort).filter(Boolean).join('／');
        items.push({ label: f.name, desc: [efforts && `推理：${efforts}`, quota(f.variants)].filter(Boolean).join('・') || null, checked: cfg.model === f.name,
          onSelect: () => saveProvider('antigravity', { model: f.name, effort: f.variants.some((v) => v.effort === cfg.effort) ? cfg.effort : 'default' }) });
      }
      if (cfg.model && !fam) items.push({ label: cfg.model, desc: '帳號目前沒有這個模型，請改選其他模型', checked: true, onSelect: () => {} });
      openMenu(anchor, { title: 'Google Antigravity 模型', items, footer });
      return;
    }
    const target = fam || st.families.find((f) => f.variants.some((v) => v.id === st.defaultModel)) || st.families[0];
    const cur = cfg.effort || 'default';
    const items = [{ label: '預設', desc: '用「中」；沒有「中」時用最接近的等級', checked: cur === 'default', onSelect: () => saveProvider('antigravity', { effort: 'default' }) }, { divider: true }];
    for (const v of target ? target.variants : []) {
      if (v.effort) items.push({ label: EFFORT_LABEL[v.effort] || v.effort, desc: [v.label, quota([v])].filter(Boolean).join('・'), checked: cur === v.effort, onSelect: () => saveProvider('antigravity', { effort: v.effort }) });
    }
    if (items.length === 2) items.push({ label: '這個模型沒有可調整的推理強度', desc: target ? target.name : '' });
    openMenu(anchor, { title: `推理強度（${target ? target.name : 'Antigravity'}）`, items, footer });
  }

  async function setCwd(path) {
    if (normDir(currentProject()) === normDir(path)) return;
    const key=state.current?.key;
    if (state.current) {
      const result = await api.updateChat({ key, projectCwd: path });
      if (!result?.ok) { toast(result?.error || '無法變更對話所屬專案'); return; }
      if(state.current?.key!==key)return;
      state.current.originalProject = path;
      if (state.current.workspace) state.current.workspace = {...state.current.workspace, originalProject:path};
    } else {
      state.pendingCwd = path;
    }
    const projects = new Set(Array.isArray(state.settings.sidebarProjects) ? state.settings.sidebarProjects : []);
    if (path) projects.add(normDir(path));
    state.settings = await api.saveSettings({ defaultCwd: path, sidebarProjects: [...projects] });
    renderComposerBar();
    await refreshSidebar();
  }

  function openProjectMenu() {
    const cwd = normDir(currentProject());
    const items = [];
    const loaded = new Map();
    const add = (dir, name) => {
      if (!dir || loaded.has(normDir(dir))) return;
      loaded.set(normDir(dir), {path:dir, name:name || baseName(dir)});
    };
    add(currentProject());
    for (const dir of state.settings.sidebarProjects || []) add(dir);
    for (const project of state.sidebar.recentProjects || []) add(project.path, project.name);
    for (const project of state.sidebar.projects || []) add(project.root, project.name);
    if (!Array.isArray(state.settings.sidebarProjects)) {
      for (const item of state.sidebar.items || []) add(item.originalProject ?? item.cwd);
    }
    for (const {path:dir, name} of loaded.values()) {
      items.push({label:name, desc:dir, checked:normDir(dir) === cwd, onSelect:()=>setCwd(dir)});
    }
    items.push({label:'選擇其他專案資料夾…',onSelect:async()=>{try{const dir=await api.pickFolder(currentProject() || '');if(dir)await setCwd(dir);}catch(e){toast(e.message);}}});
    items.push({label:'不指定專案',checked:!cwd,onSelect:()=>setCwd('')});
    items.push({divider:true});
    items.push({heading:'對話工作資料夾'});
    items.push({label:'整理現有對話的資料夾索引',desc:'建立標題資料夾，不搬移現有檔案',onSelect:async()=>{try{const result=await api.organizeWorkspaces();toast(`已整理 ${result.created} 則；${result.errors.length} 則未完成`,6000);}catch(e){toast(e.message);}}});
    if (state.current) {
      const current = state.current;
      items.push({label:'開啟實際工作資料夾', desc:current.cwd, onSelect:()=>api.openPath(current.cwd)});
      if(current.workspace?.path && current.workspace.path!==current.cwd) items.push({label:'開啟對話專用資料夾',desc:current.workspace.path,onSelect:()=>api.openPath(current.workspace.path)});
      const project = currentProject();
      if(project) items.push({label:'開啟所屬專案資料夾',desc:project,onSelect:()=>api.openPath(project)});
      items.push({label:'建立此對話專用資料夾',desc:'保留原檔案與目前工作位置',onSelect:async()=>{try{const workspace=await api.organizeWorkspace({key:current.key}); if(state.current?.key===current.key)state.current.workspace=workspace; toast('對話工作資料夾已建立');}catch(e){toast(e.message);}}});
      items.push({label:'改在對話專用資料夾工作',desc:'影響之後送出，不搬移原檔案',onSelect:async()=>{try{const workspace=await api.organizeWorkspace({key:current.key,use:true});if(state.current?.key===current.key){state.current.workspace=workspace;state.current.cwd=workspace.path;renderComposerBar();}await refreshSidebar();}catch(e){toast(e.message);}}});
    }
    items.push({label:'新對話自動建立標題資料夾',checked:state.settings.autoChatWorkspace!==false,onSelect:async()=>{state.settings=await api.saveSettings({autoChatWorkspace:state.settings.autoChatWorkspace===false});}});
    openMenu($('#projectBtn'), {
      title: state.current ? '選擇此對話所屬專案' : '選擇新對話專案', items,
      footer: state.current ? [{label:'新對話使用其他專案…',onSelect:async()=>{await newChat();openProjectMenu();}}] : undefined,
    });
  }

  function openPermMenu() {
    const p = state.provider; const field = permissionField(p);
    if (p === 'grokbot') return;
    const list = permissionOptions(p);
    const cur = state.settings.providers[p][field] || list[0].value;
    const items = list.map((x) => ({ label: x.label, desc: x.desc, checked: cur === x.value, danger: ['danger-full-access', 'bypassPermissions'].includes(x.value), onSelect: () => saveProvider(p, { [field]: x.value }) }));
    if (p === 'deepseek' || p === 'gemini' || p === 'grok' || p === 'meta' || p === 'ablit' || p === 'lmstudio' || ((p === 'gpt' || p === 'claude') && !viaSub(p))) {
      const approval = state.settings.providers[p].approval || 'on-request';
      if (cur !== 'chat') {
        items.push({ heading: '執行指令前的同意' });
        for (const a of APPROVALS) items.push({ label: `指令：${a.label}`, desc: a.desc, checked: approval === a.value, onSelect: () => saveProvider(p, { approval: a.value }) });
      }
    }
    // 所有模型共用：刪除檔案一律要先經過使用者在同意卡片按「允許這次刪除」
    const noDelete = state.settings.guard?.noDelete === true;
    items.push({ heading: '檔案保護（所有模型通用）' });
    items.push({ label: `禁止刪除檔案，除非經我授權：${noDelete ? '開啟' : '關閉'}`, desc: noDelete ? '模型要刪檔時會先跳出同意卡片，每次都要你按允許；完全存取也一樣' : '開啟後，Codex、Claude Code 與所有 API 模型刪檔前都要你同意', checked: noDelete, onSelect: async () => { state.settings = await api.saveSettings({ guard: { noDelete: !noDelete } }); renderComposerBar(); toast(noDelete ? '已關閉刪除保護' : '已開啟：模型刪除檔案前會先問你', 3000); } });
    const browser = state.settings.browser || {};
    const appOn = browser.appEnabled === true;
    const braveOn = browser.braveEnabled === true;
    const wangpinOn = browser.wangpinEnabled === true;
    const conversationOn = browser.selectionMode === 'conversation';
    const masterOn = browser.enabled !== false;
    items.push({ heading: '瀏覽器（所有權限都可用）' });
    items.push({ label: `操作瀏覽器：${masterOn ? '開啟' : '關閉'}`, desc: masterOn ? (conversationOn ? '在對話說要用哪個瀏覽器即可' : wangpinOn ? '模型可以操作原本王品 Firefox 與現有登入分頁' : '模型可以使用外部 Brave 瀏覽器') : '模型不能控制任何瀏覽器', checked: masterOn, onSelect: () => saveBrowser({ enabled: !masterOn }) });
    items.push({label:'依對話指定瀏覽器',desc:'可指定 Chrome、Edge、Brave、Firefox、王品或內建；一般瀏覽器使用獨立登入',checked:conversationOn,onSelect:()=>saveBrowser({selectionMode:'conversation',choiceMigration:1})});
    // 相容測試字串：可同時勾兩個；兩者都勾時用 brave_*
    if (appOn) items.push({ label: '使用 App 內建瀏覽器', desc: 'browser_* 工具', checked: appOn && !conversationOn, onSelect: () => saveBrowser({ selectionMode:'fixed', appEnabled:true,braveEnabled:false,wangpinEnabled:false }) });
    items.push({ label: '固定使用外部 Brave', desc: (p === 'codex' || p === 'claude') && browser.preferBraveExtension !== false ? (p === 'claude' ? 'Claude 用 Brave 裡的 Claude 擴充與既有登入' : 'Codex 優先使用 Brave 的官方擴充與既有登入') : (browser.path || '自動尋找 Brave 安裝位置'), checked: braveOn && !conversationOn, onSelect: () => saveBrowser({ selectionMode:'fixed',enabled:true, braveEnabled:true, appEnabled:false,engine:'brave',wangpinEnabled:false }) });
    items.push({label:'固定操作王品瀏覽器（Firefox）',desc:'讀頁面、點擊、輸入；沿用原本王品 Firefox 的登入與分頁',checked:wangpinOn && !conversationOn,onSelect:()=>saveBrowser({selectionMode:'fixed',enabled:true,wangpinEnabled:true,braveEnabled:false,appEnabled:false})});
    if(wangpinOn && !conversationOn){
      items.push({label:'測試／開啟王品瀏覽器',desc:'連接現有 Firefox；首次啟用控制通道後須重開瀏覽器',onSelect:async()=>{try{await api.wangpinBrowserStart();toast('王品 Firefox 已連線；模型可沿用原本的登入與分頁。',6000);}catch(e){toast(String(e.message||e),8000);}}});
      items.push({label:'選擇王品 Firefox 執行檔…',desc:browser.wangpinPath||'優先使用 Programs\\WangpinBrowser 安裝版',onSelect:async()=>{try{const r=await api.wangpinBrowserChoose();if(!r.cancelled)await saveBrowser({wangpinPath:r.path});}catch(e){toast(String(e.message||e),8000);}}});
      items.push({label:'中斷王品瀏覽器連線',desc:'保留瀏覽器視窗、分頁與登入',onSelect:()=>api.wangpinBrowserStop().catch(e=>toast(e.message,6000))});
    }
    if (!conversationOn && braveOn && (p === 'codex' || p === 'claude')) items.push({ label: p === 'claude' ? 'Claude 優先使用 Brave 的 Claude 擴充' : 'Codex 優先使用 Brave 的官方擴充', desc: p === 'claude' ? '每回合自動開啟 Claude 擴充整合；擴充要登入同一個 Claude 帳號' : '每回合自動指定；需官方 ChatGPT／Codex 桌面 App 與 Brave 擴充已連線', checked: browser.preferBraveExtension !== false, onSelect: () => saveBrowser({ preferBraveExtension: browser.preferBraveExtension === false }) });
    if (!conversationOn && braveOn && ((p !== 'codex' && p !== 'claude') || browser.preferBraveExtension === false)) items.push({ label: '測試／開啟外部 Brave', desc: '確認除錯連線可用', onSelect: openBraveNow });
    if (!conversationOn && appOn) items.push({ label: '打開內建瀏覽器面板', desc: 'Ctrl+Shift+B', onSelect: () => toggleBrowser(true) });
    openMenu($('#permBtn'), { title: `${LABELS[p]} 使用權限`, items });
  }

  // ---------------- 送出與串流 ----------------
  function autosize() {
    const ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  // 排程保留文字快照，使用正式 startRun 和該對話的模型與 設定。
  const scheduleStorageKey = 'wangpin-scheduled-send-v1';
  let scheduledJob = null, scheduleWorking = false, scheduleLastTick = Date.now();
  function schedulePersist() {
    if (scheduledJob) localStorage.setItem(scheduleStorageKey, JSON.stringify(scheduledJob));
    else localStorage.removeItem(scheduleStorageKey);
  }
  function renderScheduledSend() {
    const btn = $('#btnSchedule'), status = $('#scheduleStatus');
    const active = scheduledJob && ['pending', 'dispatching'].includes(scheduledJob.status);
    btn.classList.toggle('has-schedule', !!active);
    btn.textContent = active ? '⏱ 已排程' : '⏱ 定時';
    $('#scheduleCancelJob').hidden = !scheduledJob || scheduledJob.status === 'dispatching';
    $('#scheduleRestoreText').hidden = !scheduledJob || ['pending', 'dispatching', 'sent'].includes(scheduledJob.status);
    $('#scheduleSave').disabled = !!active;
    if (!scheduledJob) status.textContent = '目前沒有排程。';
    else {
      const label = { pending:'等待送出', dispatching:'正在送出', sent:'已交給工作台送出', missed:'已錯過', failed:'送出失敗', uncertain:'送出狀態待確認' }[scheduledJob.status] || scheduledJob.status;
      status.textContent = `${label}：${new Date(scheduledJob.when).toLocaleString()}\n對話：${scheduledJob.key}\n內容：${scheduledJob.text.slice(0, 160)}${scheduledJob.text.length > 160 ? '…' : ''}${scheduledJob.reason ? '\n' + scheduledJob.reason : ''}`;
    }
  }
  function bindSchedule() {
    try { scheduledJob = ScheduledSend.restore(localStorage.getItem(scheduleStorageKey), Date.now()); schedulePersist(); }
    catch (error) { toast('無法讀取定時送出設定：' + error.message, 8000); }
    renderScheduledSend();
    $('#btnSchedule').onclick = () => { renderScheduledSend(); $('#scheduleDialog').showModal(); };
    $('#scheduleClose').onclick = () => $('#scheduleDialog').close();
    $('#scheduleRestoreText').onclick = () => {
      if (!scheduledJob || $('#input').value.trim()) { toast('請先清空目前輸入框，再取回排程文字。'); return; }
      $('#input').value = scheduledJob.text; draftEditRevision++; autosize(); $('#scheduleDialog').close();
    };
    $('#scheduleCancelJob').onclick = () => {
      if (!scheduledJob || scheduledJob.status === 'dispatching') return;
      if (!confirm('取消這筆排程？排程保存的文字將被移除。')) return;
      scheduledJob = null; schedulePersist(); renderScheduledSend();
    };
    $('#scheduleForm').onsubmit = (event) => {
      event.preventDefault();
      if (scheduledJob && ['pending', 'dispatching'].includes(scheduledJob.status)) return;
      if (pendingPastes || pendingAttachments.length) { toast('定時送出目前只支援文字，請先移除附件。', 6000); return; }
      const input = $('#input');
      try {
        const job = ScheduledSend.create(state.current?.key, input.value, new Date($('#scheduleTime').value).getTime(), Date.now());
        scheduledJob = job;
        try { schedulePersist(); } catch (err) { scheduledJob = null; throw err; }
        draftRevision++; draftEditRevision++; input.value = ''; drafts.delete(job.key); autosize();
        renderScheduledSend(); $('#scheduleDialog').close(); toast('已設定定時送出：' + new Date(job.when).toLocaleString(), 5000);
      } catch (error) { toast(error.message, 6000); }
    };
    setInterval(scheduleTick, 1000);
  }
  async function scheduleTick() {
    const now = Date.now(), gap = now - scheduleLastTick; scheduleLastTick = now;
    if (!scheduledJob || scheduledJob.status !== 'pending' || scheduleWorking || now < scheduledJob.when) return;
    if (gap > 60000 && now - scheduledJob.when > 60000) {
      scheduledJob.status = 'missed'; scheduledJob.reason = '工作台休眠或暫停後已錯過排程時間，沒有自動補送。';
      schedulePersist(); renderScheduledSend(); toast(scheduledJob.reason, 8000); return;
    }
    if (starting || state.runs.size || pendingPastes) return;
    const job = scheduledJob;
    scheduleWorking = true; starting = true;
    try {
      // 在送出前保存 dispatching，重啟時避免重複送出。
      job.status = 'dispatching'; schedulePersist(); renderScheduledSend();
      if (state.current?.key !== job.key) await openChat(job.key);
      if (state.current?.key !== job.key) throw new Error('無法切換到排程對話，請確認對話仍存在。');
      const ok = await startRun(job.text, state.provider, { attachmentIds: [] });
      job.status = ok ? 'sent' : 'failed';
      if (!ok) job.reason = '工作台未接受這次送出，請查看對話及通知。';
      schedulePersist(); renderScheduledSend();
      toast(ok ? '排程訊息已交給工作台送出。' : job.reason, 8000);
    } catch (error) {
      job.status = 'failed'; job.reason = error.message || String(error);
      try { schedulePersist(); } catch {}
      renderScheduledSend(); toast('定時送出失敗：' + job.reason, 8000);
    } finally { starting = false; scheduleWorking = false; }
  }

  async function send() {
    if (starting) return;
    const running = currentRun();
    if (running) { await stopAndReconcile(running); return; }
    if (pendingPastes) { toast('正在加入剪貼簿圖片，請稍候再送出'); return; }
    const ta = $('#input');
    const text = ta.value.trim();
    if (!text && !pendingAttachments.length) return;
    const revision=draftRevision, editRevision=draftEditRevision;
    starting=true;
    let ok;
    try { ok = await startRun(text || '請分析附件。', state.provider, { attachmentIds: pendingAttachments.map(a => a.id) }); }
    finally {starting=false;}
    if (ok && revision===draftRevision && editRevision===draftEditRevision) { draftRevision++; ta.value = ''; pendingAttachments = []; renderAttachments(); autosize(); drafts.delete(state.current?.key || '__new'); }
  }

  async function startRun(text, provider, extraOptions) {
    const epoch=viewEpoch;
    const generation=++sendGeneration;
    const wangpinPlan=activeWangpinPlan();
    if(wangpinPlan.enabled&&!extraOptions.webSynthesisRoundId){
      extraOptions={...extraOptions,wangpinPlan};
      if(wangpinPlan.execute.target.startsWith('web:')){
        const web=state.provider==='gpt'&&gptWeb()&&!$('#webEnsemblePanel').hidden?readWebForm():webConfig();
        extraOptions.webEnsemble={mcp:web.mcp===true};
      }
    }
    if (provider === 'gpt' && gptWeb() && !extraOptions.wangpinPlan?.enabled) {
      try {
        const config = await saveWebEnsemble(false);
        if (config.enabled || config.mcp || config.sites.some(site=>config.connections?.[site] && config.connections[site]!=='account') || extraOptions.webSynthesisRoundId) extraOptions = {...extraOptions,webEnsemble:{...config,enabled:true,synthesize:config.mcp ? false : extraOptions.webSynthesisRoundId ? true : config.enabled && config.synthesize}};
        else extraOptions={...extraOptions,webSourceModel:config.models.gpt || ''};
        webOptionsOpen=false;
        if($('#webEnsembleOptions'))$('#webEnsembleOptions').open=false;
      } catch(error) {toast(error.message,6000);return false;}
      if(epoch !== viewEpoch || generation !== sendGeneration)return false;
    }
    const settingsSnapshot=structuredClone(state.settings);
    const initialCwd=currentCwd();
    const viaCodex = viaSub(provider);
    if (!extraOptions.wangpinPlan?.enabled && provider === 'grokbot' && !state.settings.providers.grokbot?.hasKey) {
      toast('尚未設定 Grok Bot：請到「設定 → Grok Bot」貼上 Webhook URL 與 Key（在 Grok Bot App 的 routine「王品工作台 Grok Bot 對話橋接」面板可複製）。也可以先用「開啟 Grok Bot 桌面版」。', 9000);
      openGrokBotMenu($('#keyBtn'));
      return false;
    }
    if (!extraOptions.wangpinPlan?.enabled && provider !== 'codex' && provider !== 'antigravity' && provider !== 'grokbuild' && !viaCodex && !state.settings.providers[provider].hasKey) {
      toast(`還沒有 ${LABELS[provider]} 的金鑰，先新增一把`);
      openKeyEditor(provider);
      return false;
    }
    if (!state.current) {
      const r = await api.createChat({ cwd: newWorkspaceParent(), title: typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 80) : '', autoWorkspace: state.settings.autoChatWorkspace !== false, extensions: activeExtensions(), harnessScript: state.pendingHarness || '', systemPrompt: state.pendingSystemPrompt || '' });
      const opened = await api.openChat(r.key);
      if(epoch!==viewEpoch)return false;
      state.pendingCwd = null;
      state.pendingExtensions = [];
      state.pendingHarness = ''; state.pendingSystemPrompt = '';
        state.current = opened;
      renderHeader();
      renderMessages();
    }
    if(extraOptions.wangpinPlan?.enabled)state.current.modelPick={...(state.current.modelPick || {}),wangpinPlan:structuredClone(extraOptions.wangpinPlan)};
    await rememberPick(provider, settingsSnapshot);
    if (epoch !== viewEpoch || generation !== sendGeneration) return false;
    const box = $('#messages');
    box.querySelector('.welcome')?.remove();
    box.querySelector('.welcome-site')?.remove();
    box.querySelector('.empty-note')?.remove();
    const pcfg = settingsSnapshot.providers[provider];
    const model = (provider === 'claude' && viaCodex ? pcfg.cliModel || '' : provider === 'gpt' && pcfg.via === 'web' ? extraOptions.webSourceModel ?? pcfg.webModel ?? '' : pcfg.model || '').trim();
    const userEl = messageEl({ role: 'user', text, provider, source: 'app', attachments: extraOptions.attachmentItems || pendingAttachments.filter(a => (extraOptions.attachmentIds || []).includes(a.id)) });
    box.append(userEl);
    const el = h('div', { class: 'msg assistant', dataset: { p: provider } }, whoLabel(provider, model || (provider === 'codex' || (provider === 'gpt' && pcfg.via === 'web') ? '' : catalogOf(provider).models[0]), viaCodex ? activeSub(provider, settingsSnapshot).via : null));
    if(extraOptions.webEnsemble&&!extraOptions.wangpinPlan?.enabled)el.querySelector('.who').textContent='網頁版 · 分別回答與統合';
    if(extraOptions.wangpinPlan?.enabled)el.querySelector('.who').textContent='wangpinplan · Plan → 執行';
    const typing = h('div', { class: 'typing' }, h('i'), h('i'), h('i'));
    el.append(typing);
    box.append(el);
    box.scrollTop = box.scrollHeight;

    const reqId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const run = { reqId, generation, el, typing, userEl, userText: text, attachmentIds: [...(extraOptions.attachmentIds || [])], attachments: extraOptions.attachmentItems || pendingAttachments.filter(a => (extraOptions.attachmentIds || []).includes(a.id)), text: '', reasoning: '', md: null, reasoningEl: null, tools: new Map(), toolsBody: null, agent: new Map(), key: state.current.key, provider: viaCodex ? `${provider}-sub` : provider, title: state.current.title };
    run.quotaModel = provider === 'antigravity' ? model : '';
    run.webEnsemble = !!extraOptions.webEnsemble && !extraOptions.wangpinPlan?.enabled;
    run.wangpinPlan = !!extraOptions.wangpinPlan?.enabled;
    state.runs.set(reqId, run);
    updateSendButton();
    renderSidebar();

    const options = { ...extraOptions };
    options.permission=pcfg[provider==='claude'&&!viaCodex?'apiPermission':'permission'] || 'chat';
    delete options.attachmentItems;
    delete options.attachmentIds;
    if (provider === 'codex') { options.sandbox = pcfg.sandbox || 'workspace-write'; options.effort = pcfg.effort || 'default'; }
    if (provider === 'gpt') { options.reasoningEffort = pcfg.reasoningEffort || 'default'; options.webEffort = pcfg.webEffort || 'default'; options.via = pcfg.via || 'web'; }
    if (provider === 'deepseek') options.thinking = pcfg.thinking || 'default';
    if (provider === 'gemini' || provider === 'grok' || provider === 'meta') options.reasoningEffort = pcfg.reasoningEffort || 'default';
    if (provider === 'antigravity' || provider === 'grokbuild') options.effort = pcfg.effort || 'default';
    if (provider === 'claude') { options.via = pcfg.via || 'claudecode'; options.effort = pcfg.effort || 'default'; }
    options.extensions = activeExtensions();
    if (options.extensions.includes('harness') && activeHarness()) options.harnessScript = activeHarness();
    try { await api.send({ reqId, key: run.key, cwd:state.current.cwd || initialCwd || '', text, provider, model, options, attachmentIds: run.attachmentIds }); }
    catch (e) { await onStream({ reqId, type: 'error', message: e.message || '無法送出訊息' }); return false; }
    return true;
  }

  function scheduleRender(b) {
    // Keep all stream data, but avoid repeatedly parsing growing Markdown for
    // detached conversations or an invisible window. Paint when reattached.
    if (b.renderPending || b.terminal || document.hidden || !$('#messages').contains(b.el)) return;
    b.renderPending = true;
    const paint = () => {
      b.renderTimer = null;
      b.renderFrame = requestAnimationFrame(() => {
        b.renderFrame = null;
        b.renderPending = false;
        if (b.terminal || document.hidden || !$('#messages').contains(b.el)) return;
        const started = performance.now();
        renderRun(b);
        b.renderDuration = performance.now() - started;
        b.lastRenderAt = performance.now();
      });
    };
    // At most 12.5 full Markdown parses/s; expensive answers get more idle
    // time, with a 200 ms ceiling so progress stays responsive.
    const interval = Math.min(200, Math.max(80, (b.renderDuration || 0) * 3));
    const wait = b.lastRenderAt == null ? 0 : Math.max(0, interval - (performance.now() - b.lastRenderAt));
    if (wait) b.renderTimer = setTimeout(paint, wait); else paint();
  }
  function renderRun(b) {
      const box = $('#messages');
      const attached = box.contains(b.el);
      const stick = attached && box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      if (b.reasoning) {
        if (!b.reasoningEl) {
          b.reasoningEl = foldEl(b.wangpinPlan?'工作進度':'思考過程', '');
          b.reasoningEl.open = !!b.wangpinPlan;
          b.el.insertBefore(b.reasoningEl, b.typing.parentNode === b.el ? b.typing : null);
        }
        if (b.renderedReasoning !== b.reasoning) {
          b.reasoningEl.querySelector('.fold-body').textContent = b.reasoning;
          b.renderedReasoning = b.reasoning;
        }
      }
      if (b.text) {
        if (!b.md) { b.md = h('div', { class: 'md' }); b.el.insertBefore(b.md, b.typing.parentNode === b.el ? b.typing : null); }
        if (b.renderedText !== b.text) { renderMarkdown(b.md, b.text); b.renderedText = b.text; }
      }
      if (stick) box.scrollTop = box.scrollHeight;
  }
  function finishRunRender(b) {
    if (b.renderTimer != null) clearTimeout(b.renderTimer);
    b.renderTimer = null;
    if (b.renderFrame != null) cancelAnimationFrame(b.renderFrame);
    b.renderFrame = null; b.renderPending = false;
    renderRun(b);
    b.terminal = true;
    b.typing.remove();
  }
  async function stopAndReconcile(run, pause = false) {
    const result = await (pause ? api.pause(run.reqId) : api.cancel(run.reqId));
    if (!result.ok && state.runs.has(run.reqId)) {
      const status = await api.runStatus(run.reqId);
      if (!status.running) await onStream({reqId:run.reqId,type:'done',cancelled:true});
      else { run.pausing=false; updateSendButton(); }
    }
  }

  function toolText(item) {
    switch (item.type) {
      case 'command_execution': return { name: '指令', args: item.command, fail: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0), st: item.status };
      case 'file_change': return { name: '修改檔案', args: (item.changes || []).map((c) => `${c.kind === 'add' ? '新增' : c.kind === 'delete' ? '刪除' : '更新'} ${c.path}`).join('、'), fail: item.status === 'failed', st: item.status };
      case 'mcp_tool_call': return { name: 'MCP', args: `${item.server}/${item.tool}`, fail: item.status === 'failed', st: item.status };
      case 'web_search': return { name: '搜尋', args: item.query || '', st: 'completed' };
      case 'collab_tool_call': return { name: '子代理', args: `${item.tool}${item.prompt ? `：${String(item.prompt).slice(0, 80)}` : ''}`, fail: item.status === 'failed', st: item.status };
      case 'todo_list': return { name: '待辦', args: (item.items || item.plan || []).map((t) => `${t.completed || t.status === 'completed' ? '✓' : '○'} ${t.text || t.step || ''}`).join('  '), st: 'completed' };
      case 'api_tool': return { name: item.label || item.name, args: item.args || '', fail: item.status === 'failed', st: item.status };
      case 'error': return { name: '錯誤', args: item.message || '', fail: true };
      default: return { name: item.type, args: '' };
    }
  }

  function retainStreamText(previous, next) {
    previous = typeof previous === 'string' ? previous : '';
    next = typeof next === 'string' ? next : '';
    return !next || (previous.length > next.length && previous.startsWith(next)) ? previous : next;
  }
  function appendOrdinaryTool(line,item) {
    const labels={received:'已收到請求',awaiting_approval:'等待授權',spawning:'正在啟動程序',spawned:'程序已啟動',first_output:'已收到首筆輸出',exited:'程序已退出',result_ready:'結果已備妥'};
    const life=item.commandLifecycle;
    const status={completed:'完成',failed:'失敗',in_progress:'進行中'}[item.status];
    const elapsed=life&&Number.isFinite(life.elapsedMs)?` · ${(life.elapsedMs/1000).toFixed(1)} 秒`:'';
    const phase=life?labels[life.phase]||'階段未知':'';
    const reason={timeout:'逾時',cancelled:'已停止'}[life?.reason]||'';
    const termination=life?.termination==='unconfirmed'?'終止未確認':life?.termination==='parent_exited_pipes_open'?'子程序狀態未確認':'';
    const state=[status,reason,phase,termination].filter(Boolean).join(' · ');
    line.append(h('span',{class:'st',text:`${item.label||item.name||'工具'}${state?' · '+state:''}${elapsed}`}),String(item.args||''));
    if(life)line.title=(life.transport==='stream_requested'?'階段更新已提交至介面通道（未確認畫面接收）。\n':'')+(life.termination==='unconfirmed'?'尚無法確認程序終止。':'');
  }

  function appendPlanTool(line,item) {
    const t=item.type?toolText(item):{name:item.name,args:item.args,st:item.status,fail:item.status==='failed'};
    line.className=`tool-line${t.fail?' fail':''}`;
    const status={completed:'完成',failed:'失敗',in_progress:'進行中'}[t.st] || '狀態未提供';
    if(item.commandLifecycle)appendOrdinaryTool(line,{...item,name:item.label||t.name,status:t.st,args:t.args});
    else line.append(h('span',{class:'st',text:`${item.label || t.name || '工具'} · ${status}`}),String(t.args || ''));
    const output=item.output || item.aggregated_output;
    if(output)line.append(h('details',{class:'plan-tool-output'},h('summary',{text:'查看結果'}),h('pre',{text:String(output).slice(-4000)})));
  }
  function handleCodexItem(b, item) {
    if (item.type === 'agent_message') {
      if (item.phase === 'commentary' || item.phase === 'analysis') {
        b.reasoningParts = b.reasoningParts || new Map();
        b.reasoningParts.set(item.id,item.publicActivity?String(item.text || '').slice(0,500):retainStreamText(b.reasoningParts.get(item.id), item.text));
        if(item.publicActivity&&b.reasoningParts.size>64)b.reasoningParts.delete(b.reasoningParts.keys().next().value);
        b.reasoning = [...b.reasoningParts.values()].filter(Boolean).join('\n\n');
        if(item.publicActivity)b.reasoning=b.reasoning.slice(-16000);
        scheduleRender(b); return;
      }
      b.agent.set(item.id, retainStreamText(b.agent.get(item.id), item.text));
      b.text = [...b.agent.values()].filter(Boolean).join('\n\n');
      scheduleRender(b);
      return;
    }
    if (item.type === 'reasoning') {
      b.reasoningParts = b.reasoningParts || new Map();
      b.reasoningParts.set(item.id, retainStreamText(b.reasoningParts.get(item.id), item.text));
      b.reasoning = [...b.reasoningParts.values()].filter(Boolean).join('\n\n');
      scheduleRender(b);
      return;
    }
    const t = toolText(item);
    if (!b.toolsBody) {
      b.toolsBody = h('div', { class: 'fold-body' });
      b.toolsFold = h('details', { class: 'fold', open: true }, h('summary', { text: '工具呼叫' }), b.toolsBody);
      b.el.insertBefore(b.toolsFold, b.md || b.typing);
    }
    let line = b.tools.get(item.id);
    if (!line) { line = h('div', { class: 'tool-line' }); b.tools.set(item.id, line); b.toolsBody.append(line); }
    line.className = `tool-line${t.fail ? ' fail' : ''}`;
    line.innerHTML = '';
    if(b.wangpinPlan)appendPlanTool(line,item);else appendOrdinaryTool(line,{...item,name:t.name,args:t.args});
    if (item.type === 'command_execution' && item.aggregated_output && item.status !== 'in_progress') line.title = item.aggregated_output.slice(-2000);
    b.toolsFold.querySelector('summary').textContent = `工具呼叫 ${b.tools.size} 次`;
    b.toolsBody.scrollTop = b.toolsBody.scrollHeight;
  }

  async function onStream(ev) {
    const b = state.runs.get(ev.reqId);
    if (!b) return;
    const isCurrent = () => state.current && state.current.key === b.key;
    const terminalEpoch = viewEpoch;
    const canReload = () => isCurrent() && terminalEpoch === viewEpoch && b.generation === sendGeneration && !currentRun();
    const runTitle = () => { const it = (state.sidebar.items || []).find((i) => i.key === b.key); return (it && it.title) || b.userText.slice(0, 20); };
    switch (ev.type) {
      case 'started':
        if (ev.key && ev.key !== b.key) {
          if (isCurrent()) state.current.key = ev.key;
          b.key = ev.key;
        }
        refreshSidebar();
        break;
      case 'delta': b.text += ev.text; scheduleRender(b); break;
      case 'replace': b.text = String(ev.text ?? ''); scheduleRender(b); break;
      case 'reasoning': b.reasoning += ev.text; scheduleRender(b); break;
      case 'item': handleCodexItem(b, ev.item); break;
      case 'thread': if (isCurrent()) { state.current.threadId = state.current.threadId || ev.threadId; renderHeader(); } break;
      case 'notice': if (isCurrent()) toast(ev.message); break;
      case 'harness': if (isCurrent() && state.current) { state.current.harnessScript = ev.script; refreshHarnessCache().then(renderExtPill); } break;
      case 'status': {
        let label = b.typing.querySelector('.typing-label');
        if (!label) { label = h('span', { class: 'typing-label' }); b.typing.append(label); }
        label.textContent = ev.message || '';
        break;
      }
      case 'progress': {
        let label = b.typing.querySelector('.typing-label');
        if (!label) { label = h('span', { class: 'typing-label' }); b.typing.append(label); }
        label.textContent = ev.message || '';
        break;
      }
      case 'usageChanged': scheduleUsageRefresh(1500); break;
      case 'approval': {
        const card = h('div', { class: 'lock-card' },
          h('div', { class: 'lock-title', text: ev.kind === 'delete' ? '模型想刪除檔案（你設定了「禁止刪除，除非經我授權」）' : ev.kind === 'command' ? '模型想在專案裡執行指令' : '模型需要你的同意' }),
          h('div', { class: 'lock-desc', text: `工作目錄：${ev.cwd || '（未指定）'}` }),
          h('pre', { class: 'approval-code', text: ev.detail || '' }),
          h('div', { class: 'lock-actions' }));
        const actions = card.querySelector('.lock-actions');
        const answer = async (decision) => {
          card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          try { await api.resolveApproval({ id: ev.id, decision }); } catch { /* 已逾時 */ }
          card.replaceChildren(h('div', { class: 'lock-desc', text: decision === 'deny' ? '已拒絕這次執行。' : '已允許執行。' }));
        };
        // 刪除每次都要個別同意，不提供「本回合都允許」
        if (ev.kind === 'delete') actions.append(
          h('button', { type: 'button', class: 'btn-small', text: '拒絕', onclick: () => answer('deny') }),
          h('button', { type: 'button', class: 'btn-small danger', text: '允許這次刪除', onclick: () => answer('allow') }));
        else actions.append(
          h('button', { type: 'button', class: 'btn-small primary', text: '允許一次', onclick: () => answer('allow') }),
          ...(ev.allowAlways === false ? [] : [h('button', { type: 'button', class: 'btn-small', text: '本回合都允許', onclick: () => answer('always') })]),
          h('button', { type: 'button', class: 'btn-small', text: '拒絕', onclick: () => answer('deny') }));
        b.el.insertBefore(card, b.typing);
        if (!isCurrent()) toast(ev.kind === 'delete' ? '模型想刪除檔案，需要你的授權' : '模型需要你的同意才能繼續', 5000);
        break;
      }
      case 'locked': {
        finishRunRender(b);
        state.runs.delete(b.reqId);
        const card = h('div', { class: 'lock-card' },
          h('div', { class: 'lock-title', text: '這段對話正在 Codex App 裡開著，沒辦法同步寫入' }),
          h('div', { class: 'lock-desc', text: 'Codex 會鎖住正在開啟的對話，避免兩邊同時寫壞紀錄。想讓訊息出現在 Codex 專案裡：把 Codex App 關掉（或在 Codex App 切到別的對話），再按「重試」。' }),
          h('div', { class: 'lock-actions' },
            h('button', { type: 'button', class: 'btn-small primary', text: '重試', onclick: () => { b.userEl.remove(); b.el.remove(); startRun(b.userText, 'codex', { attachmentIds: b.attachmentIds, attachmentItems: b.attachments }); } }),
            h('button', { type: 'button', class: 'btn-small', text: '分支接續（不同步）', onclick: () => { b.userEl.remove(); b.el.remove(); startRun(b.userText, 'codex', { onLock: 'fork', attachmentIds: b.attachmentIds, attachmentItems: b.attachments }); } })));
        b.el.append(card);
        updateSendButton();
        renderSidebar();
        if (!isCurrent()) toast(`「${runTitle()}」被 Codex App 鎖住，回去看看`, 4000);
        break;
      }
      case 'done': {
        finishRunRender(b);
        state.runs.delete(b.reqId);
        updateSendButton();
        if (isCurrent()) {
          await refreshSidebar();
          if(canReload()) await openChat(b.key, { keepScroll: true, terminalGeneration: b.generation });
        } else {
          state.unread.add(b.key);
          await refreshSidebar();
          if (!ev.cancelled) toast(`「${runTitle()}」回覆完成`);
        }
        if (b.provider === 'antigravity') loadAntigravity(true);
        if (b.provider === 'grokbuild') loadGrokBuild(true);
        scheduleUsageRefresh();
        break;
      }
      case 'error': {
        if(b.webEnsemble){
          finishRunRender(b);state.runs.delete(b.reqId);updateSendButton();await refreshSidebar();
          if(canReload()){
            const saved=await api.openChat(b.key);
            if(!saved.error&&canReload()){state.current=saved;renderHeader();renderMessages({keepScroll:true});$('#messages').append(errEl(ev.message));}
          }else{state.unread.add(b.key);toast(`「${runTitle()}」發生錯誤`);}
          break;
        }
        if (b.provider === 'antigravity') {
          if (/individual quota reached|quota (?:exhausted|exceeded)|usage_limit_reached/i.test(ev.message || '')) { state.antigravityQuotaFailure = { model:b.quotaModel, message:ev.message, at:Date.now() }; renderUsageLine(); }
          loadAntigravity(true);
        }
        finishRunRender(b);
        state.runs.delete(b.reqId);
        const err = errEl(ev.message);
        b.el.append(err);
        if (ev.authRequired) {
          b.el.append(h('button', { type: 'button', class: 'btn-small primary', text: '重新登入 Codex 帳號', onclick: () => loginCodexAccount() }));
        }
        if (ev.grokBuildLogin) b.el.append(h('button', { type: 'button', class: 'btn-small primary', text: '登入 Grok Build', onclick: () => grokBuildLogin() }));
        if (b.provider === 'grokbot' && ev.grokBotSetup) {
          b.el.append(h('div', { class: 'lock-actions' },
            h('button', { type: 'button', class: 'btn-small primary', text: '填寫 Grok Bot 設定', onclick: () => openGrokBotSettings() }),
            h('button', { type: 'button', class: 'btn-small', text: '開啟 Grok Bot 桌面版', onclick: () => launchGrokBotDesktop(false) })));
        }
        if (b.provider === 'claude-sub' && /未.*授權|not logged in|\/login/i.test(ev.message || '')) {
          b.el.append(h('button', { type: 'button', class: 'btn-small primary', text: '連接既有 Claude 帳號', onclick: () => {
            openSettings();
            const button = $('#btnClaudeLogin');
            for (let parent = button.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
            button.scrollIntoView({ block: 'center' }); button.click();
          } }));
        }
        updateSendButton();
        await refreshSidebar();
        if (canReload()) {
          if (!pendingAttachments.length && b.attachments?.length) { pendingAttachments = b.attachments; renderAttachments(); }
          const r = await api.openChat(b.key);
          if (!r.error && canReload()) {
            state.current = r; state.current.paused=true; renderHeader(); renderMessages({ keepScroll: true });
            const savedPartial = (b.text || b.reasoning) && r.messages.some(m=>m.role === 'assistant' && m.partial && m.text === b.text && (m.reasoning || '') === b.reasoning);
            if (savedPartial) { b.md?.remove(); b.reasoningEl?.remove(); }
            $('#messages').append(b.el); updateSendButton();
          }
        } else {
          state.unread.add(b.key);
          toast(`「${runTitle()}」發生錯誤`);
        }
        break;
      }
      default: break;
    }
  }

  // ---------------- 用量與餘額 ----------------
  function fmtReset(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const diff = ms - Date.now();
    if (diff <= 0) return '已重置';
    if (diff < 86400000) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`;
    return `${d.getMonth() + 1}/${d.getDate()} 重置`;
  }

  const remainingOf = (used) => (used == null ? null : Math.max(0, Math.min(100, 100 - used)));

  function codexUsageText(u, { long = false } = {}) {
    if (!u) return '讀取中…';
    if (u.error) return long ? `讀不到用量：${u.error}` : '讀不到用量';
    if (!u.windows || !u.windows.length) return '目前沒有用量資料';
    const parts = u.windows.map((w) => {
      const left = remainingOf(w.usedPercent);
      return `${w.label}剩 ${left == null ? '?' : Math.round(left)}%${long && w.resetsAt ? `（${fmtReset(w.resetsAt)}）` : ''}`;
    });
    let t = parts.join('，');
    if (long && u.credits && u.credits.balance) t += `，額外點數 ${u.credits.balance}`;
    if (long && u.extra && u.extra.usedCredits != null) t += `，額外用量已用 ${u.extra.usedCredits}${u.extra.monthlyLimit ? `／${u.extra.monthlyLimit}` : ''}`;
    if (u.source === 'cache') t += long ? '（這是之前記錄的數字，可能不是最新）' : '（舊）';
    return t;
  }

  function deepseekBalanceText(b) {
    if (!b) return '讀取中…';
    if (!b.ok) return `讀不到餘額：${b.message}`;
    if (!b.balances.length) return b.available ? '可以使用' : '餘額不足';
    return `餘額 ${b.balances.map((x) => `${x.currency === 'CNY' ? '¥' : x.currency === 'USD' ? '$' : `${x.currency} `}${x.total}`).join('、')}${b.available ? '' : '（不足）'}`;
  }

  let usageTimer = null;
  function scheduleUsageRefresh(delay = 4000) {
    clearTimeout(usageTimer);
    usageTimer = setTimeout(refreshUsage, delay);
  }

  let usageEpoch = 0;
  const usageIdentity = () => `${state.settings?.codexHome || ''}\0${state.settings?.providers?.claude?.configDir || ''}\0${state.settings?.providers?.claude?.claudePath || ''}`;
  async function refreshUsage() {
    const epoch = ++usageEpoch, identity = usageIdentity();
    let usage;
    try { usage = await api.readUsage(); } catch (e) { usage = { codex: { error: String(e.message || e) }, keys: {}, billing: {} }; }
    if (epoch !== usageEpoch || identity !== usageIdentity()) return;
    state.usage = usage;
    if (state.provider === 'antigravity') loadAntigravity(true);
    renderUsageLine();
    if ($('#settingsDlg').open) renderKeyGroups();
  }

  function usageBar(label, usedPct) {
    const left = remainingOf(usedPct);
    const v = left == null ? null : Math.round(left);
    const level = v == null ? '' : v <= 10 ? ' hot' : v <= 30 ? ' warm' : '';
    return h('span', { class: `u-item${level}` },
      h('span', { class: 'u-label', text: label }),
      h('span', { class: 'u-bar' }, h('i', { style: `width:${v == null ? 0 : v}%` })),
      h('span', { class: 'u-num', text: v == null ? '?' : `剩 ${v}%` }));
  }

  function renderUsageLine() {
    const el = $('#usageLine');
    if (!el || !state.settings) return;
    const p = state.provider;
    el.dataset.provider = p;
    const cfg = state.settings.providers[p] || {};
    const u = state.usage;
    el.innerHTML = '';
    let title = '點一下重新讀取用量';
    let url = null;
    let reload = refreshUsage;
    if (p === 'antigravity') {
      const ag = state.antigravity;
      el.append(h('span', { class: 'u-head', text: 'Antigravity 額度' }));
      reload = () => loadAntigravity(true);
      if (!ag) el.append(h('span', { class: 'u-text', text: '讀取中…' }));
      else if (!ag.ok) { el.append(h('span', { class: 'u-text', text: 'Antigravity CLI 連線失敗（點一下重試）' })); title = ag.message || ''; }
      else {
        const fam = ag.families?.find(f=>f.name===cfg.model) || (!cfg.model && (ag.families?.find(f=>f.variants.some(v=>v.id===ag.defaultModel)) || ag.families?.[0]));
        const buckets = fam?.variants[0]?.quotaWindows || fam?.variants[0]?.quotaBuckets || [];
        if (ag.usageError && !buckets.length) {
          el.append(h('span', { class: 'u-text', text: '額度暫時讀不到（仍可嘗試聊天）' }));
          title = ag.usageError;
        } else {
          const failure = state.antigravityQuotaFailure;
          if (failure && failure.model === cfg.model && Date.now()-failure.at < 300000) el.append(h('span',{class:'u-text',text:'本次請求額度受限'}));
          for (const bucket of buckets) {
            if (bucket.unavailable) el.append(h('span',{class:'u-text',text:bucket.label+'：未提供',title:bucket.description}));
            else if (bucket.disabled) el.append(h('span',{class:'u-text',text:bucket.label+'：不適用'}));
            else { const item=usageBar(bucket.label,bucket.remaining===null?null:100-bucket.remaining*100);if(bucket.resetTime)item.append(h('span',{class:'u-label',text:fmtReset(Date.parse(bucket.resetTime))}));el.append(item); }
          }
          if (!buckets.length) el.append(h('span',{class:'u-text',text:'沒有目前模型的額度資料'}));
          const stale = Date.now()-(ag.fetchedAt||0)>60000;
          if(stale)el.append(h('span',{class:'u-text',text:'（舊資料）'}));
          else if(ag.usageError)el.append(h('span',{class:'u-text',text:'（更新逾時）'}));
          title = (fam?.variants[0]?.quotaGroup || '')+'（同組模型／推理強度共用）\n'+buckets.map(b=>b.label+'：'+(b.unavailable?'CLI \u672a\u63d0\u4f9b':b.disabled?'不適用':b.remaining===null?'未知':'剩 '+Math.round(b.remaining*100)+'%')+(b.resetTime?'，'+new Date(b.resetTime).toLocaleString()+' 重置':'')).join('\n')+'\n最後更新：'+(ag.fetchedAt?new Date(ag.fetchedAt).toLocaleTimeString():'未知')+(ag.usageError?'\n額度查詢提醒：'+ag.usageError:'')+(failure&&failure.model===cfg.model?'\n最近請求錯誤：'+failure.message:'')+'\n點一下強制更新';
        }
      }
    } else if (p === 'grokbuild') {
      const gb = state.grokBuild;
      el.append(h('span', { class: 'u-head', text: 'Grok Build' }));
      if(!gb || !gb.installed || !gb.signedIn)el.append(h('span',{class:'u-text',text:!gb?'讀取中…':!gb.installed?'尚未安裝 CLI（點一下安裝）':'尚未登入 grok.com（點一下登入）'}));
      else if(!gb.quota)el.append(h('span',{class:'u-text',text:gb.quotaError||'方案尚未提供額度資料（點一下重試）'}));
      else {
        const q=gb.quota,label=q.period==='weekly'?'每週':q.period==='monthly'?'每月':'方案';
        if(q.plan)el.append(h('span',{class:'u-label',text:q.plan}));
        el.append(usageBar(label,q.usedPercent));
        if(q.usedPercent===null)el.append(h('span',{class:'u-text',text:'未提供使用比例'}));
        if(q.resetAt)el.append(h('span',{class:'u-label',text:fmtReset(Date.parse(q.resetAt))}));
        if(Date.now()-q.at>60000)el.append(h('span',{class:'u-text',text:'（舊資料）'}));
        title=`${q.plan||'Grok Build'} · ${label}方案額度`+(q.usedPercent===null?'\n未提供使用比例':`\n已用 ${q.usedPercent}%，剩餘 ${q.remainingPercent}%`)+(q.resetAt?'\n重置：'+new Date(q.resetAt).toLocaleString():'')+(q.prepaidUsd===null?'':`\n預付餘額：USD ${q.prepaidUsd.toFixed(2)}`)+'\n最後更新：'+new Date(q.at).toLocaleTimeString()+'\n此為官方帳號方案額度，非單段對話 token 用量；點一下重新讀取。';
      }
      if(!gb?.quota)title=gb?.quotaError||'點一下重新讀取 Grok Build 官方方案額度';
      reload = () => { if (gb && (!gb.installed || !gb.signedIn)) openGrokBuildMenu('account'); else loadGrokBuild(true); };
    } else if (p === 'grokbot') {
      el.append(h('span', { class: 'u-head', text: 'Grok Bot' }));
      el.append(h('span', { class: 'u-text', text: cfg.hasKey ? '雲端 routine 回覆（用量計入 Grok Bot 方案）' : '尚未設定 Webhook（點一下設定）' }));
      title = cfg.hasKey ? '每則訊息會啟動一次 routine 執行，回覆約需數十秒到數分鐘' : '到「設定 → Grok Bot」貼上 Webhook URL 與 Key';
      reload = () => { renderUsageLine(); if (!cfg.hasKey) openGrokBotSettings(); };
    } else if (p === 'codex' || viaSub(p)) {
      const cu = u && (p === 'claude' ? u.claude : u.codex);
      el.append(h('span', { class: 'u-head', text: p === 'claude' ? 'Claude Code 用量' : 'Codex 帳號用量' }));
      if (cu && cu.source === 'cache') el.append(h('span', { class: 'u-text', text: '（舊資料）' }));
      if (!cu) el.append(h('span', { class: 'u-text', text: '讀取中…' }));
      else if (cu.error || !cu.windows || !cu.windows.length) el.append(h('span', { class: 'u-text', text: cu.error ? '讀不到（點一下重試）' : '還沒有資料' }));
      else for (const w of cu.windows) el.append(usageBar(w.label, w.usedPercent));
      title = codexUsageText(cu, { long: true });
      if (p !== 'claude' && activeCodexAccount()) title = `帳號：${activeCodexAccount().label}\n${title}`;
    } else if (p === 'deepseek') {
      el.append(h('span', { class: 'u-head', text: 'DeepSeek' }));
      el.append(h('span', { class: 'u-text', text: cfg.activeKeyId ? deepseekBalanceText(u && u.keys[cfg.activeKeyId]) : '沒有金鑰' }));
    } else if (p === 'lmstudio') {
      el.append(h('span', { class: 'u-head', text: 'LM Studio' }));
      el.append(h('span', { class: 'u-text', text: '本機模型，不計費' }));
      title = '在你自己的電腦上執行，不用金鑰也不花錢';
      url = null;
    } else {
      el.append(h('span', { class: 'u-head', text: `${LABELS[p]} API` }));
      el.append(h('span', { class: 'u-text', text: '餘額到官網查看 ↗' }));
      title = '這家沒有提供用金鑰查餘額的方式，點一下開啟官網帳單頁面';
      url = u && u.billing ? u.billing[p] : null;
    }
    el.title = title;
    el.onclick = () => {
      if (url) { api.openExternal(url); return; }
      el.innerHTML = '';
      el.append(h('span', { class: 'u-text', text: '讀取中…' }));
      reload();
    };
  }

  // ---------------- API 金鑰 ----------------
  function renderKeySelect() { renderComposerBar(); }

  function applySettings(ns) {
    state.settings = ns;
    renderKeySelect();
    if ($('#settingsDlg').open) renderKeyGroups();
    if (!state.current) renderMessages();
  }

  function renderKeyGroups() {
    const box = $('#keyGroups');
    box.innerHTML = '';
    for (const p of API_ORDER) {
      const cfg = state.settings.providers[p] || {};
      const keys = cfg.keys || [];
      const group = h('section', { class: 'key-group', style: `--pc: var(--p-${p})` });
      group.append(h('div', { class: 'kg-head' },
        h('h3', { text: LABELS[p] }), h('span', { class: 'kg-sub', text: SUBTITLE[p] }),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn-small', text: '取得金鑰', title: '到官網建立 API 金鑰', onclick: () => api.openExternal(KEY_PAGES[p]) }),
        h('button', { type: 'button', class: 'btn-small primary', text: '新增金鑰', onclick: () => openKeyEditor(p) })));
      const viaCodex = viaSub(p);
      if (subsOf(p).length) {
        const list = h('ul', { class: 'key-list' });
        for (const sub of subsOf(p)) {
          const on = activeSub(p) === sub;
          const subUsage = sub.via === 'codex' ? state.usage && state.usage.codex : sub.via === 'claudecode' ? state.usage && state.usage.claude : null;
          const extra = sub.via === 'web' ? h('div', { class: 'key-usage', text: '檢查中…' }) : h('div', { class: 'key-usage', text: `用量：${codexUsageText(subUsage, { long: true })}` });
          if (sub.via === 'web') api.gptWebStatus().then((r) => { extra.textContent = r.message; extra.classList.toggle('warn', !r.ok); }).catch(() => { extra.textContent = '無法檢查 Brave 的 ChatGPT 登入'; });
          const loginBtn = sub.via === 'web' ? h('button', { type: 'button', class: 'btn-small', text: '登入 ChatGPT', title: '開啟工作台專用 Brave 登入視窗，沿用原本的登入設定檔',
            onclick: async (ev) => {
              const b = ev.currentTarget; b.disabled = true; b.textContent = '請在 Brave 完成登入…';
              try { await loginGptWebAccount(); }
              catch (err) { toast(String(err.message || err)); }
              b.disabled = false; b.textContent = '登入 ChatGPT';
              api.gptWebStatus().then((r) => { extra.textContent = r.message; extra.classList.toggle('warn', !r.ok); }).catch(() => {});
            } }) : null;
          list.append(h('li', { class: `key-row${on ? ' active' : ''}` },
            h('button', {
              type: 'button', class: `use-btn${on ? ' on' : ''}`, text: on ? '使用中' : '使用', disabled: on,
              onclick: async () => applySettings(await api.setActiveKey({ provider: p, id: sub.id })),
            }),
            h('div', { class: 'key-main' },
              h('div', { class: 'key-name', text: sub.name }),
              h('div', { class: 'key-test ok', text: sub.desc }),
              extra),
            loginBtn));
        }
        group.append(list);
      }
      if (!keys.length) {
        group.append(h('div', { class: 'key-empty', text: subsOf(p).length ? `沒有 API 金鑰也可以用上面的 ${subsOf(p).map((x) => x.name).join('或')}。API 金鑰要另外到官網儲值才能用。` : '還沒有金鑰。先按「取得金鑰」到官網建立，複製後回來按「新增金鑰」貼上。' }));
      } else {
        const list = h('ul', { class: 'key-list' });
        for (const k of keys) {
          const isActive = !viaCodex && k.id === cfg.activeKeyId;
          const test = k.lastTest;
          const row = h('li', { class: `key-row${isActive ? ' active' : ''}` },
            h('button', {
              type: 'button', class: `use-btn${isActive ? ' on' : ''}`, 'aria-pressed': String(isActive),
              text: isActive ? '使用中' : '使用', disabled: isActive,
              onclick: async () => applySettings(await api.setActiveKey({ provider: p, id: k.id })),
            }),
            h('div', { class: 'key-main' },
              h('div', { class: 'key-name', text: k.name }),
              h('div', { class: 'key-hint', text: k.baseUrl ? `${k.hint}（${k.baseUrl}）` : k.hint }),
              test ? h('div', { class: `key-test ${test.ok ? 'ok' : 'bad'}`, text: test.ok ? test.message : `無法使用：${test.message}` }) : null,
              p === 'deepseek' ? h('div', { class: 'key-usage', text: deepseekBalanceText(state.usage && state.usage.keys[k.id]) }) : null),
            h('div', { class: 'key-actions' },
              p !== 'deepseek' ? h('button', { type: 'button', class: 'btn-small', text: '查看餘額', title: '這家沒有提供用金鑰查餘額的方式，會開啟官網帳單頁面', onclick: () => api.openExternal((state.usage && state.usage.billing[p]) || KEY_PAGES[p]) }) : null,
              h('button', { type: 'button', class: 'btn-small', text: '測試', onclick: (e) => runKeyTest(p, k.id, e.currentTarget) }),
              h('button', { type: 'button', class: 'btn-small', text: '修改', onclick: () => openKeyEditor(p, k) }),
              h('button', { type: 'button', class: 'btn-small danger', text: '刪除', onclick: async () => { const r = await api.deleteKey({ provider: p, id: k.id }); applySettings(r.settings); } })));
          list.append(row);
        }
        group.append(list);
      }
      box.append(group);
    }
  }

  async function runKeyTest(provider, id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '測試中…'; }
    const r = await api.testKey({ provider, id });
    applySettings(r.settings);
    return r.result;
  }

  // 內建瀏覽器同步 Brave 登入的結果（自動或手動）
  function describeLoginSync(r, manual = false) {
    if (!r) return '';
    const when = r.at ? new Date(r.at).toLocaleTimeString() : '';
    if (r.ok) return `${manual ? '已同步' : `上次自動同步（${when}）`}：${r.ok} 個 cookie、${r.sites} 個網站，來源：${r.via}${r.failed ? `\n有 ${r.failed} 個無法匯入（通常是瀏覽器不接受的格式，可忽略）` : ''}${manual ? '\n已經開著的分頁請重新整理。' : ''}`;
    if (r.code === 'BRAVE_NO_DEBUG_PORT') return `${manual ? '' : `上次自動同步（${when}）沒有成功：`}${r.message}。按「重新啟動我的 Brave（開啟除錯埠）」之後就會自動同步。`;
    if (r.code === 'BRAVE_NOT_RUNNING') return `上次自動同步（${when}）：你的 Brave 沒開，沿用上次同步的登入。按「立刻同步」可以在背景讀一次。`;
    return `${manual ? '' : `上次自動同步（${when}）失敗：`}${r.message}`;
  }

  // ---------------- Grok Bot（routine webhook ＋ ntfy 回覆） ----------------
  async function launchGrokBotDesktop(copy) {
    try {
      const text = $('#input').value;
      if (copy && !text.trim()) { toast('請先輸入要複製的文字'); return; }
      const result = copy ? await api.copyDraftToGrokBot(text) : await api.openGrokBot();
      toast(copy ? '已複製輸入並開啟 Grok Bot，請貼上後自行送出；草稿保留。' : result.message, 8000);
    } catch (error) { toast(error.message, 7000); }
  }
  function openGrokBotMenu(anchor = $('#keyBtn')) {
    const cfg = state.settings?.providers.grokbot || {};
    openMenu(anchor, { title: 'Grok Bot', items: [
      { heading: cfg.hasKey ? `Webhook 已設定（金鑰 ${cfg.keyHint || '已保存'}）` : '尚未設定 Webhook URL 與 Key' },
      { label: cfg.hasKey ? '修改 Grok Bot 設定…' : '填寫 Grok Bot 設定…', desc: 'Webhook URL、Webhook Key、ntfy 主題與伺服器', onSelect: () => openGrokBotSettings() },
      { divider: true },
      { heading: '備用：外部桌面程式' },
      { label: '開啟 Grok Bot 桌面版', desc: '使用已安裝的桌面程式與帳號；回答不會回傳工作台', onSelect: () => launchGrokBotDesktop(false) },
      { label: '複製目前輸入並開啟桌面版', desc: '僅複製文字；附件與回答不會自動傳送', onSelect: () => launchGrokBotDesktop(true) },
    ] });
  }
  function openGrokBotSettings() {
    openSettings();
    const box = $('#grokBotSettings');
    if (!box) return;
    box.scrollIntoView({ block: 'start' });
    const cfg = state.settings.providers.grokbot || {};
    (cfg.webhookUrl ? box.querySelector('#gbKey') : box.querySelector('#gbUrl'))?.focus();
  }
  function renderGrokBotSettings() {
    const box = $('#grokBotSettings');
    if (!box || !state.settings) return;
    const cfg = state.settings.providers.grokbot || {};
    box.replaceChildren();
    const status = h('pre', { class: 'set-note', style: 'white-space:pre-wrap;overflow-wrap:anywhere' });
    const url = h('input', { id: 'gbUrl', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: '貼上 routine Webhook 區塊的「POST to」網址（https://…）' });
    url.value = cfg.webhookUrl || '';
    const key = h('input', { id: 'gbKey', type: 'password', spellcheck: 'false', autocomplete: 'off', placeholder: cfg.keySaved ? `已保存（${cfg.keyHint}）；要換新的才需要貼上` : '貼上 routine Webhook 區塊的「key」' });
    const show = h('button', { type: 'button', class: 'btn-small', text: '顯示', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? '顯示' : '隱藏'; } });
    const topic = h('input', { id: 'gbTopic', type: 'text', spellcheck: 'false', autocomplete: 'off' });
    topic.value = cfg.ntfyTopic || '';
    const server = h('input', { id: 'gbServer', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://ntfy.sh' });
    server.value = cfg.ntfyServer || '';
    const publicReplies = h('input', { id: 'gbAllowPublic', type: 'checkbox' });
    publicReplies.checked = cfg.allowPublicReplies === true;
    const sendWorkspace = h('input', { id: 'gbSendWorkspace', type: 'checkbox' });
    sendWorkspace.checked = cfg.sendWorkspace === true;
    const save = async (patch, done) => {
      try {
        state.settings = await api.saveGrokBotConfig(patch);
        renderComposerBar();
        renderGrokBotSettings();
        const next = $('#grokBotSettings pre.set-note');
        if (next) next.textContent = done;
      } catch (error) { status.textContent = `無法儲存：${String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`; }
    };
    box.append(
      h('div', { class: 'kg-head' },
        h('h3', { text: 'Grok Bot' }), h('span', { class: 'kg-sub', text: 'routine webhook 送出、ntfy 傳回回覆（不使用 xAI API Key）' }),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn-small', text: '開啟 Grok Bot 桌面版', title: '備用：開啟已安裝的外部桌面程式', onclick: () => launchGrokBotDesktop(false) })),
      h('p', { class: 'set-note', text: '在 Grok Bot App 點 Bot 名稱 → Details → Routines，開啟「王品工作台 Grok Bot 對話橋接」，從 Webhook 區塊複製「POST to」（網址）與「key」貼到下面。Key 只會加密存在這台電腦。' }),
      h('label', { class: 'field' }, 'Webhook URL', url),
      h('label', { class: 'field' }, 'Webhook Key', h('span', { class: 'row' }, key, show)),
      h('label', { class: 'field' }, 'ntfy 主題（回覆從這裡傳回）', topic),
      h('label', { class: 'field' }, 'ntfy 伺服器', server),
      h('label', { class: 'field' }, publicReplies, '我同意使用公開 ntfy.sh 回覆通道：知道主題名稱的人可能讀到回答。主題必須與 Grok Bot routine 設定一致。'),
      h('label', { class: 'field' }, sendWorkspace, '將本機工作資料夾路徑附到雲端任務（預設不傳送）'),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
        h('button', { type: 'button', class: 'btn-small primary', text: '儲存', onclick: () => save({ webhookUrl: url.value, webhookKey: key.value, ntfyTopic: topic.value, ntfyServer: server.value, allowPublicReplies: publicReplies.checked, sendWorkspace:sendWorkspace.checked }, '已儲存 Grok Bot 設定。') }),
        cfg.keySaved ? h('button', { type: 'button', class: 'btn-small danger', text: '清除金鑰', onclick: () => save({ clearKey: true }, '已清除 Webhook Key。') }) : null,
        h('button', { type: 'button', class: 'btn-small', text: '測試 ntfy 連線', title: '只讀取 ntfy 主題，不會啟動 routine、不花用量', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; status.textContent = '測試中…';
          try { const r = await api.testGrokBotNtfy(); status.textContent = r.message; }
          catch (error) { status.textContent = String(error.message || error); }
          b.disabled = false;
        } })),
      status,
      h('p', { class: 'set-note', text: cfg.hasKey ? '狀態：已設定。在對話下方選「Grok Bot」即可直接聊天；每則訊息會啟動一次 routine，回覆約需數十秒到數分鐘，最多等 6 分鐘。' : '狀態：尚未設定 Webhook URL 與 Key。' }));
  }

  function openSettings() {
    renderKeyGroups();
    renderGrokBotSettings();
    refreshUsage();
    $('#sSystem').value = state.settings.systemPrompt || '';
    $('#sClaudePath').value = state.settings.providers.claude.claudePath || '';
    $('#sClaudeConfig').value = state.settings.providers.claude.configDir || '';
    $('#sMaxChars').value = state.settings.maxContextChars || 120000;
    $('#sBravePath').value = (state.settings.browser || {}).path || '';
    $('#sBraveEnabled').checked = (state.settings.browser || {}).enabled !== false;
    $('#sAppBrowserEnabled').checked = (state.settings.browser || {}).appEnabled === true;
    $('#sBraveBrowserEnabled').checked = (state.settings.browser || {}).braveEnabled === true;
    $('#sBraveCodexExtension').checked = (state.settings.browser || {}).preferBraveExtension !== false;
    $('#sBraveProfile').value = (state.settings.browser || {}).profile === 'mine' ? 'mine' : 'isolated';
    $('#sBraveBackground').checked = (state.settings.browser || {}).background !== false;
    $('#sBraveSyncLogin').checked = (state.settings.browser || {}).syncBraveLogin !== false;
    $('#sBrowserReveal').checked = (state.settings.browser || {}).revealPanel === true;
    $('#braveStatus').textContent = '';
    api.loginSyncStatus().then((r) => { if (r && !$('#braveStatus').textContent) $('#braveStatus').textContent = describeLoginSync(r); }).catch(() => {});
    renderExtSettings();
    loadExtensions();
    if (!$('#settingsDlg').open) $('#settingsDlg').showModal();
  }

  let keyEditing = null; // { provider, key }
  function openKeyEditor(provider, key = null) {
    keyEditing = { provider, key };
    const count = (state.settings.providers[provider].keys || []).length;
    $('#keyDlgTitle').textContent = key ? `修改 ${LABELS[provider]} 金鑰` : `新增 ${LABELS[provider]} 金鑰`;
    $('#kName').value = key ? key.name : '';
    $('#kName').placeholder = key ? '' : `例如：個人帳號（留空就叫「${LABELS[provider]} 金鑰 ${count + 1}」）`;
    const kk = $('#kKey');
    kk.value = ''; kk.type = 'password'; $('#kShow').textContent = '顯示';
    kk.placeholder = key ? '要換新金鑰才需要貼，留空保留原本的' : provider === 'lmstudio' ? 'LM Studio 預設不需要金鑰，可留空' : '在這裡按 Ctrl+V 貼上';
    $('#kKeyNote').textContent = key ? `目前的金鑰：${key.hint}` : '金鑰只會加密存在這台電腦，不會上傳。';
    $('#kBase').value = key ? key.baseUrl : '';
    $('#kBase').placeholder = catalogOf(provider).defaultBase;
    $('#kAdvanced').open = !!(key && key.baseUrl) || provider === 'lmstudio';
    $('#kError').hidden = true;
    $('#kSave').disabled = false; $('#kSave').textContent = '儲存並測試';
    $('#keyDlg').showModal();
    (key ? $('#kName') : kk).focus();
  }

  async function submitKeyEditor(e) {
    e.preventDefault();
    if (!keyEditing) return;
    const { provider, key } = keyEditing;
    const err = $('#kError');
    err.hidden = true;
    const apiKey = $('#kKey').value.trim();
    if (!key && !apiKey && provider !== 'lmstudio') { err.textContent = '請先貼上 API 金鑰。'; err.hidden = false; return; }
    const btn = $('#kSave');
    btn.disabled = true; btn.textContent = '儲存中…';
    const r = await api.saveKey({ provider, id: key ? key.id : null, name: $('#kName').value, apiKey, baseUrl: $('#kBase').value });
    if (r.error) { err.textContent = r.error; err.hidden = false; btn.disabled = false; btn.textContent = '儲存並測試'; return; }
    applySettings(r.settings);
    btn.textContent = '測試中…';
    const result = await runKeyTest(provider, r.id);
    if (result && result.ok) {
      $('#keyDlg').close();
      keyEditing = null;
      toast(`${LABELS[provider]} 金鑰${key ? '已更新' : '已加入'}，${result.message}${r.note ? `。${r.note}` : ''}`, 4500);
      if (!$('#settingsDlg').open && !key) setProvider(provider);
    } else {
      // 已經存下來了，讓使用者決定要不要修正
      keyEditing = { provider, key: state.settings.providers[provider].keys.find((k) => k.id === r.id) };
      $('#keyDlgTitle').textContent = `修改 ${LABELS[provider]} 金鑰`;
      $('#kName').value = keyEditing.key.name;
      $('#kKey').value = ''; $('#kKey').placeholder = '要換新金鑰才需要貼，留空保留原本的';
      $('#kKeyNote').textContent = `已儲存：${keyEditing.key.hint}`;
      err.textContent = `金鑰已儲存，但測試沒有通過：${result ? result.message : '未知錯誤'}${r.note ? `\n${r.note}` : ''}`;
      err.hidden = false;
      btn.disabled = false; btn.textContent = '重新儲存並測試';
      $('#kCancel').textContent = '先這樣，關閉';
    }
  }

  // ---------------- 事件綁定 ----------------
  function bind() {
    $('#messages').addEventListener('click', async e => {
      const img=e.target.closest('img');
      if(img) { e.preventDefault(); await previewImage({url:img.currentSrc || img.src,name:img.alt || '圖片'}); return; }
      const anchor = e.target.closest('a');
      if (!anchor) return;
      e.preventDefault();
      const raw = anchor.getAttribute('data-chat-link') || anchor.getAttribute('href');
      if (!raw || raw === '#') return;
      try { const r = await api.openChatLink(raw); if (r?.message) toast(r.message, r.ok ? 4000 : 8000); }
      catch (err) { toast(err.message, 8000); }
    });
    $('#input').addEventListener('paste', async e => {
      const files = [...(e.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      if ($('#btnAttach').disabled) { toast('正在準備附件，請稍候再貼上圖片。'); return; }
      if (pendingAttachments.length >= 16 || pendingAttachments.filter(item=>!item.video&&!item.audio).length >= 8) { toast('每次最多 8 個附件'); return; }
      const draftKey = state.current?.key || null;
      const revision = draftRevision;
      pendingPastes++;
      try { for (const file of files) {
        if (pendingAttachments.length >= 16 || pendingAttachments.filter(item=>!item.video&&!item.audio).length >= 8) { toast('每次最多 8 個附件'); break; }
        try {
          if (file.size > 600 * 1024 * 1024) throw new Error('圖片超過 600 MB');
          const order = pendingAttachments.filter(a => a.mime?.startsWith('image/')).length + 1;
          const generic = !file.name || /^(?:image|screenshot|截圖)(?:\s*\(\d+\)|[ _-]?\d+)?\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
          const name = generic ? `截圖 ${order}.${(file.name?.split('.').pop() || 'png').toLowerCase()}` : file.name;
          const item = await api.addImage({ bytes: await file.arrayBuffer(), name });
          if (draftRevision !== revision || (state.current?.key || null) !== draftKey) return;
          if (pendingAttachments.length >= 16 || pendingAttachments.filter(item=>!item.video&&!item.audio).length >= 8) { toast('每次最多 8 個附件'); break; }
          pendingAttachments.push(item); renderAttachments();
        } catch (err) { toast(err.message, 6000); }
      } } finally { pendingPastes--; }
    });
    const saveClaudeConnection = () => saveProvider('claude', { claudePath: $('#sClaudePath').value.trim(), configDir: $('#sClaudeConfig').value.trim() });
    $('#sClaudePath').addEventListener('change', saveClaudeConnection);
    $('#sClaudeConfig').addEventListener('change', saveClaudeConnection);
    $('#btnClaudeConfig').onclick = async () => { const selected = await api.pickFolder($('#sClaudeConfig').value); if (selected) { $('#sClaudeConfig').value = selected; await saveClaudeConnection(); } };
    const checkClaudeConnection = async () => {
      $('#claudeAuthStatus').textContent = '正在檢查此 app 使用的 CLI…';
      try {
        await saveClaudeConnection(); const r = await api.claudeAuthStatus();
        $('#claudeAuthStatus').textContent = `${r.message || '無法取得狀態'}${r.email ? `\n帳號：${r.email}` : ''}${r.subscriptionType ? `\n方案：${planName(r.subscriptionType)}` : ''}\n執行檔：${r.path || '未找到'}\n來源：${r.source || '未知'}\n設定位置：${r.configDirectory || '預設'}${r.authMethod ? `\n登入方式：${r.authMethod}` : ''}`;
      } catch (e) { $('#claudeAuthStatus').textContent = e.message; }
    };
    $('#btnClaudeAuth').onclick = checkClaudeConnection;
    $('#btnClaudeDesktop').onclick = async () => {
      const button = $('#btnClaudeDesktop'); button.disabled = true; button.textContent = '正在沿用桌面版登入…';
      $('#claudeAuthStatus').textContent = '正在讀取 Claude 桌面版的登入憑證…';
      try {
        await saveClaudeConnection();
        const r = await api.importClaudeDesktop();
        if (!r.ok) { toast(r.message || '無法沿用桌面版登入', 9000); }
        else { applySettings(await api.getSettings()); $('#sClaudeConfig').value=state.settings.providers.claude.configDir || ''; state.claudeAccounts = null; state.usage = null; renderComposerBar(); toast(r.switched === false ? '已加入 Claude 桌面版帳號；保留你目前的帳號選擇。' : `已沿用桌面版登入（${r.subscriptionType || 'claude.ai'}）`, 6000); }
      } catch (e) { toast(e.message, 9000); }
      finally { button.disabled = false; button.textContent = '沿用 Claude 桌面版登入'; await checkClaudeConnection(); }
    };
    let authURL = '';
    api.onClaudeAuthURL(url => { authURL = url; $('#btnClaudeAuthURL').hidden = false; });
    $('#btnClaudeAuthURL').onclick = () => { if (authURL) api.openExternal(authURL); };
    $('#btnClaudeLoginCancel').onclick = () => api.cancelClaudeLogin();
    $('#btnClaudeLoginCode').onclick = async () => { const input = $('#sClaudeLoginCode'); const code = input.value; input.value = ''; const r = await api.submitClaudeCode(code); toast(r.message, 6000); };
    $('#btnClaudeLogin').onclick = async () => {
      const button = $('#btnClaudeLogin'); button.disabled = true; button.textContent = '請在瀏覽器完成登入…';
      authURL = ''; $('#btnClaudeAuthURL').hidden = true; $('#claudeAuthFlow').hidden = false; $('#btnClaudeLoginCancel').hidden = false;
      try { await saveClaudeConnection(); const r = await api.loginClaude(); toast(r.message, 8000); if (r.ok) { applySettings(await api.getSettings()); $('#sClaudeConfig').value = state.settings.providers.claude.configDir || ''; state.claudeAccounts = null; state.claudeModels = null; state.usage = null; await checkClaudeConnection(); } }
      catch (e) { toast(e.message, 6000); }
      finally { button.disabled = false; button.textContent = '連接 Claude 帳號'; $('#claudeAuthFlow').hidden = true; $('#btnClaudeLoginCancel').hidden = true; $('#sClaudeLoginCode').value = ''; authURL = ''; }
    };
    $('#btnAttach').onclick = async () => {
      const button = $('#btnAttach');
      if (button.disabled) return;
      const attachmentDraftKey = state.current?.key || null;
      const attachmentRevision = draftRevision;
      button.disabled = true;
      try {
        const r = await api.pickAttachments({availableSlots:16-pendingAttachments.length,availableNormalSlots:8-pendingAttachments.filter(item=>!item.video&&!item.audio).length});
        if (attachmentRevision !== draftRevision || (state.current?.key || null) !== attachmentDraftKey) { toast('已切換對話，這批附件未加入新對話。'); return; }
        let imageOrder = pendingAttachments.filter(a => a.mime?.startsWith('image/')).length;
        const incoming = (r.items || []).map(a => {
          if (!a.mime?.startsWith('image/')) return a;
          imageOrder++;
          return /^(?:image|screenshot|截圖)(?:\s*\(\d+\)|[ _-]?\d+)?\.(?:png|jpe?g|webp|gif)$/i.test(a.name || '')
            ? { ...a, name: `截圖 ${imageOrder}.${a.name.split('.').pop().toLowerCase()}` } : a;
        });
        pendingAttachments = [...pendingAttachments, ...incoming].slice(0, 16); renderAttachments();
        if (r.videos?.length) toast(r.videos.map(v => v.kind === 'audio' ? `${v.name}：已產生音訊分析圖（波形／頻譜／速度／調性；模型聽不到聲音）` : `${v.name}：已擷取 ${v.dense} 格影格拼版 ${v.sheets} 張＋關鍵影格 ${Math.max(0, v.frames - v.sheets)} 張${v.audio ? '＋音軌分析' : v.audioError ? `（${v.audioError}）` : ''}`).join('\n'), 9000);
        if (r.errors?.length) toast(r.errors.join('；'), 6000);
      } catch (e) { toast(e.message, 6000); }
      finally { button.disabled = false; }
    };
    let importPending=false;
    const importFromFile = async (folder=false) => {
      if(importPending)return;
      importPending=true;
      const dlg=$('#chatImportDlg');
      if(dlg.open)dlg.close();
      $('#chatImportErrors').textContent='';$('#chatImportClose').hidden=true;$('#chatImportCancel').hidden=false;$('#chatImportCancel').disabled=false;
      $('#chatImportDestination').textContent='儲存位置：載入中…';
      $('#chatImportProgress').textContent='準備載入…';
      const off=api.onChatImportProgress(data=>{
        if(data.phase==='done')return;
        if(!dlg.open)dlg.showModal();
        $('#chatImportProgress').textContent=data.phase==='scan'?`正在檢查既有對話識別資料：${data.count} 段（不載入正文）`:
          data.phase==='restore'?`已處理 ${data.count} 段；已還原 ${data.restored} 段，重複 ${data.skipped} 段，失敗 ${data.errors} 段`:'正在逐段載入對話…';
      });
      const cancel=()=>{if(importPending){$('#chatImportCancel').disabled=true;$('#chatImportProgress').textContent='正在取消，已完成的對話會保留…';api.cancelChatImport();}else dlg.close();};
      $('#chatImportCancel').onclick=cancel;$('#chatImportClose').onclick=()=>dlg.close();
      dlg.oncancel=event=>{if(importPending){event.preventDefault();cancel();}};
      try {
        const storage=await api.chatStorageInfo();
        $('#chatImportDestination').textContent='儲存位置：'+storage.directory;
        const r=await (folder?api.importChatFolder():api.importChat());
        state.settings=await api.getSettings();await refreshSidebar();
        const parts=[];
        if(r.restored)parts.push(`已還原 ${r.restored} 段對話`);
        if(r.keys?.length>(r.restored||0))parts.push(`已匯入 ${r.keys.length-(r.restored||0)} 段對話`);
        if(r.skipped)parts.push(`${r.skipped} 段已存在，保留既有對話`);
        if(r.cancelled)parts.push('已取消，已完成項目保留');
        if(r.errors?.length)parts.push(`${r.errors.length} 項失敗，成功項目已保留`);
        if(!parts.length)parts.push('沒有可匯入的對話');
        $('#chatImportProgress').textContent=parts.join('；');
        $('#chatImportErrors').textContent=(r.errors||[]).join('\n');
        if(!r.cancelled||r.keys?.length||r.errors?.length){if(!dlg.open)dlg.showModal();}else if(dlg.open)dlg.close();
        const target=r.keys?.[0]||r.dupKeys?.[0];
        if(target){await openChat(target);await revealInSidebar(target);}
      }catch(error){$('#chatImportProgress').textContent='載入失敗';$('#chatImportErrors').textContent=error.message;if(!dlg.open)dlg.showModal();}
      finally{off();importPending=false;$('#chatImportCancel').hidden=true;$('#chatImportClose').hidden=false;}
    };
    $('#btnImport').onclick = async () => {
      const info=await api.chatStorageInfo();
      openMenu($('#btnImport'), { title: '匯入／還原', items: [
        { label: '從檔案匯入對話／還原備份…', desc: '選擇 .cmbak、JSON 或文字匯出檔', onSelect: () => importFromFile() },
        { label: '選擇對話資料夾載入…', desc: '從舊版資料目錄或 chats 匯入一份，原檔保留', onSelect: () => importFromFile(true) },
        { label: '目前對話儲存位置', desc: info.directory, onSelect: () => { toast(info.directory,15000); } },
        { label: '載入 Codex 本機對話', desc: '先選專案，再挑要加入側欄的對話', onSelect: () => openSourceProjectPicker('codex') },
        { label: '載入 Claude Code 本機對話', desc: '先選專案，再挑要加入側欄的對話', onSelect: () => openSourceProjectPicker('claude') },
      ] });
    };
    $('#btnNew').onclick = newChat;
    $('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value;
      const q = e.target.value.trim();
      if (!q) { api.cancelChatSearch(); state.contentSearch = null; renderSidebar(); return; }
      if (/codex:\/\/threads\/|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) { renderSidebar(); return; }
      runContentSearch(q);
    }, 350));
    bindSearchUi();
    $('#search').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (e.key !== 'Enter' || e.isComposing) return;
      const v = e.target.value.trim();
      if (/codex:\/\/threads\/|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) { e.preventDefault(); openByLink(v); }
      else if (v) { e.preventDefault(); runContentSearch(v); }
    });
    $('#btnOpenLink').onclick = async () => {
      const clip = (await api.readClipboardText().catch(() => '')).trim();
      if (/codex:\/\/threads\/[0-9a-f-]{36}/i.test(clip) && await openByLink(clip)) return;
      const box = $('#linkBox');
      box.hidden = false;
      $('#linkInput').value = '';
      $('#linkInput').focus();
    };
    $('#linkBox').onsubmit = (e) => { e.preventDefault(); const v = $('#linkInput').value.trim(); if (v) openByLink(v); };
    $('#linkCancel').onclick = () => { $('#linkBox').hidden = true; };
    $('#linkInput').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.key === 'Escape') $('#linkBox').hidden = true; });
    $('#btnBackupAll').onclick = () => backupKeys(null);
    $('#extBtn').onclick = openExtMenu;
    $('#btnExtAdd').onclick = openExtDialog;
    $('#btnSkillFolder').onclick = () => importSkill('folder');
    $('#btnSkillMd').onclick = () => importSkill('file');
    $('#btnExtLoad').onclick = async () => {
      try {
        const r = await api.importExtensions();
        if (r.cancelled) return;
        state.settings = await api.getSettings(); await loadExtensions();
        toast(`已載入 ${r.count} 個 MCP 擴充；在對話的「擴充」選單勾選即可使用`);
      } catch (e) { toast(e.message, 8000); }
    };
    $('#btnExtRefresh').onclick = () => loadExtensions();
    $('#xCancel').onclick = () => $('#extDlg').close();
    $('#xTransport').onchange = syncExtDialog;
    $('#extForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        state.extensions = await api.saveExtensions({ addCustom: {
          name: $('#xName').value.trim(), prefix: $('#xPrefix').value.trim(), transport: $('#xTransport').value,
          command: $('#xCommand').value.trim(), args: $('#xArgs').value.trim(), url: $('#xUrl').value.trim(),
        } });
        state.settings = await api.getSettings();
        $('#extDlg').close();
        renderExtSettings(); renderExtPill();
      } catch (err) { $('#xError').hidden = false; $('#xError').textContent = err.message; }
    });
    $('#optArchived').onchange = async (e) => { state.settings = await api.saveSettings({ showArchived: e.target.checked }); renderSidebar(); };
    $('#optSub').onchange = async (e) => { state.settings = await api.saveSettings({ showSubagents: e.target.checked }); renderSidebar(); };
    $('#btnSidebarFolder').onclick = openSidebarFolder;
    $('#btnSettings').onclick = openSettings;

    document.querySelectorAll('#providerSwitch button[data-p]').forEach((b) => { b.onclick = () => setProvider(b.dataset.p); });
    $('#modelBtn').onclick = openModelMenu;
    $('#wangpinPlanBtn').onclick = openWangpinPlan;
    $('#effortBtn').onclick = openEffortMenu;
    $('#keyBtn').onclick = openKeyMenu;
    $('#projectBtn').onclick = openProjectMenu;
    $('#permBtn').onclick = openPermMenu;
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { const run = currentRun(); if (run) scheduleRender(run); }
    });
    const ta = $('#input');
    ta.addEventListener('compositionstart', () => { draftEditRevision++; });
    ta.addEventListener('input', () => { draftEditRevision++; autosize(); });
    ta.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });
    { // Warm the next conversation while the pointer rests on it; the click then finds it cached.
      let hoverTimer = 0, hoverKey = '';
      const threads = $('#threadList');
      threads.addEventListener('pointerover', (e) => {
        const key = e.target.closest?.('.thread')?.dataset?.key;
        if (!key || key === hoverKey || key === state.current?.key) return;
        hoverKey = key; clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => { api.prefetchChat?.(key).catch(() => {}); }, 80);
      });
      threads.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); hoverKey = ''; });
    }
    $('#btnSend').onclick = send;
    $('#btnPause').onclick = async () => { const run=currentRun(); if(!run || run.pausing)return; run.pausing=true; updateSendButton(); try {await stopAndReconcile(run,true);} catch(e){toast(e.message);run.pausing=false;updateSendButton();} };
    $('#btnResume').onclick = async () => {
      if(!state.current || currentRun() || starting)return;
      const message='接續這段對話尚未完成的任務，先確認目前進度，從中斷處繼續；不要重複已完成的操作。';
      $('#input').value=message; await send();
    };

    document.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && ['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(e.key)) { e.preventDefault(); setProvider(ORDER[Number(e.key) - 1]); }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleBrowser(); }
      if (e.key === 'Escape' && currentRun() && !openPop && !document.querySelector('dialog[open]')) { api.cancel(currentRun().reqId); }
    });

    $('#chatTitle').addEventListener('change', async (e) => {
      if (!state.current) return;
      const rr = await api.renameThread({ key: state.current.key, threadId: state.current.threadId, title: e.target.value });
      if (state.current.threadId && rr && !rr.synced) toast('只改了這個 App 裡的名稱，Codex 目前沒有接受改名', 3500);
      await refreshSidebar();
    });
    $('#chatTitle').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.key === 'Enter') e.target.blur(); });
    $('#btnOpenCodex').onclick = () => state.current && state.current.threadId && api.openCodexThread(state.current.threadId);
    $('#btnExportDistill').onclick = openDistillExport;

    // API 設定
    document.querySelectorAll('#settingsDlg [data-close]').forEach((b) => { b.onclick = () => $('#settingsDlg').close(); });
    const saveOther = debounce(async () => {
      state.settings = await api.saveSettings({ systemPrompt: $('#sSystem').value, maxContextChars: Number($('#sMaxChars').value) || 120000 });
    }, 400);
    const saveBrowserSettings = debounce(async () => {
      const appEnabled = $('#sAppBrowserEnabled').checked;
      const braveEnabled = $('#sBraveBrowserEnabled').checked;
      state.settings = await api.saveSettings({ browser: { path: $('#sBravePath').value.trim(), enabled: $('#sBraveEnabled').checked, appEnabled: false, braveEnabled, preferBraveExtension: $('#sBraveCodexExtension').checked, engine: 'brave', profile: $('#sBraveProfile').value, background: $('#sBraveBackground').checked, syncBraveLogin: $('#sBraveSyncLogin').checked, revealPanel: false } });
      renderComposerBar();
    }, 400);
    $('#sBravePath').addEventListener('input', saveBrowserSettings);
    $('#sBraveEnabled').addEventListener('change', saveBrowserSettings);
    $('#sAppBrowserEnabled').addEventListener('change', saveBrowserSettings);
    $('#sBraveBrowserEnabled').addEventListener('change', saveBrowserSettings);
    $('#sBraveProfile').addEventListener('change', saveBrowserSettings);
    $('#sBraveBackground').addEventListener('change', saveBrowserSettings);
    $('#sBraveSyncLogin').addEventListener('change', saveBrowserSettings);
    $('#sBrowserReveal').addEventListener('change', saveBrowserSettings);
    $('#btnImportBraveLogin').onclick = async () => {
      $('#braveStatus').textContent = '正在從你的 Brave 讀取登入狀態…';
      $('#braveStatus').textContent = describeLoginSync(await api.importBraveLogin(), true);
    };
    $('#btnRestartUserBrave').onclick = async () => {
      if (!confirm('會先正常關閉你所有的 Brave 視窗，再帶著原本的分頁重新開啟，並開啟除錯埠讓工作台接上。\n\n確定要重新啟動嗎？')) return;
      $('#braveStatus').textContent = '正在重新啟動 Brave…';
      const r = await api.restartUserBrave();
      $('#braveStatus').textContent = r.ok ? (r.already ? `你的 Brave 已經開著除錯埠（${r.port}），不用重新啟動。` : `已重新啟動 Brave，除錯埠 ${r.port}。`) : r.message;
    };
    $('#btnBraveTest').onclick = async () => {
      $('#braveStatus').textContent = '正在啟動 Brave 的除錯連線…';
      try {
        await saveBrowserSettings();
        const info = await api.browserStart();
        $('#braveStatus').textContent = `已連上 ${info.browser || 'Brave'}（除錯埠 ${info.port}）${info.hidden ? '\n在背景執行，不會出現視窗（要看到畫面請取消勾選「在背景操作」）' : ''}\n設定檔：${info.profileDir}\n執行檔：${info.bravePath}`;
      } catch (e) {
        const found = await api.browserDetect().catch(() => null);
        $('#braveStatus').textContent = `${e.message}${found ? `\n自動偵測結果：${found.path || '（找不到）'}\n找過：${(found.tried || []).join('\n')}` : ''}`;
      }
    };
    $('#sSystem').addEventListener('input', saveOther);
    $('#sMaxChars').addEventListener('input', saveOther);
    $('#keyForm').addEventListener('submit', submitKeyEditor);
    $('#kCancel').onclick = () => { $('#keyDlg').close(); };
    $('#keyDlg').addEventListener('close', () => { keyEditing = null; $('#kCancel').textContent = '取消'; });
    $('#kShow').onclick = () => { const k = $('#kKey'); const show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('#kShow').textContent = show ? '隱藏' : '顯示'; };

    // 側欄寬度
    const rz = $('#resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault(); rz.classList.add('drag');
      const move = (ev) => { const w = Math.max(220, Math.min(520, ev.clientX)); document.documentElement.style.setProperty('--side-w', `${w}px`); syncPanels(); };
      const up = () => { rz.classList.remove('drag'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); localStorageSafeSet(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });

    bindPanels();
    api.onStream(onStream);
    // 使用者在檔案總管整理了側欄管理資料夾：重新整理側欄，同步時會套用那些刪除／搬移
    api.onSidebarMirrorChanged(debounce(() => { if (!state.renaming) refreshSidebar(); }, 300));
    api.onSidebarChanged(debounce(async () => {
      if (state.renaming || openPop) return;
      const before = state.current && state.sidebar.items.find((i) => i.key === state.current.key);
      await refreshSidebar();
      if (state.current && !currentRun()) {
        const after = state.sidebar.items.find((i) => i.key === state.current.key);
        // Flow events already applied this saved revision without disturbing live UI.
        if (before && after && after.updatedAt > Math.max(before.updatedAt || 0, state.current.flowSavedAt || 0)) await openChat(state.current.key, { keepScroll: true });
      }
    }, 400));
  }

  function localStorageSafeSet() {
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
    if (w) api.saveSettings({ sideWidth: w });
  }

  async function newChat() {
    const nextProject = currentProject();
    saveDraft(); viewEpoch++;
    chatSelectionReady = Promise.resolve({});
    draftRevision++;
    pendingAttachments = []; renderAttachments();
    state.current = null; try {sessionStorage.removeItem('wangpin-recovery-chat');} catch {}
    state.pendingCwd = nextProject;
    state.pendingExtensions = [];
    state.pendingHarness = ''; state.pendingSystemPrompt = '';
    $('#input').value=''; autosize();
    renderHeader();
    renderMessages();
    renderSidebar();
    updateSendButton();
    $('#input').focus();
  }

  // ---------------- 內建瀏覽器（右側面板） ----------------
  const browserUi = { open: false, suspended: false, state: { tabs: [] }, scopeKeys: new Map() };

  function browserBounds() {
    const r = $('#bpViewport').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  async function syncBrowser() {
    const key = state.current?.key || null;
    const open = browserUi.open && !!key;
    $('#app').classList.toggle('with-browser', open);
    $('#browserPane').hidden = !open;
    $('#browserResizer').hidden = !open;
    $('#btnBrowser').setAttribute('aria-pressed', String(open));
    // 等版面更新後再量尺寸；對話框打開時不用量，立刻隱藏網頁
    if (open && !browserUi.suspended) await new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 60); });
    const visible = open && !browserUi.suspended;
    try { browserUi.state = await api.appBrowserShow({ key, open: visible, bounds: open ? browserBounds() : null }); }
    catch { browserUi.state = { tabs: [] }; }
    if ((state.current?.key || null) === key) renderBrowserBar();
  }

  function markBrowserActivity(on) {
    const b = $('#btnBrowser');
    if (!b) return;
    b.classList.toggle('activity', !!on);
    b.title = on ? '模型正在背景操作網頁，點一下查看（Ctrl+Shift+B）' : '開關內建瀏覽器（Ctrl+Shift+B）';
  }

  function toggleBrowser(force) {
    return;
    browserUi.open = typeof force === 'boolean' ? force : !browserUi.open;
    if (browserUi.open) markBrowserActivity(false);
    syncBrowser();
    if (browserUi.open && !(browserUi.state.tabs || []).length) setTimeout(() => $('#bpUrl').focus(), 60);
  }

  function renderBrowserBar() {
    const tabs = browserUi.state.tabs || [];
    const active = tabs.find((t) => t.active);
    $('#bpEmpty').hidden = !!active;
    const url = $('#bpUrl');
    if (document.activeElement !== url) url.value = active && active.url !== 'about:blank' ? active.url : '';
    $('#bpBack').disabled = !active || !active.canBack;
    $('#bpForward').disabled = !active || !active.canForward;
    $('#bpReload').disabled = !active;
    $('#bpReload').title = active && active.loading ? '停止載入' : '重新整理';
    $('#bpExternal').disabled = !active || !/^https?:/i.test(active.url || '');
    const box = $('#bpTabs');
    box.innerHTML = '';
    box.hidden = !tabs.length;
    for (const t of tabs) {
      box.append(h('div', { class: `bp-tab${t.active ? ' active' : ''}${t.loading ? ' loading' : ''}`, title: t.url, onclick: () => browserAction('select', { tabId: t.tabId }) },
        h('span', { text: t.title || (t.url === 'about:blank' ? '新分頁' : t.url) || '新分頁' }),
        h('b', { class: 'x', text: '×', title: '關閉分頁', onclick: (e) => { e.stopPropagation(); browserAction('close', { tabId: t.tabId }); } })));
    }
    if (tabs.length) box.append(h('button', { class: 'bp-tab new', type: 'button', text: '＋', title: '新分頁', onclick: () => { browserAction('newTab'); setTimeout(() => $('#bpUrl').focus(), 60); } }));
  }

  async function browserAction(action, extra = {}) {
    const key = state.current?.key;
    if (!key) { toast('請先開啟一段對話'); return; }
    try {
      browserUi.state = await api.appBrowserAction({ key, action, ...extra });
      if (state.current?.key === key) renderBrowserBar();
      if (['navigate', 'newTab', 'select', 'close'].includes(action)) syncBrowser();
    } catch (e) { toast(e.message, 5000); }
  }

  async function keysForScope(scope) {
    if (!scope) return [];
    if (state.current?.chatId === scope) return [state.current.key];
    if (!browserUi.scopeKeys.has(scope)) browserUi.scopeKeys.set(scope, await api.appBrowserKeys(scope).catch(() => []));
    return browserUi.scopeKeys.get(scope);
  }

  async function onAppBrowser(type, data) {
    const key = state.current?.key;
    if (!key) return;
    const keys = await keysForScope(data && data.scope);
    if (!keys.includes(key) || state.current?.key !== key) return;
    // 預設不自動展開面板（不打斷使用者正在看的內容）：網頁照樣在背景運作，按鈕亮起提示
    if (type === 'reveal' && !browserUi.open && (state.settings.browser || {}).revealPanel !== true) { markBrowserActivity(true); return; }
    if (type === 'reveal' && !browserUi.open) { browserUi.open = true; syncBrowser(); return; }
    if (type === 'reveal') { syncBrowser(); return; }
    try { browserUi.state = await api.appBrowserState(key); } catch { return; }
    if (state.current?.key === key) renderBrowserBar();
  }

  // 對話框、圖片預覽打開時先把網頁藏起來，不然會蓋在它們上面
  function watchOverlays() {
    const check = () => {
      const suspended = !!document.querySelector('dialog[open]');
      if (suspended === browserUi.suspended) return;
      browserUi.suspended = suspended;
      if (browserUi.open) syncBrowser();
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  }

  // ---------------- 子 agent 面板 ----------------
  const agentUi = { open: false, key: null, list: [], drafts: new Map(), talking: new Set(), timer: null };
  const AGENT_STATUS = { queued: '排隊中', running: '執行中', completed: '已完成', failed: '失敗', cancelled: '已停止', interrupted: '已中斷' };
  const agentActive = (a) => a.status === 'running' || a.status === 'queued';

  async function refreshAgents() {
    const key = state.current?.key || null;
    agentUi.key = key;
    let list = [];
    if (key) { try { list = await api.listAgents(key); } catch { list = []; } }
    if (agentUi.key !== key) return;
    agentUi.list = Array.isArray(list) ? list : [];
    renderAgents();
    clearTimeout(agentUi.timer);
    if (agentUi.open && agentUi.list.some(agentActive)) agentUi.timer = setTimeout(refreshAgents, 2500);
  }

  function renderAgents() {
    const list = agentUi.list || [];
    const active = list.filter(agentActive).length;
    const badge = $('#agentCount');
    badge.hidden = !list.length;
    badge.textContent = active ? `${active} 執行中` : String(list.length);
    badge.classList.toggle('running', !!active);
    $('#btnAgents').setAttribute('aria-pressed', String(agentUi.open));
    const panel = $('#agentPanel');
    panel.hidden = !agentUi.open || !state.current;
    if (panel.hidden) return;
    const box = $('#agentList');
    const focusedEditor = document.activeElement;
    const focused = focusedEditor && focusedEditor.dataset ? focusedEditor.dataset.agentMsg : null;
    const focusedSelection = focused ? { start: focusedEditor.selectionStart, end: focusedEditor.selectionEnd, direction: focusedEditor.selectionDirection } : null;
    if (agentUi.renderedKey === state.current?.key && focused && inputComposition.isComposing({ target: document.activeElement })) {
      agentUi.compositionTarget = document.activeElement;
      return;
    }
    agentUi.compositionTarget = null;
    agentUi.renderedKey = state.current?.key;
    box.innerHTML = '';
    for (const a of list) {
      const running = agentActive(a);
      const meta = [LABELS[a.provider] || a.provider, a.model, AGENT_STATUS[a.status] || a.status, a.tools ? `${a.tools} 次工具` : '', a.queued ? `${a.queued} 則待處理` : ''].filter(Boolean).join(' · ');
      const summary = a.error || a.result || a.lastText || '';
      const card = h('div', { class: 'agent-card' },
        h('span', { class: `agent-dot ${a.status}`, title: AGENT_STATUS[a.status] || a.status }),
        h('div', { class: 'agent-title', title: meta }, h('b', { text: a.name }), ` · ${meta}`),
        h('div', { class: 'agent-actions' },
          h('button', { class: 'btn-small', type: 'button', text: '開啟', title: '查看這個 agent 的完整對話', onclick: () => openChat(a.key) }),
          h('button', { class: 'btn-small', type: 'button', text: '傳訊息', onclick: () => { if (agentUi.talking.has(a.id)) agentUi.talking.delete(a.id); else agentUi.talking.add(a.id); renderAgents(); const el = box.querySelector(`[data-agent-msg="${a.id}"]`); if (el) el.focus(); } }),
          running ? h('button', { class: 'btn-small', type: 'button', text: '停止', onclick: async () => { try { await api.cancelAgent(a.id); } catch (e) { toast(e.message); } refreshAgents(); } }) : null));
      if (summary) card.append(h('div', { class: `agent-summary${a.error ? ' err' : ''}`, text: summary, title: summary }));
      if (agentUi.talking.has(a.id)) {
        const input = h('input', { placeholder: running ? '執行中：會排在這一輪結束後處理' : '給這個 agent 的後續指示（Enter 送出）', dataset: { agentMsg: a.id } });
        input.value = agentUi.drafts.get(a.id) || '';
        input.addEventListener('input', () => agentUi.drafts.set(a.id, input.value));
        const submit = async () => {
          const text = input.value.trim();
          if (!text) return;
          try { await api.messageAgent({ id: a.id, message: text }); agentUi.drafts.delete(a.id); agentUi.talking.delete(a.id); toast(running ? '已排入佇列' : '已送出'); }
          catch (e) { toast(e.message, 5000); }
          refreshAgents();
        };
        input.addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
        card.append(h('div', { class: 'agent-msg' }, input, h('button', { class: 'btn-small primary', type: 'button', text: '送出', onclick: submit })));
      }
      box.append(card);
    }
    if (focused) {
      const el = box.querySelector(`[data-agent-msg="${focused}"]`);
      if (el) {
        el.focus();
        el.setSelectionRange(Math.min(focusedSelection.start ?? el.value.length, el.value.length), Math.min(focusedSelection.end ?? el.value.length, el.value.length), focusedSelection.direction || 'none');
      }
    }
  }

  function toggleAgents(force) {
    if (!state.current) { toast('請先開啟一段對話'); return; }
    agentUi.open = typeof force === 'boolean' ? force : !agentUi.open;
    if (agentUi.open) {
      const sel = $('#agentProvider');
      if (!sel.dataset.touched) sel.value = state.provider;
    }
    refreshAgents();
    if (agentUi.open) setTimeout(() => $('#agentTask').focus(), 30);
  }

  async function spawnAgentFromForm(e) {
    e.preventDefault();
    const key = state.current?.key;
    if (!key) { toast('請先開啟一段對話'); return; }
    const task = $('#agentTask').value.trim();
    if (!task) { toast('請輸入要交給 agent 的任務'); $('#agentTask').focus(); return; }
    if (runForKey(key) === null && !state.current.chatId && !state.current.threadId) { toast('請先在這段對話送出一則訊息'); return; }
    const btn = $('#agentSpawn');
    btn.disabled = true;
    try {
      const a = await api.spawnAgent({ parentKey: key, task, name: $('#agentName').value.trim(), provider: $('#agentProvider').value, model: $('#agentModel').value.trim() });
      $('#agentTask').value = '';
      $('#agentName').value = '';
      toast(`已建立 agent「${a.name}」`);
    } catch (err) { toast(err.message, 6000); }
    finally { btn.disabled = false; }
    refreshAgents();
  }

  function bindPanels() {
    $('#btnBrowser').onclick = () => toggleBrowser();
    $('#bpClose').onclick = () => toggleBrowser(false);
    $('#bpBack').onclick = () => browserAction('back');
    $('#bpForward').onclick = () => browserAction('forward');
    $('#bpReload').onclick = () => browserAction('reload');
    $('#bpExternal').onclick = () => browserAction('external');
    $('#bpForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = $('#bpUrl').value.trim();
      if (!url) return;
      $('#bpUrl').blur();
      browserAction('navigate', { url });
    });
    $('#bpUrl').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return; if (e.key === 'Escape') { e.stopPropagation(); e.target.blur(); renderBrowserBar(); } });
    new ResizeObserver(() => { if (browserUi.open) syncPanels(); }).observe($('#bpViewport'));
    window.addEventListener('resize', () => { if (browserUi.open) syncPanels(); });
    const rz = $('#browserResizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault(); rz.classList.add('drag');
      const move = (ev) => { const w = Math.max(360, Math.min(window.innerWidth - 700, window.innerWidth - ev.clientX)); document.documentElement.style.setProperty('--browser-w', `${w}px`); syncPanels(); };
      const up = () => {
        rz.classList.remove('drag'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--browser-w'), 10);
        if (w) api.saveSettings({ browserWidth: w });
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    watchOverlays();
    api.onAppBrowser((type, data) => { onAppBrowser(type, data); });

    $('#btnAgents').onclick = () => toggleAgents();
    $('#btnAgentClose').onclick = () => toggleAgents(false);
    $('#agentForm').addEventListener('submit', spawnAgentFromForm);
    $('#agentProvider').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
    $('#agentTask').addEventListener('keydown', (e) => { if (inputComposition.isComposing(e)) return;
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); $('#agentForm').requestSubmit(); }
      if (e.key === 'Escape') { e.stopPropagation(); toggleAgents(false); }
    });
    // Refreshing agent cards must not replace an editor while its IME candidate
    // is active. Resume one deferred render after the final committed input.
    const resumeAgentComposition = (event) => {
      if (agentUi.compositionTarget !== event.target) return;
      setTimeout(() => {
        if (agentUi.compositionTarget !== event.target || inputComposition.isComposing({ target: event.target })) return;
        agentUi.compositionTarget = null;
        renderAgents();
      }, 0);
    };
    document.addEventListener('compositionend', resumeAgentComposition);
    document.addEventListener('focusout', resumeAgentComposition);
    const agentsChanged = debounce(() => refreshAgents(), 250);
    api.onAgentsChanged((d) => { if (d && d.parentKey === state.current?.key) agentsChanged(); });
  }

  async function init() {
    state.settings = await api.getSettings();
    if (state.settings.sideWidth) document.documentElement.style.setProperty('--side-w', `${state.settings.sideWidth}px`);
    if (state.settings.browserWidth) document.documentElement.style.setProperty('--browser-w', `${state.settings.browserWidth}px`);
    $('#optArchived').checked = !!state.settings.showArchived;
    $('#optSub').checked = !!state.settings.showSubagents;
    bind();
    const initialProvider = state.settings.lastProvider === 'grokbot' ? 'grokbuild' : REMOVED_PROVIDERS.has(state.settings.lastProvider) ? 'codex' : ORDER.includes(state.settings.lastProvider) ? state.settings.lastProvider : 'codex';
    setProvider(initialProvider, { save: REMOVED_PROVIDERS.has(state.settings.lastProvider) });
    renderMessages();
    await refreshSidebar();
    if (state.settings.browser?.enabled && state.settings.browser?.braveEnabled !== false && !state.settings.browser?.braveSetupSeen) {
      state.settings = await api.saveSettings({browser:{braveSetupSeen:true}});
      api.browserPrepare({reason:'第一次使用外部 Brave，先確認安裝位置與官方擴充的必要設定。'}).catch(error=>toast(`無法檢查 Brave，請稍後重新偵測：${error.message}`,6000));
    }
    // Session storage survives a renderer reload, without launching another model turn.
    try {
      const key=sessionStorage.getItem('wangpin-recovery-chat');
      if (key && state.sidebar.items.some(item=>item.key===key)) await openChat(key);
    } catch(error) { toast('畫面已恢復，請从側欄重新開啟對話',5000); }
    bindSchedule();
    detectCodexQuiet();
    loadCodexAccounts();
    refreshGptWebAccounts().catch(() => {});
    loadExtensions();
    scheduleUsageRefresh(1500);
    if (state.settings.appVersion && state.settings.lastSeenVersion !== state.settings.appVersion) {
      if (state.settings.lastSeenVersion) toast(`已更新到 ${state.settings.appVersion}`, 4000);
      api.saveSettings({ lastSeenVersion: state.settings.appVersion }).then((ns) => { state.settings = ns; });
    }
    setInterval(() => refreshUsage(), 5 * 60 * 1000);
  }

  init();
})();
