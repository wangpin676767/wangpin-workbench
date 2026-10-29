'use strict';
(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else globalThis.WebModelChoice = factory();
})(function () {
  // IDs previously accepted by the HTTP/API path, not guessed display names.
  const legacyIds = ['auto','gpt-6','gpt-6-thinking','gpt-6-pro','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'];
  function legacy(value) { return legacyIds.includes(String(value || '').trim()); }
  function choice(value, models) {
    const model = String(value || '').trim();
    if (models?.some(row => (row.slug || row.id || row.title) === model)) return {model, changed:false};
    if (!legacy(model)) return {model, changed:false};
    return {model:'',changed:true,reason:`舊 HTTP／API 模型「${model}」不適用瀏覽器選單，已改為沿用網站目前模型；可按「讀取模型」重新選擇。`};
  }
  function config(input = {}) {
    const cfg = {...input, models:{...(input.models || {})}};
    const source = choice(cfg.models.gpt);
    if(source.changed)cfg.models.gpt='';
    const synthesis = cfg.target === 'web:gpt' ? choice(cfg.model) : {changed:false};
    if(synthesis.changed)cfg.model='';
    const reasons=[source.reason,synthesis.reason].filter(Boolean);
    if(reasons.length)cfg.modelNotice=reasons.join('\n');
    return {config:cfg,changed:reasons.length>0};
  }
  return {legacyIds,legacy,choice,config};
});
