'use strict';
// Shared selectors for both ChatGPT page generations. Keep the actual composer
// separate from inline editors, and identify virtualized turns by message ID.
function nodes() {
  const q = s => document.querySelector(s);
  const all = s => [...document.querySelectorAll(s)];
  const composer = q('form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]')
    || q('form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')
    || q('[data-testid="composer"] [contenteditable="true"]')
    || q('#prompt-textarea') || q('form [contenteditable="true"][role="textbox"]')
    || q('form [contenteditable="true"]') || q('div[contenteditable="true"][role="textbox"]');
  const scope = composer?.closest('form, [data-testid="composer"]') || document;
  const turns = all('[data-content-search-turn-key]');
  const old = all('[data-message-author-role="assistant"]');
  const units = all('[data-content-search-unit-key$=":assistant"]');
  const oldUsers = all('[data-message-author-role="user"]');
  const userUnits = all('[data-content-search-unit-key$=":user"]');
  // Modern user messages also contain MarkdownRoot. They must never become
  // assistant turns while a freshly submitted answer is still pending. Mix
  // generations per turn: an older unit elsewhere must not hide a new turn.
  const userMarker = '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [class*="group/user-message"]';
  const assistantMarker = '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]';
  const marked = (node, selector) => node.matches(selector) || !!node.querySelector(selector);
  const userTurn = node => marked(node, userMarker);
  const assistantTurn = node => marked(node, assistantMarker)
    || (!userTurn(node) && !!node.querySelector('[class*="MarkdownRoot"]'));
  const combine = (preferred, legacy, fallback) => {
    const result = [];
    for (const node of [...preferred, ...legacy, ...fallback]) {
      // A unit and its nested author-role element represent one message.
      if (!result.some(other => other === node || other.contains(node) || node.contains(other))) result.push(node);
    }
    return result.sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 2 ? 1 : -1);
  };
  const assistants = combine(units, old, turns.filter(assistantTurn));
  const users = combine(userUnits, oldUsers, turns.filter(userTurn));
  const identity = node => {
    if (!node) return '';
    const selected = node.querySelector('[data-chatgpt-selection-message-id], [data-message-id]')
      || node.closest('[data-chatgpt-selection-message-id], [data-message-id]');
    return selected?.getAttribute?.('data-chatgpt-selection-message-id') || selected?.getAttribute?.('data-message-id')
      || node.getAttribute('data-message-id') || node.getAttribute('data-content-search-unit-key') || '';
  };
  return { composer, scope, assistants, users, identity };
}
const script = `(${nodes.toString()})()`;
module.exports = { script };
