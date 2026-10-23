'use strict';
function findQuotaGroup(groups, family) {
  if (!Array.isArray(groups) || !family) return null;
  const fam = String(family).trim();
  const exact = groups.find(g => g.name && g.name.toLowerCase() === fam.toLowerCase());
  if (exact) return exact;
  if (/argon/i.test(fam)) {
    const argon = groups.find(g => /argon/i.test(g.name));
    if (argon) return argon;
  }
  if (/gemini/i.test(fam)) {
    const gem = groups.find(g => /gemini/i.test(g.name) && !/argon/i.test(g.name));
    if (gem) return gem;
  }
  if (/claude|gpt/i.test(fam)) {
    const cg = groups.find(g => /claude|gpt/i.test(g.name));
    if (cg) return cg;
  }
  try {
    return groups.find(g => new RegExp(fam, 'i').test(g.name) || new RegExp(g.name, 'i').test(fam)) || null;
  } catch {
    return null;
  }
}

function buckets(groups, family) {
  const group = findQuotaGroup(groups, family);
  return (group?.buckets || []).map(b => ({
    id: b.id || b.window,
    label: b.window === 'weekly' ? '每週' : b.window === '5h' ? '5 小時' : b.name || b.window || '額度',
    disabled: b.disabled === true,
    remaining: typeof b.remaining_fraction === 'number' && Number.isFinite(b.remaining_fraction) && b.remaining_fraction >= 0 && b.remaining_fraction <= 1 ? b.remaining_fraction : null,
    resetTime: typeof b.reset_time === 'string' && !Number.isNaN(Date.parse(b.reset_time)) ? b.reset_time : '',
    description: b.description || ''
  }));
}

// Keep source buckets intact. Missing standard windows are presentation-only:
// absence is unknown, never an invented percentage or another model's quota.
function windows(groups, family) {
  const source=buckets(groups,family);
  if(!source.length)return [];
  const result=source.map(bucket=>({...bucket}));
  for(const [id,label] of [['weekly','每週'],['5h','5 小時']]){
    const raw=findQuotaGroup(groups,family)?.buckets || [];
    if(!raw.some(bucket=>bucket.window===id))result.push({id,label,remaining:null,disabled:false,unavailable:true,resetTime:'',description:'CLI 未提供目前模型的這個額度區間；不代表已用完或不適用。'});
  }
  return result;
}
module.exports = { buckets, windows, findQuotaGroup };
