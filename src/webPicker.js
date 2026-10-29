'use strict';
// Runs in ChatGPT's DOM. Never use the API/Codex model catalogue as a web fallback.
async function picker(action, value) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && !!el.getClientRects().length && !el.closest('[inert],[aria-hidden="true"]');
  let button;
  for (let i = 0; i < 30; i++) {
    button = [...document.querySelectorAll('[data-codex-intelligence-trigger],[data-testid="model-switcher-dropdown-button"],button[aria-label*="選取 ChatGPT 模型"],button[aria-label*="ChatGPT model"]')].find(visible);
    if (button) break;
    await wait(500);
  }
  if (!button) throw new Error('找不到 ChatGPT 網頁模型／推理選單');
  // Confirm from the live page, never a process-wide cache: other tabs or the
  // user may have changed this setting since the previous turn.
  if (action === 'effort' && button.getAttribute('data-selected-reasoning-effort') === value) return { selected: value };
  if (button.getAttribute('aria-expanded') !== 'true') { button.click(); await wait(350); }
  const menu = [...document.querySelectorAll('[role="menu"]')].find(m => visible(m) && (m.getAttribute('aria-labelledby') === button.id))
    || [...document.querySelectorAll('[role="menu"]')].find(visible);
  if (!menu) throw new Error('ChatGPT 選單沒有開啟');
  const close = () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const modelRows = async () => {
    let rows = [...menu.querySelectorAll('[role="menuitemradio"]')].filter(visible);
    if (!rows.length) {
      const toggle = [...menu.querySelectorAll('[data-model-picker-view-toggle]')].find(visible);
      if (toggle) { toggle.click(); await wait(450); rows = [...menu.querySelectorAll('[role="menuitemradio"]')].filter(visible); }
    }
    return rows.filter(x => x.getAttribute('aria-disabled') !== 'true' && !x.hasAttribute('disabled'));
  };
  const title = el => (el.innerText || el.textContent || '').trim().split('\n')[0].trim();
  try {
    if (action === 'models' || action === 'model') {
      const rows = await modelRows();
      if (action === 'model') {
        const row = rows.find(x => title(x) === value);
        if (!row) throw new Error(`ChatGPT 網頁沒有「${value}」模型，請重新讀取選單`);
        if (row.getAttribute('aria-checked') === 'true') return true;
        row.click(); await wait(350); return true;
      }
      const models = rows.map(x => ({ slug: title(x), title: title(x), description: (x.innerText || '').trim().split('\n').slice(1).join(' '), selected: x.getAttribute('aria-checked') === 'true' })).filter(x => x.slug);
      return { models, defaultModel: models.find(x => x.selected)?.slug || '' };
    }
    let keyboard = [...menu.querySelectorAll('[data-reasoning-slider]')].find(visible);
    if (!keyboard) {
      const toggle = [...menu.querySelectorAll('[data-model-picker-view-toggle]')].find(visible);
      if (toggle) { toggle.click(); await wait(450); keyboard = [...menu.querySelectorAll('[data-reasoning-slider]')].find(visible); }
    }
    if (!keyboard) {
      // Older web picker: a dedicated thinking-time button with radio items.
      throw new Error('這個網頁模型沒有可讀取的推理強度滑桿；請沿用網頁預設');
    }
    const slider = keyboard.querySelector('[role="slider"]');
    if (!slider) throw new Error('找不到網頁推理滑桿');
    const min = Number(slider.getAttribute('aria-valuemin')); const max = Number(slider.getAttribute('aria-valuemax'));
    const initial = Number(slider.getAttribute('aria-valuenow'));
    if (!Number.isInteger(min) || !Number.isInteger(max) || max - min > 12) throw new Error('無法辨識網頁推理滑桿範圍');
    const step = async key => { keyboard.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); await wait(180); };
    const at = async n => {
      for (let i = 0; i <= max - min; i++) {
        const current = Number(slider.getAttribute('aria-valuenow'));
        if (current === n) return;
        await step(current < n ? 'ArrowRight' : 'ArrowLeft');
      }
      throw new Error('網頁推理滑桿沒有套用變更');
    };
    const selected = () => button.getAttribute('data-selected-reasoning-effort') || '';
    const currentEffort = selected(); const efforts = [];
    let applied = false;
    try {
      for (let n = min; n <= max; n++) {
        await at(n);
        const id = selected();
        const label = title(menu.querySelector('[data-model-picker-view-toggle]')) || title(button);
        if (!id) throw new Error('網頁沒有提供推理強度識別值');
        efforts.push({ id, title: label, index: n });
      }
      if (action === 'effort') {
        const found = efforts.find(x => x.id === value);
        if (!found) throw new Error(`這個網頁模型不支援推理強度「${value}」，請重新讀取選單`);
        await at(found.index);
        if (selected() !== value) throw new Error('網頁推理強度沒有套用成功');
        applied = true; return { selected: value };
      }
      return { efforts: efforts.map(({ id, title }) => ({ id, title })), currentEffort };
    } finally { if (!applied) await at(initial); }
  } finally { close(); }
}
const script = (action, value) => `(${picker.toString()})(${JSON.stringify(action)},${JSON.stringify(value)})`;
module.exports = { script };
