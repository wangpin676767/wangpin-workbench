'use strict';
// Browser-free source transport. The caller pins credentials and owns tool gates.
const providers = require('./providers');
function create({site, cfg, model, signal, streamChat = providers.streamChat}) {
  if (!['gpt','claude','gemini'].includes(site)) throw Error('不支援的 HTTP 來源');
  const pinned = structuredClone(cfg || {});
  if (!pinned.apiKey) throw Error(`${site} HTTP 模式需要 API Key；請在 API 設定新增，不會沿用網站訂閱。`);
  const picked = String(model || pinned.model || providers.PROVIDERS[site].defaultModel);
  const history = [];
  return async (text, callbacks = {}) => {
    if (signal?.aborted) throw Object.assign(Error('已停止'), {name:'AbortError'});
    history.push({role:'user',content:String(text)});
    let body = '';
    try {
      const result = await streamChat({provider:site,cfg:pinned,model:picked,
        system:'Answer the supplied request. Available host tools, if any, are described in the request. This is an HTTP API connection; do not claim to have used website features or searched unless tool results establish it.',
        history:structuredClone(history),options:{},signal,
        onDelta:delta=>{if(!signal?.aborted){body+=delta;callbacks.onDelta?.(delta);}},onReasoning(){},onStatus:callbacks.onStatus});
      if (signal?.aborted) return {text:body,cancelled:true,model:picked};
      if (result?.incomplete) throw Error('HTTP 回應未完成；已保留收到的內容。');
      if (!body.trim()) throw Error('HTTP 來源沒有回傳文字。');
      history.push({role:'assistant',content:body});
      return {text:body,model:result?.servedModel || picked};
    } catch (error) { error.partial=body;throw error; }
  };
}
module.exports = {create};
