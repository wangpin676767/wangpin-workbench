(() => {
  'use strict';
  let context = { enabled: false, key: null };
  let webpage = true, login = false, scheduled = false, lastPayload = '', retryNext = false, loginNext = false, revision = 0, authNote = '';
  const bar = document.createElement('div');
  bar.id = 'gptWebToolbar'; bar.hidden = true;
  bar.style.cssText = 'padding:6px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);font-size:12px;flex-shrink:0';
  const toggle = document.createElement('button'); toggle.className = 'btn-small'; toggle.type = 'button';
  const baseNote = '使用下方 App 輸入框送出，回覆會同步保存。直接在網頁輸入的內容尚不會同步保存。';
  const note = document.createElement('span'); note.textContent = baseNote;
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-small'; retry.textContent = '重試載入'; retry.hidden = true;
  const signIn = document.createElement('button'); signIn.type = 'button'; signIn.className = 'btn-small'; signIn.textContent = '登入 ChatGPT';
  const check = document.createElement('button'); check.type = 'button'; check.className = 'btn-small'; check.textContent = '檢查登入';
  bar.style.flexWrap = 'wrap';
  bar.append(toggle, signIn, check, note, retry);
  const messages = document.getElementById('messages'); messages.before(bar);
  // Native child views sit above renderer content, so hide them while dialogs or menus are open.
  function flush() {
    scheduled = false;
    const enabled = context.enabled || login;
    if (bar.hidden === enabled) bar.hidden = !enabled;
    const display = enabled ? 'flex' : 'none'; if (bar.style.display !== display) bar.style.display = display;
    const label = webpage ? '查看保存的對話' : '查看 ChatGPT 網頁'; if (toggle.textContent !== label) toggle.textContent = label;
    const obstructed = !!document.querySelector('dialog[open], [role="menu"], .menu-popover, .menu-backdrop');
    const rect = messages.getBoundingClientRect();
    const payload = { key: context.key, login, visible: enabled && webpage && !obstructed && !document.hidden,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    const encoded = JSON.stringify(payload);
    if (encoded === lastPayload && !retryNext && !loginNext) return;
    lastPayload = encoded;
    const requestRevision = ++revision;
    const reload = retryNext; retryNext = false;
    const startLogin = loginNext; loginNext = false;
    if (payload.visible) status({ status: 'loading' });
    window.api.gptWebView({ ...payload, retry: reload, startLogin }).then(result => {
      if (requestRevision !== revision) return;
      if (payload.visible && result?.ok) status({ status: result.status || 'ready' });
      if (payload.visible && result?.auth) showAuth(result.auth);
    }).catch(error => { if (requestRevision === revision) status({ status: 'error', error: { message: String(error.message || error) } }); });
  }
  function status(data) {
    const message = data.status === 'loading' ? '正在載入 ChatGPT 網頁…' : data.status === 'error' ? `ChatGPT 網頁無法開啟：${data.error?.message || '載入失敗'}${data.error?.code ? `（${data.error.code}）` : ''}` : authNote || baseNote;
    if (note.textContent !== message) note.textContent = message;
    const hidden = data.status !== 'error'; if (retry.hidden !== hidden) retry.hidden = hidden;
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(flush); } }
  function showAuth(auth) {
    authNote = auth.message;
    if (note.textContent !== auth.message) note.textContent = auth.message;
    const hidden = auth.loggedIn === true; if (signIn.hidden !== hidden) signIn.hidden = hidden;
  }
  toggle.onclick = () => { webpage = !webpage; schedule(); };
  retry.onclick = () => { retryNext = true; schedule(); };
  signIn.onclick = () => { webpage = true; loginNext = true; schedule(); };
  check.onclick = async () => {
    const requestRevision = revision;
    check.disabled = true;
    try { const auth = await window.api.gptWebStatus(); if (requestRevision === revision) showAuth(auth); }
    catch { if (requestRevision === revision) showAuth({ message: '無法檢查登入，請確認網頁載入後再試。' }); }
    finally { check.disabled = false; }
  };
  window.api.onGptWebViewChanged?.(data => {
    if (data.key !== context.key || !(context.enabled || login) || !webpage) return;
    status(data);
  });
  window.gptWebViewUi = {
    update(next) {
      if (context.key !== next.key || context.enabled !== next.enabled) { revision++; login = false; loginNext = false; authNote = ''; webpage = true; signIn.hidden = false; status({ status: 'ready' }); }
      context = next; schedule();
    },
    login() { login = true; webpage = true; loginNext = true; schedule(); },
  };
  new ResizeObserver(schedule).observe(messages);
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('beforeunload', () => window.api.gptWebView({ visible: false }));
})();
