'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else globalThis.WangpinPlanUI = factory();
})(function wangpinPlanUI() {
  const targets = [
    ['codex', 'Codex CLI'], ['claudecode', 'Claude Code CLI'], ['antigravity', 'Antigravity'],
    ['web:gpt', '網頁版 GPT'], ['web:claude', '網頁版 Claude'], ['web:gemini', '網頁版 Gemini'],
    ['api:gpt', 'GPT API'], ['api:claude', 'Claude API'], ['api:deepseek', 'DeepSeek API'],
    ['api:gemini', 'Gemini API'], ['api:grok', 'Grok API'], ['api:meta', 'Meta API'],
    ['api:ablit', 'Ablit API'], ['api:lmstudio', 'LM Studio']
  ];
  const validTargets = new Set(targets.map(([id]) => id));
  const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled', 'disabled'];
  function effortOptions(target, model, models = []) {
    const entry = models.find(m => (m.id || m.value || m.slug) === model);
    let levels = [];
    if (target === 'codex' || target === 'antigravity') levels = entry?.efforts || [];
    else if (target === 'claudecode') levels = Array.isArray(entry?.efforts) ? entry.efforts : ['low', 'medium', 'high'];
    else if (target === 'api:deepseek') levels = ['enabled', 'disabled'];
    else if (target === 'api:gemini') levels = ['none', 'low', 'medium', 'high'];
    else if (target === 'api:grok') levels = ['low', 'medium', 'high'];
    else if (target === 'api:meta') levels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    else if (target === 'api:gpt' && /^(gpt-[56]|o[134])/.test(model)) levels = ['low', 'medium', 'high'];
    return ['default', ...new Set(levels.filter(e => EFFORTS.includes(e) && e !== 'default'))];
  }
  function stageOf(value, fallback) {
    value = value && typeof value === 'object' ? value : {};
    fallback = fallback && typeof fallback === 'object' ? fallback : {};
    const target = validTargets.has(value.target) ? value.target : validTargets.has(fallback.target) ? fallback.target : 'codex';
    // A model belongs to one provider. Never inherit a fallback provider's model.
    const model = typeof value.model === 'string' && value.target === target ? value.model :
      fallback.target === target && typeof fallback.model === 'string' ? fallback.model : '';
    const out = { target, model };
    const effort = value.target === target ? value.effort : fallback.target === target ? fallback.effort : undefined;
    if (EFFORTS.includes(effort)) out.effort = effort;
    return out;
  }
  function configOf(value, defaults) {
    value = value && typeof value === 'object' ? value : {};
    defaults = defaults && typeof defaults === 'object' ? defaults : {};
    return { enabled: value.enabled === true, plan: stageOf(value.plan, defaults.plan), execute: stageOf(value.execute, defaults.execute) };
  }
  const DEFAULT_TARGET_MODELS = {
    'api:deepseek': [
      { id: 'deepseek-flash', label: 'deepseek-flash · DeepSeek 4.1 Flash' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro · DeepSeek V4 Pro' },
    ]
  };
  function modelOptions(result, target) {
    let list = Array.isArray(result) ? result : result && Array.isArray(result.models) ? result.models : [];
    if (!list.length && DEFAULT_TARGET_MODELS[target]) list = DEFAULT_TARGET_MODELS[target];
    const seen = new Set();
    const options = [];
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry && (entry.id || entry.value || entry.slug || entry.model || entry.name);
      if (typeof id !== 'string' || !id || seen.has(id) || (id === 'opusplan' && target !== 'claudecode')) continue;
      seen.add(id);
      let label = typeof entry === 'object' ? String(entry.label || entry.name || id) : id;
      if (target === 'api:deepseek' && label === id) {
        if (id === 'deepseek-flash') label = `${id} · DeepSeek 4.1 Flash`;
        else if (id === 'deepseek-v4-pro') label = `${id} · DeepSeek V4 Pro`;
      }
      options.push({ id, label, ...(Array.isArray(entry?.efforts) ? { efforts: entry.efforts.filter(e => EFFORTS.includes(e)) } : {}) });
    }
    if (target === 'claudecode' && !seen.has('opusplan')) options.push({ id: 'opusplan', label: 'opusplan' });
    return options;
  }
  function create({ getValue, getDefaults, loadModels, save, onError } = {}) {
    let opened = null;
    let serial = 0;
    const read = () => configOf(getValue && getValue(), getDefaults && getDefaults());
    function render(button) {
      const value = read();
      button.textContent = value.enabled ? 'wangpinplan ✓' : 'wangpinplan';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-pressed', String(value.enabled));
      button.title = value.enabled ? `Plan：${value.plan.target} / ${value.plan.model || '預設模型'} → 執行：${value.execute.target} / ${value.execute.model || '預設模型'}` : '設定 Plan 與執行階段使用的模型';
    }
    function open(anchor) {
      if (opened) { opened.focus(); return; }
      const doc = anchor && anchor.ownerDocument || document;
      const session = ++serial;
      const value = read();
      const dialog = doc.createElement('dialog');
      opened = dialog;
      dialog.className = 'wangpin-plan-dialog';
      dialog.setAttribute('aria-labelledby', `wangpin-plan-title-${session}`);
      // Keep the App's chat/provider/stop shortcuts out of this modal. Native
      // editing, IME and dialog defaults still receive their normal key events.
      dialog.addEventListener('keydown', event => event.stopPropagation());
      const make = (tag, text, parent) => {
        const el = doc.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (parent) parent.appendChild(el);
        return el;
      };
      make('h2', 'wangpinplan', dialog).id = `wangpin-plan-title-${session}`;
      make('p', '先用指定模型規劃，再自動交給執行模型完成任務。', dialog);
      make('p', '中斷後可選上排其他模型，再按「繼續」交接已保存的計畫與操作紀錄；保持 wangpinplan 開啟則會重新規劃。切換模型不會恢復原本的執行程序。', dialog);
      const enableLabel = make('label', undefined, dialog);
      enableLabel.className = 'wangpin-plan-enable';
      const enabled = make('input', undefined, enableLabel);
      enabled.type = 'checkbox'; enabled.checked = value.enabled;
      make('span', '啟用 wangpinplan', enableLabel);
      const grid = make('div', undefined, dialog); grid.className = 'wangpin-plan-stages';
      const controls = [];
      let saving = false;
      let closed = false;
      const error = make('p', '', dialog); error.className = 'wangpin-plan-error'; error.setAttribute('role', 'status');
      const actions = make('div', undefined, dialog); actions.className = 'wangpin-plan-actions';
      const cancel = make('button', '取消', actions); cancel.type = 'button';
      const commit = make('button', '儲存', actions); commit.type = 'button';
      const update = () => {
        commit.disabled = saving || controls.some(c => c.pending) || (enabled.checked && controls.some(c => c.model.value === 'opusplan' && c.target.value !== 'claudecode'));
      };
      for (const [key, title] of [['plan', 'Plan 階段'], ['execute', '執行階段']]) {
        const field = make('fieldset', undefined, grid);
        make('legend', title, field);
        const targetLabel = make('label', '模型來源', field);
        const target = make('select', undefined, targetLabel);
        for (const [id, label] of targets) { const option = make('option', label, target); option.value = id; }
        target.value = value[key].target;
        const modelLabel = make('label', '模型（可自行輸入精確名稱）', field);
        const model = make('input', undefined, modelLabel); model.type = 'text'; model.value = value[key].model;
        model.autocomplete = 'off'; model.spellcheck = false;
        const list = make('datalist', undefined, field); list.id = `wangpin-plan-models-${session}-${key}`;
        model.setAttribute('list', list.id);
        const effortLabel = make('label', '推理強度', field);
        const effort = make('select', undefined, effortLabel);
        effort.setAttribute('data-stage-effort', key);
        let knownModels = [];
        const renderEfforts = (selected = effort.value || value[key].effort || 'default') => {
          const levels = effortOptions(target.value, model.value, knownModels);
          // An offline model read must not silently erase an existing per-stage
          // selection. Only offer new dynamic values from provider metadata.
          const saved = value[key];
          if (!knownModels.length && ['codex', 'antigravity'].includes(target.value) && target.value === saved.target && model.value === saved.model && saved.effort && saved.effort !== 'default') levels.push(saved.effort);
          effort.replaceChildren();
          const unread = !knownModels.length && ['codex', 'antigravity'].includes(target.value);
          for (const level of levels) { const option = make('option', level === 'default' ? (unread ? '預設（請先讀取模型清單）' : levels.length === 1 ? '預設（此模型未提供可調設定）' : '預設') : level, effort); option.value = level; }
          effort.value = levels.includes(selected) ? selected : 'default';
          effort.disabled = levels.length === 1;
        };
        renderEfforts();
        const refresh = make('button', '讀取模型', field); refresh.type = 'button';
        const status = make('p', '', field); status.className = 'wangpin-plan-stage-status'; status.setAttribute('role', 'status');
        const control = { key, target, model, effort, renderEfforts, pending: false, epoch: 0 };
        controls.push(control);
        const seed = () => {
          list.replaceChildren();
          for (const option of modelOptions([], target.value)) { const el = make('option', option.label, list); el.value = option.id; }
        };
        seed();
        target.addEventListener('change', () => {
          ++control.epoch; control.pending = false; refresh.disabled = false;
          model.value = ''; status.textContent = ''; knownModels = []; renderEfforts('default'); seed(); update();
        });
        model.addEventListener('input', () => {
          renderEfforts();
          status.textContent = model.value === 'opusplan' && target.value !== 'claudecode' ? 'opusplan 僅適用於 Claude Code CLI。' : '';
          update();
        });
        refresh.addEventListener('click', async () => {
          const epoch = ++control.epoch;
          const selectedTarget = target.value;
          control.pending = true; refresh.disabled = true; status.textContent = '正在讀取模型…'; update();
          try {
            const result = await loadModels(selectedTarget);
            if (closed || epoch !== control.epoch || target.value !== selectedTarget) return;
            const options = modelOptions(result, selectedTarget);
            knownModels = options; renderEfforts();
            list.replaceChildren();
            for (const option of options) { const el = make('option', option.label, list); el.value = option.id; }
            status.textContent = options.length ? `已讀取 ${options.length} 個模型；也可直接輸入。` : '尚未取得模型清單，可直接輸入模型名稱。';
          } catch (err) {
            if (closed || epoch !== control.epoch) return;
            status.textContent = `讀取失敗：${err && err.message || err}。可保留或自行輸入模型。`;
          } finally {
            if (!closed && epoch === control.epoch) { control.pending = false; refresh.disabled = false; update(); }
          }
        });
      }
      make('p', 'Plan 根據本輪資料產生文字方案，不呼叫本機工具；執行階段沿用所選服務的帳號與權限。', dialog).className = 'wangpin-plan-policy';
      // Keep the policy before the action row in both reading and tab order.
      dialog.insertBefore(dialog.lastChild, error);
      const close = () => {
        if (closed) return;
        closed = true; ++serial; opened = null;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
      };
      cancel.addEventListener('click', close);
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!saving) close(); });
      commit.addEventListener('click', async () => {
        if (commit.disabled || saving) return;
        const captured = { enabled: enabled.checked };
        for (const c of controls) captured[c.key] = { target: c.target.value, model: c.model.value, effort: c.effort.value || 'default' };
        saving = true; cancel.disabled = true; enabled.disabled = true;
        for (const c of controls) { c.target.disabled = true; c.model.disabled = true; c.effort.disabled = true; }
        for (const button of grid.querySelectorAll('button')) button.disabled = true;
        update(); error.textContent = '';
        try { await save(captured); close(); if (anchor && anchor.isConnected) render(anchor); }
        catch (err) {
          if (closed) return;
          error.textContent = `儲存失敗：${err && err.message || err}`;
          if (onError) onError(err);
          saving = false; cancel.disabled = false; enabled.disabled = false;
          for (const c of controls) { c.target.disabled = false; c.model.disabled = false; c.renderEfforts(); }
          for (const button of grid.querySelectorAll('button')) button.disabled = false;
          update();
        }
      });
      doc.body.appendChild(dialog);
      dialog.showModal();
      update();
    }
    return { open, render };
  }
  return { create, configOf, modelOptions, effortOptions, EFFORTS, targets };
});
