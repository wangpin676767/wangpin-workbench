'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else globalThis.WangpinInputComposition = factory();
})(function inputComposition() {
  // Some Chromium/Windows IME key events report keyCode 229, or lose the
  // isComposing flag while the editor is still composing. Keep that state on
  // the actual editor, rather than suppressing unrelated controls globally.
  function createCompositionGuard(document) {
    const composing = new WeakSet();
    const hasTarget = target => target && (typeof target === 'object' || typeof target === 'function');
    const start = event => { if (hasTarget(event.target)) composing.add(event.target); };
    const end = event => { if (hasTarget(event.target)) composing.delete(event.target); };
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    // A removed/blurred editor must not leave a stale composition guard when
    // focus returns. No timers or extra delay are applied to ordinary keys.
    document.addEventListener('focusout', end, true);
    return {
      isComposing(event) {
        return !!(event && (event.isComposing || event.keyCode === 229 || event.which === 229 ||
          (hasTarget(event.target) && composing.has(event.target))));
      },
      dispose() {
        document.removeEventListener('compositionstart', start, true);
        document.removeEventListener('compositionend', end, true);
        document.removeEventListener('focusout', end, true);
      }
    };
  }
  return { createCompositionGuard };
});
