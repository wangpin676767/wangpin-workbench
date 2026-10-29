'use strict';
// Site adapters intentionally use the visible website, never private account APIs.
const SITES = Object.freeze({
  claude: { title: 'Claude', home: 'https://claude.ai/new', host: 'claude.ai' },
  gemini: { title: 'Gemini', home: 'https://gemini.google.com/app', host: 'gemini.google.com' },
});
function siteInfo(site) {
  if (!Object.hasOwn(SITES, site)) throw new Error('不支援的網頁模型網站');
  return SITES[site];
}
function pageAction(site, action, value, triggerAttempt = 0) {
  const visible = el => !!el && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (s, scope = document) => [...scope.querySelectorAll(s)].filter(visible);
  const first = (s, scope = document) => all(s, scope)[0];
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const label = el => el?.getAttribute('aria-label') || text(el);
  const composer = site === 'claude'
    ? (first('.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]')
      || first('textarea[data-testid="chat-input"], textarea[data-testid="chat-input-textarea"], textarea[placeholder]:not([data-testid="static-composer-input"])'))
    : first('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[aria-label]');
  const assistants = site === 'claude'
    ? all('[data-testid="assistant-message"], [data-is-streaming], .font-claude-response').filter((el, _, nodes) => !nodes.some(parent => parent !== el && parent.contains(el)))
    : all('model-response');
  const users = site === 'claude' ? all('[data-testid="user-message"]') : all('user-query');
  const identity = el => {
    if (!el) return '';
    const key = el.getAttribute('data-message-id') || el.getAttribute('data-testid-message-id') || el.id;
    if (key) return key;
    const state = window.__wangpinWebIdentity ||= { ids: new WeakMap(), next: 0 };
    if (!state.ids.has(el)) state.ids.set(el, 'node-' + ++state.next);
    return state.ids.get(el);
  };
  const controls = all('button, [role="button"]');
  const stop = controls.find(el => /^(?:Stop|Stop response|Stop generating|停止|停止回應|停止生成|停止回答|中止)(?:\s|$)/i.test(label(el)))
    || first('[data-testid="stop-button"], button.stop-button, button[aria-label="Stop Response"]');
  const send = site === 'claude'
    ? first('button[data-testid="chat-input-send"], button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="傳送訊息"], button[aria-label="发送消息"], button[type="submit"]')
    : first('button.send-button, button[aria-label="Send message"], button[aria-label="Send"], button[aria-label="傳送訊息"], button[aria-label="发送消息"]');
  const modelTrigger = () => site === 'claude'
    ? (first('[data-testid="model-selector-dropdown"], [data-testid="model-selector"], [data-cds="ModelSelector"]')
      || controls.find(el=>/^(?:Model|模型)\s*[:：]/i.test(el.getAttribute('aria-label')||'')))
    : (first('[data-test-id="logo-pill-label-container"]')?.closest('button')
      || first('[data-test-id="bard-mode-menu-button"], .bard-mode-menu-button, [data-test-id="model-selector"]')
      || controls.find(el=>/^(?:model|mode|模型|模式|選擇模型|选择模型)(?:\b|\s|[:：])/i.test(el.getAttribute('aria-label')||'')));
  const trigger = modelTrigger();
  const selectedModel = () => {
    const current=modelTrigger();
    if(!current)return '';
    const title=site==='claude' && current.getAttribute('data-cds')==='ModelSelector' ? current.querySelector('.truncate') : null;
    // The modern Claude label nests effort under the model's text span.
    // Read its actual title text node, without guessing model/version names.
    const ownTitle=title?[...title.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim():'';
    const name=(current.getAttribute('data-selected-model') || ownTitle || text(current)).replace(/[\uE000-\uF8FF]/g, '').trim();
    return site==='gemini'?name.replace(/\s+/g,' '):name;
  };
  // innerText adds CSS paragraph spacing as extra newlines in ProseMirror/Quill.
  // Read editable structure instead, retaining explicit blank paragraphs and BRs.
  const inputText = el => {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return el.value;
    const block = node => node.nodeType === 1 && /^(P|DIV|LI|H[1-6]|PRE|BLOCKQUOTE)$/.test(node.tagName);
    const read = node => {
      if (node.nodeType === 3) return node.data;
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return '';
      let result = '', previous = null;
      for (const child of node.childNodes) {
        if (previous && (block(previous) || block(child))) result += '\n';
        result += read(child); previous = child;
      }
      return result;
    };
    return read(el);
  };
  const sameInput = () => !!composer && inputText(composer).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    === String(value).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  if (action === 'verifyInsert') return sameInput();
  if (action === 'insert') {
    if (!composer) return false;
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, value);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(composer);
      selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, value);
    }
    return sameInput();
  }
  if (action === 'send') {
    if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return false;
    send.click(); return true;
  }
  if (action === 'stop') { stop?.click(); return !!stop; }
  if (action === 'selectModel' || action === 'listModels') {
    return (async () => {
      const wanted = String(value || '').trim();
      const listing = action === 'listModels';
      if (!listing && !wanted) return { ok: true, model: selectedModel() };
      // Exact website labels only. No API slug to display-name guessing.
      if (!listing && selectedModel() === wanted) return { ok: true, model: wanted };
      if (!trigger) {
        if(triggerAttempt < 20){await new Promise(resolve=>setTimeout(resolve,150));return pageAction(site,action,value,triggerAttempt+1);}
        return { ok: false };
      }
      const initial = selectedModel();
      const modernGemini=site==='gemini' && !!trigger.querySelector('[data-test-id="logo-pill-label-container"]');
      const gemMenu=()=>site==='gemini'?first('[data-test-id="gem-mode-menu"]'):null;
      const closeMenu=async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(site==='gemini'){await new Promise(resolve=>setTimeout(resolve,80));if(gemMenu()){modelTrigger()?.click();await new Promise(resolve=>setTimeout(resolve,80));}}};
      if (trigger.getAttribute('aria-expanded') !== 'true' && !gemMenu()) trigger.click();
      const optionTitle = el => {
        const named=el.querySelector(site==='gemini'?'[data-model-name], [data-testid="model-name"], .model-name, gem-menu-item-content .label':'[data-model-name], [data-testid="model-name"], .model-name');
        return (named?.getAttribute('data-model-name') || text(named) || label(el)).trim().split('\n').find(part=>part.trim())?.trim() || '';
      };
      for (let attempt = 0; attempt < 20; attempt++) {
        const controlled = document.getElementById(trigger.getAttribute('aria-controls') || '');
        const menus=all('[role="menu"], [role="listbox"]');
        const menu=modernGemini?gemMenu():visible(controlled)?controlled:(site==='gemini'?gemMenu():null)||menus.find(el=>trigger.id && el.getAttribute('aria-labelledby')===trigger.id)||menus[0];
        const options = (modernGemini && !menu?[]:all('[role="menuitemradio"], [role="option"], [data-model-id], [data-testid="model-option"], button[data-model]'+(site==='gemini'?', gem-menu-item[data-mode-id]':''),menu||document))
          .filter(el=>el.getAttribute('aria-disabled')!=='true' && !el.hasAttribute('disabled') && !el.hasAttribute('data-disabled'));
        if (listing && options.length) {
          const seen=new Set();
          const models=options.filter(el=>el.getAttribute('aria-disabled')!=='true' && !el.hasAttribute('disabled'))
            .map(el=>({title:optionTitle(el),description:text(el).split('\n').slice(1).join(' ').replace(/[\uE000-\uF8FF]/g,'').replace(/\s+/g,' ').trim()}))
            .filter(model=>model.title && !seen.has(model.title) && seen.add(model.title));
          const chosen=options.find(el=>el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-selected')==='true'||(site==='gemini'&&el.classList.contains('selected')));
          const defaultModel=chosen?optionTitle(chosen):initial;await closeMenu();return {models,defaultModel};
        }
        const option = options.find(el => optionTitle(el) === wanted || label(el).trim() === wanted || text(el) === wanted);
        if (option) {
          const modeId=site==='gemini'?option.getAttribute('data-mode-id'):null;
          option.click();
          for (let check = 0; check < 12; check++) {
            if (selectedModel() === wanted || (option.isConnected && (option.getAttribute('aria-checked') === 'true' || option.getAttribute('aria-selected') === 'true'||(modeId&&option.classList.contains('selected'))))){
              await closeMenu();return { ok: true, model: wanted };
            }
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          if(modeId){
            // New Gemini shortens the header (e.g. omits a version). Verify
            // exact selected DOM mode identity, never guess from partial names.
            const current=modelTrigger();if(!current)return {ok:false};
            if(current.getAttribute('aria-expanded')!=='true'&&!gemMenu())current.click();
            for(let check=0;check<12;check++){
              const picked=all('[data-test-id="gem-mode-menu"] gem-menu-item[data-mode-id]').find(el=>el.getAttribute('data-mode-id')===modeId);
              if(picked && (picked.classList.contains('selected')||picked.getAttribute('aria-selected')==='true'||picked.getAttribute('aria-checked')==='true')){
                await closeMenu();return {ok:true,model:wanted};
              }
              await new Promise(resolve=>setTimeout(resolve,150));
            }
            await closeMenu();
          }
          return { ok: false };
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      await closeMenu();
      return { ok: false };
    })();
  }
  const node = assistants.at(-1);
  const container = site === 'claude' ? (node?.closest('[data-testid="assistant-turn"], [data-message-id]') || node?.parentElement || node) : node;
  const body = !node ? null : site === 'claude' ? (first('[data-transcript-engine-root]', node)
    || first('[data-perf-reply-text], .standard-markdown, .font-claude-response, .markdown, [data-testid="message-content"]', node) || node)
    : (first('.model-response-text, .response-container-content .markdown, .markdown, message-content', node) || node);
  const actions = container ? all('button, [role="button"]', container) : [];
  const completed = actions.some(el => /copy|複製|复制|good response|bad response|like|dislike|讚|喜欢/i.test(label(el)))
    || !!(container && first('[data-testid="action-bar-copy"], [data-testid="copy-response"], [data-test-id="copy-button"], button.copy-button', container));
  const streaming = !!stop || node?.getAttribute('data-is-streaming') === 'true' || !!(container && first('[aria-busy="true"], .streaming, .result-streaming', container));
  const challenge = /just a moment|verify you are human|驗證您是人類|验证您是真人|checking your browser/i.test(document.title)
    || !!first('#challenge-form, iframe[src*="challenges.cloudflare"], iframe[src*="recaptcha"]');
  const login = /(?:^|\/)login|\/signin|accounts\.google\.com/i.test(location.href)
    || controls.some(el => /^(?:Log in|Sign in|登入|登錄|登录)$/i.test(label(el).trim()));
  const error = all('[role="alert"], [data-testid="error-message"], .error-message').map(text).filter(Boolean).join('\n').slice(0, 800);
  return { url: location.href, composer: !!composer, login, challenge, busy: !!stop,
    sendReady: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
    assistants: assistants.length, users: users.length, lastAssistantId: identity(node), lastUserId: identity(users.at(-1)),
    model: selectedModel(), current: { text: text(body), finished: completed && !streaming, streaming }, error };
}
function script(site, action = 'snapshot', value = '') {
  siteInfo(site);
  return `(${pageAction.toString()})(${JSON.stringify(site)},${JSON.stringify(action)},${JSON.stringify(value)})`;
}
function isSiteUrl(site, value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === siteInfo(site).host; } catch { return false; }
}
function conversationId(site, value) {
  if (!isSiteUrl(site, value)) return '';
  const pathname = new URL(value).pathname;
  return site === 'claude' ? (/^\/chat\/([^/]+)/.exec(pathname)?.[1] || '') : (/^\/app\/([^/]+)/.exec(pathname)?.[1] || '');
}
module.exports = { SITES, siteInfo, script, isSiteUrl, conversationId };
