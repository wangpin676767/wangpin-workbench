'use strict';
const primeAgent = require('./primeAgent');
const PROVIDERS = new Set(['anthropic', 'google', 'deepseek', 'openai']);
function normalize(list) {
  if (!Array.isArray(list)) throw new Error('替補模型必須是清單');
  if (list.length > 8) throw new Error('最多設定 8 個替補模型');
  const seen = new Set();
  return list.map(entry => {
    const provider = String(entry?.provider || '').trim();
    const model = String(entry?.model || '').trim();
    if (!PROVIDERS.has(provider) || !model || model.length > 200) throw new Error('每個替補項目都需要供應商與模型 ID');
    return { provider, model };
  }).filter(entry => {
    const id = JSON.stringify(entry);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}
function eligible(error) {
  return error?.primeProviderFailure === true && /credit balance|insufficient[_ ](?:quota|credits|balance)|billing|quota exceeded|exceeded.*quota|rate.?limit|too many requests|\b429\b|overloaded|\b50[23]\b|model.*(?:not found|not available|does not exist|not supported)|餘額不足|額度不足/i.test(error.message);
}
const PROVIDER_LABEL = {anthropic:'Claude（Anthropic 金鑰）', google:'Gemini 金鑰', deepseek:'DeepSeek 金鑰', openai:'OpenAI 金鑰', xai:'Grok（xAI 金鑰）'};

/**
 * 換模型之前先比對 Prime Agent 真正載入的模型清單。
 * 沒對上就不要送 set_model：那只會換來一句 Model not found，白白多跑一輪。
 * 回傳 null 表示可以照原樣切換（清單問不到時不擋）。
 */
function checkCandidate(models, candidate) {
  if (!Array.isArray(models) || !models.length) return null;
  if (primeAgent.matchModel(models, candidate.model, candidate.provider)) return null;
  const sameProvider = primeAgent.modelsOf(models, candidate.provider);
  if (!sameProvider.length) {
    return `Prime Agent 沒有載入任何 ${PROVIDER_LABEL[candidate.provider] || candidate.provider} 的模型；通常是工作台還沒設定這家的 API 金鑰。`;
  }
  return `Prime Agent 沒有「${candidate.model}」這個模型。這家目前可用的是：${sameProvider.slice(0, 8).map(m => m.id).join('、')}${sameProvider.length > 8 ? ' 等' : ''}。`;
}

async function ask({session, message, options, config, current, setCurrent, notice}) {
  const candidates = config.fallbackEnabled ? normalize(config.fallbackModels || []) : [];
  const attempted = new Set([JSON.stringify(current())]);
  const deadline = Date.now() + (options.timeoutMs || 1200000);
  const failures = [];
  let switched = false;
  for (;;) {
    if (options.signal?.aborted) throw new Error('已取消');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Prime Agent 與替補模型已達本次總時間上限');
    try {
      const result = await session.ask(switched ? `接續上一個模型因服務錯誤中斷的任務。沿用本工作階段已有的對話、工具結果及檔案；先確認進度，避免重做已完成的操作。原始本次指示：\n${message}` : message, {...options, timeoutMs:remaining});
      if (switched) result.text += `\n\n［Prime Agent 已自動替補：${current().provider} / ${current().model}］`;
      return result;
    } catch (error) {
      if (options.signal?.aborted || !eligible(error) || !config.fallbackEnabled) throw error;
      failures.push(`${current().provider} / ${current().model || '預設模型'}：${error.message}`);
      let next;
      const models = candidates.length ? await session.availableModels?.({timeoutMs:Math.min(20000, Math.max(1000, deadline-Date.now()))}).catch(() => []) || [] : [];
      while (candidates.length) {
        const candidate = candidates.shift();
        const id = JSON.stringify(candidate);
        if (attempted.has(id)) continue;
        attempted.add(id);
        if (options.signal?.aborted) throw new Error('已取消');
        if (Date.now() >= deadline) throw new Error('Prime Agent 替補已達本次總時間上限');
        const unusable = checkCandidate(models, candidate);
        if (unusable) {
          failures.push(`${candidate.provider} / ${candidate.model}：${unusable}`);
          notice(`Prime Agent 跳過替補 ${candidate.provider} / ${candidate.model}：${unusable}`);
          continue;
        }
        try {
          await session.command('set_model', {provider:candidate.provider, modelId:candidate.model}, {timeoutMs:Math.min(60000, deadline-Date.now())});
          if (options.signal?.aborted) throw new Error('已取消');
          setCurrent(candidate); next = candidate; break;
        } catch (switchError) {
          if (options.signal?.aborted) throw new Error('已取消');
          failures.push(`${candidate.provider} / ${candidate.model}：${switchError.message}`);
          notice(`Prime Agent 跳過替補 ${candidate.provider} / ${candidate.model}：${switchError.message}`);
        }
      }
      if (!next) throw new Error(`Prime Agent 沒有可用的替補模型。\n${failures.join('\n')}`);
      switched = true;
      notice(`Prime Agent 自動替補為 ${next.provider} / ${next.model}。原因：${error.message}`);
    }
  }
}
module.exports = { normalize, eligible, ask, checkCandidate };
