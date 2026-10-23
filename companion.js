'use strict';
// 長期陪伴角色引擎（能力擴充「長期陪伴角色」）。
//
// 勾選這個擴充的對話，使用者的每則訊息都直接由角色回覆（main.js 的 companion 分支），
// 所有模型呼叫都走傳進來的 conversation runner，也就是目前對話的模型與登入方式。
//
// 下列四個研究／框架都是「概念適配，非官方套件」：沒有安裝它們的 Python 伺服器、Neo4j 或 Postgres，
// 而是用 JavaScript 在本機把核心機制做成小型版本，資料是 userData/companion/<角色id>/ 底下的 JSON。
//
//  ・PsyAgent（Meng & Chen, arXiv:2601.06158）：Individual Structure（Big Five 特質與面向、認知風格、
//    價值觀、重要人生片段）＋ Multi-Scenario Contexting（依情境套用角色—關係—規範框架）。
//    這裡：companionPersona.js 的人物結構與 SCENARIOS；特質會隨經歷小幅漂移（每回合 ±0.01、總量 ±0.12），
//    對應論文強調的「長期穩定但可辨識」。
//  ・Thinking in Character／RAR（Role-Aware Reasoning, arXiv:2506.01748）：先以角色身分做內在推理再回答。
//    論文的 Role Identity Activation 是在推理過程中持續用角色設定約束「我是誰」，Reasoning Style Optimization
//    讓推理本身的語氣也貼合角色與情境。論文是訓練方法；這裡只能用提示詞做推論期的適配：
//    每回合要求模型先在 <mind> 寫出「她此刻的心聲」：以她的第一人稱、她的情緒與對使用者的真實印象想怎麼回
//    （這段屬於角色本身、只存在本機紀錄，不會顯示給使用者），開頭先確認身分與當下狀態（RIA），
//    並要求心聲的語氣就是她的語氣而不是助理分析（RSO）。
//    注意：寫成「把你的推理／思考過程輸出在標籤裡、不給使用者看」會被 Claude 的防護判成 reasoning_extraction
//    直接拒答（實測 Opus 5）。所以這裡明確把它定位成角色的內心獨白（故事的一部分），不是模型自己的推理。
//  ・Letta／MemGPT（Packer et al., arXiv:2310.08560；docs.letta.com）：core memory blocks 永遠在上下文、
//    有字數上限；archival memory 放長期記憶、需要時檢索；由代理自己用 core_memory_append／replace、
//    archival_memory_insert 決定寫什麼。這裡：memory.core（persona／human／relationship 三個區塊，
//    超過上限時最舊的行被擠到長期記憶）＋ memory.archival（本機檢索），寫入由角色在 <update> 自己決定。
//  ・Graphiti／Zep（Rasmussen et al., arXiv:2501.13956；help.getzep.com/graphiti）：雙時間（bi-temporal）
//    知識圖：每條事實（edge）有 valid_at／invalid_at（事實在世界中成立的時間）與 created_at／expired_at
//    （系統何時知道／何時作廢）；新事實與舊事實矛盾時不刪除舊事實，而是把它標成失效；原始互動存成 episode。
//    這裡：timeline.facts 以 key 判斷「同一件事」，新值取代舊值時舊值標 invalid_at／expired_at／superseded_by，
//    timeline.episodes 保存每回合原始對話。
//  ・重要度＋時間衰減與檢索分數參考 Generative Agents（Park et al., 2023）的 recency＋importance＋relevance。
//
// 每回合模型呼叫次數：1 次（角色內推理＋回覆＋記憶整理合併在同一次）；
// 輸出檢查發現模板句、條列或內部推理外洩時再重寫 1 次，所以上限是 2 次。記憶檢索與衰減都不呼叫模型。

const fs = require('fs');
const path = require('path');
const persona = require('./companionPersona');
const companionHtml = require('./companionHtml');
const companionText = require('./companionText');
const crypto = require('crypto');
// 人物設定與 Prompt 存成這個純文字檔（App 每回合都會讀它；用記事本直接改檔案也會生效）
const PERSONA_FILE = 'persona.txt';
// 1.9.15～1.9.16 存成 HTML 表格；升級後改名保留成 persona.old.html，不刪除
const LEGACY_HTML_FILE = 'persona.html';
const LEGACY_HTML_MOVED = 'persona.old.html';

const MAX_CALLS = 2;
const CORE_LIMIT = { persona: 900, human: 1200, relationship: 900 };
const MAX_ARCHIVAL = 1500;
const MAX_EPISODES = 400;
const HOUR = 3600000, DAY = 24 * HOUR;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const iso = (t) => new Date(t).toISOString();
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- 檔案
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支援就不等 */ } }

/** 原子寫入：先寫同資料夾的暫存檔再改名，寫到一半當機也不會留下半個 JSON。字串照原樣寫入。 */
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1), 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows 上防毒或索引服務短暫鎖檔時會 EPERM／EBUSY，稍等再試
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
      sleepSync(25 * (i + 1));
    }
  }
}

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback(); }
  try { return JSON.parse(raw); } catch {
    // 壞檔不要默默覆蓋掉：改名保留，再用預設值重新開始
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* */ }
    return fallback();
  }
}

const safeId = (id) => String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'default';
const dirFor = (root, characterId) => path.join(root, safeId(characterId));

function freshState(name, now) {
  const t = iso(now);
  return {
    profile: persona.defaultProfile(name),
    memory: {
      core: persona.defaultCore(name),
      archival: persona.seedMemories().map((m) => ({ id: newId('mem'), createdAt: t, lastAccessAt: t, accessCount: 0, status: 'active', ...m })),
    },
    timeline: { facts: [], episodes: [], offscreen: [] },
    relation: {
      familiarity: 15, trust: 20, closeness: 10, irritation: 0,
      mood: { valence: 0.1, energy: 0.6, label: '普通' },
      grudges: [], log: [], turns: 0,
      createdAt: t, lastInteractionAt: null, decayedAt: t, lastClosenessGainAt: null, lastImpression: '',
    },
  };
}

function load(dir, { name, now = Date.now() } = {}) {
  const base = freshState(name || persona.DEFAULT_NAME, now);
  const st = {
    profile: readJson(path.join(dir, 'profile.json'), () => base.profile),
    memory: readJson(path.join(dir, 'memory.json'), () => base.memory),
    timeline: readJson(path.join(dir, 'timeline.json'), () => base.timeline),
    relation: readJson(path.join(dir, 'relation.json'), () => base.relation),
  };
  st.memory.core = { ...base.memory.core, ...(st.memory.core || {}) };
  st.memory.archival = Array.isArray(st.memory.archival) ? st.memory.archival : [];
  for (const k of ['facts', 'episodes', 'offscreen']) if (!Array.isArray(st.timeline[k])) st.timeline[k] = [];
  st.relation = { ...base.relation, ...st.relation, mood: { ...base.relation.mood, ...(st.relation.mood || {}) } };
  if (!Array.isArray(st.relation.grudges)) st.relation.grudges = [];
  if (!Array.isArray(st.relation.log)) st.relation.log = [];
  // persona.txt 被改過（在 App 外用記事本改）就先套用
  syncFromFile(dir, st);
  // 名字可以在擴充設定裡改：人格與記憶不變，只換稱呼。
  // 只在「設定裡的名字本身變了」時才套用，不然用角色檔或編輯器改的名字會被舊設定蓋回去。
  if (name && name !== st.profile.nameFromSettings) {
    if (st.profile.name !== name) renameCharacter(st, name);
    st.profile.nameFromSettings = name;
  }
  return st;
}

// ---------------------------------------------------------------- persona.txt
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const personaFileOf = (dir) => path.join(dir, PERSONA_FILE);

/** 目前的人物設定與 Prompt，用編輯器送出的格式（也就是角色檔的內容） */
function editablePatch(st) {
  const ed = editable(st);
  return {
    name: ed.name, age: ed.age,
    ...Object.fromEntries([...LIST_KEYS, ...TEXT_KEYS, 'lifeEpisodes'].map((k) => [k, ed[k]])),
    traits: ed.traits, prompt: ed.prompt,
    scenarios: Object.fromEntries(ed.scenarios.map((x) => [x.id, x.guide])),
  };
}
const sigOf = (st) => sha1(JSON.stringify([editablePatch(st), memoryTexts(st)]));

// ---------------------------------------------------------------- 她記得的事 ⇄ 文字（和人物設定寫在同一份 persona.txt）
const KIND_LABEL = { promise: '承諾', conflict: '爭執', joke: '玩笑', event: '事件', preference: '偏好', fact: '事實', feeling: '感受', offscreen: '她的生活', core_overflow: '舊筆記' };
const LABEL_KIND = Object.fromEntries(Object.entries(KIND_LABEL).map(([k, v]) => [v, k]));
const REL_FIELDS = [['familiarity', '熟悉'], ['trust', '信任'], ['closeness', '親近'], ['irritation', '火氣']];
const oneLine = (s) => String(s || '').replace(/\s*\r?\n\s*/g, ' ').trim();
const normLine = (s) => oneLine(s).replace(/^[-・•*]\s*/, '').replace(/\s+/g, ' ');
const memLine = (m) => `[${KIND_LABEL[m.kind] || '事件'} ${m.importance}] ${oneLine(m.text)}`;

/** 她記得的事，一欄一段文字（格式見 companionText.MEMORY_FIELDS）。只看狀態、不看時間，同樣的狀態一定寫出同樣的文字。 */
function memoryTexts(st) {
  const rel = st.relation;
  return {
    self: String(st.memory.core.persona || ''),
    human: String(st.memory.core.human || ''),
    relationship: String(st.memory.core.relationship || ''),
    archival: st.memory.archival.filter((m) => m.status === 'active').map(memLine).join('\n'),
    facts: st.timeline.facts.filter((f) => !f.invalid_at).map((f) => `${f.key}：${oneLine(f.text)}`).join('\n'),
    grudges: rel.grudges.filter((g) => g.status === 'open').map((g) => `[${g.severity}] ${oneLine(g.text)}`).join('\n'),
    relation: [...REL_FIELDS.map(([k, label]) => `${label}：${Math.round(num(rel[k]) * 10) / 10}`), `心情：${(rel.mood && rel.mood.label) || ''}`].join('\n'),
    impression: String(rel.lastImpression || ''),
  };
}

const lineSet = (text) => String(text || '').split(/\r?\n/).map(normLine).filter(Boolean);
function parseMemLine(line) {
  const m = /^[[［]\s*([^\]］\d\s]*)\s*(\d{1,2})?\s*[\]］]\s*(.+)$/.exec(line);
  if (!m) return { kind: 'event', importance: 5, text: line.slice(0, 300) };
  const label = m[1].trim();
  return { kind: LABEL_KIND[label] || (KINDS.has(label) ? label : 'event'), importance: clamp(Math.round(num(m[2], 5)), 1, 10), text: m[3].trim().slice(0, 300) };
}
function parseFactLine(line) {
  const m = /^([^：:]{1,60})[：:]\s*(.+)$/.exec(line);
  if (m) return { key: normKey(m[1]), text: m[2].trim() };
  return { key: `note.${sha1(line).slice(0, 8)}`, text: line };
}
function parseGrudgeLine(line) {
  const m = /^[[［]\s*(\d+(?:\.\d+)?)\s*[\]］]\s*(.+)$/.exec(line);
  if (!m) return { severity: 0.4, text: line.slice(0, 160) };
  let s = Number(m[1]);
  if (s > 10) s /= 100; else if (s > 1) s /= 10;
  return { severity: Math.round(clamp(s, 0.05, 1) * 100) / 100, text: m[2].trim().slice(0, 160) };
}
const sameText = (a, b) => normLine(a) === normLine(b);
const memLabel = (k) => companionText.MEMORY_FIELDS.find((f) => f[0] === k)[1];

/**
 * 把角色檔裡「她記得的事」套回去。base 是這份檔案當初寫出去時的內容（同一個檔案版本）：
 * 只套用和 base 不同的地方，所以她在你改檔案期間新記住的事不會被洗掉。沒有 base（外來的檔案）就以目前的狀態為準。
 * 回傳 { changed: [說明], warnings: [] }。
 */
function applyMemoryText(st, mem, base, now = Date.now()) {
  const b = base || memoryTexts(st);
  const changed = []; const warnings = [];
  const diff = (key) => {
    const was = lineSet(b[key]); const is = lineSet(mem[key]);
    const wasSet = new Set(was); const isSet = new Set(is);
    return { removed: was.filter((l) => !isSet.has(l)), added: is.filter((l) => !wasSet.has(l)) };
  };
  const coreKey = { self: 'persona', human: 'human', relationship: 'relationship' };
  for (const [k, block] of Object.entries(coreKey)) {
    if (mem[k] === undefined || String(mem[k]).trim() === String(b[k] || '').trim()) continue;
    st.memory.core[block] = String(mem[k]).trim().slice(0, 4000);
    changed.push(memLabel(k));
    if (st.memory.core[block].length > CORE_LIMIT[block]) warnings.push(`「${memLabel(k)}」超過 ${CORE_LIMIT[block]} 字：之後她寫新筆記時，最舊的幾行會被移到長期記憶`);
  }
  if (mem.archival !== undefined) {
    const { removed, added } = diff('archival');
    let forgot = 0, add = 0, edit = 0;
    const active = () => st.memory.archival.filter((m) => m.status === 'active');
    const addedItems = added.map(parseMemLine);
    for (const l of removed) {
      const p = parseMemLine(l);
      // 只改了類型或重要度：同一件事，不要忘掉再重記
      if (addedItems.some((a) => sameText(a.text, p.text))) continue;
      const hit = active().find((m) => normLine(memLine(m)) === l) || active().find((m) => sameText(m.text, p.text));
      if (hit) { hit.status = 'forgotten'; hit.forgottenAt = iso(now); hit.forgottenBy = 'user'; forgot++; }
    }
    for (const p of addedItems) {
      if (!p.text) continue;
      const hit = active().find((m) => sameText(m.text, p.text));
      if (hit) { if (hit.kind !== p.kind || hit.importance !== p.importance) { hit.kind = p.kind; hit.importance = p.importance; hit.updatedAt = iso(now); edit++; } continue; }
      st.memory.archival.push({ id: newId('mem'), text: p.text, kind: p.kind, importance: p.importance, createdAt: iso(now), lastAccessAt: iso(now), accessCount: 0, status: 'active', source: 'user' });
      add++;
    }
    if (forgot || add || edit) changed.push(`長期記憶（新增 ${add}、忘掉 ${forgot}、修改 ${edit}）`);
  }
  if (mem.facts !== undefined) {
    const { removed, added } = diff('facts');
    const addedFacts = added.map(parseFactLine);
    let n = 0;
    for (const l of removed) {
      const f = parseFactLine(l);
      if (addedFacts.some((a) => a.key === f.key)) continue; // 改內容：由下面新的一筆取代舊值
      if (invalidateFact(st.timeline, f.key, now, '使用者在角色檔刪掉')) n++;
    }
    for (const f of addedFacts) {
      const old = st.timeline.facts.find((x) => x.key === f.key && !x.invalid_at);
      if (old && sameText(old.text, f.text)) continue;
      const fact = { id: newId('fact'), key: f.key, text: f.text.slice(0, 200), valid_at: iso(now), invalid_at: null, created_at: iso(now), expired_at: null, episode: null, source: 'user' };
      if (old) { old.invalid_at = iso(now); old.expired_at = iso(now); old.superseded_by = fact.id; }
      st.timeline.facts.push(fact);
      n++;
    }
    if (n) changed.push(`目前成立的事（${n} 項）`);
  }
  if (mem.grudges !== undefined) {
    const { removed, added } = diff('grudges');
    const addedG = added.map(parseGrudgeLine);
    let n = 0;
    for (const l of removed) {
      const g = parseGrudgeLine(l);
      if (addedG.some((a) => sameText(a.text, g.text))) continue;
      const hit = st.relation.grudges.find((x) => x.status === 'open' && sameText(x.text, g.text));
      if (hit) { hit.status = 'resolved'; hit.resolvedAt = iso(now); hit.resolvedBy = 'user'; n++; }
    }
    for (const g of addedG) {
      const hit = st.relation.grudges.find((x) => x.status === 'open' && sameText(x.text, g.text));
      if (hit) { if (hit.severity !== g.severity) { hit.severity = g.severity; n++; } continue; }
      st.relation.grudges.push({ id: newId('g'), text: g.text, severity: g.severity, status: 'open', createdAt: iso(now), source: 'user' });
      n++;
    }
    if (n) changed.push(`還在意的事（${n} 項）`);
  }
  if (mem.relation !== undefined) {
    const read = (text) => {
      const o = {};
      for (const l of lineSet(text)) { const m = /^([^：:]+)[：:]\s*(.*)$/.exec(l); if (m) o[m[1].trim()] = m[2].trim(); }
      return o;
    };
    const was = read(b.relation); const is = read(mem.relation);
    const moved = [];
    for (const [k, label] of REL_FIELDS) {
      if (is[label] === undefined || is[label] === was[label]) continue;
      const v = Number(String(is[label]).replace(/[^\d.-]/g, ''));
      if (!is[label] || !Number.isFinite(v)) { warnings.push(`「關係數值」的${label}不是數字：${String(is[label]).slice(0, 20)}`); continue; }
      st.relation[k] = Math.round(clamp(v, 0, 100) * 10) / 10;
      moved.push(label);
    }
    if (is['心情'] && is['心情'] !== was['心情']) { st.relation.mood.label = is['心情'].slice(0, 12); moved.push('心情'); }
    if (moved.length) {
      changed.push(`關係數值（${moved.join('、')}）`);
      st.relation.log.push({ at: iso(now), familiarity: 0, trust: 0, closeness: 0, irritation: 0, reason: `使用者在角色檔改了${moved.join('、')}`, episode: null });
    }
  }
  if (mem.impression !== undefined && String(mem.impression).trim() !== String(b.impression || '').trim()) {
    st.relation.lastImpression = oneLine(mem.impression).slice(0, 160);
    changed.push('她對你的印象');
  }
  return { changed, warnings };
}

// 每次寫出 persona.txt 都記下當時「她記得的事」（依檔案版本），讀回來時才知道使用者改了哪幾行
const BASE_FILE = 'persona.base.json';
const MAX_REVS = 12;
function readBases(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, BASE_FILE), 'utf8')); if (j && j.revs && typeof j.revs === 'object') return { revs: j.revs, order: Array.isArray(j.order) ? j.order : [] }; } catch { /* 沒有或壞掉 */ }
  return { revs: {}, order: [] };
}
function saveBase(dir, rev, texts) {
  const j = readBases(dir);
  j.revs[rev] = texts;
  j.order = [...j.order.filter((r) => r !== rev), rev];
  while (j.order.length > MAX_REVS) delete j.revs[j.order.shift()];
  atomicWrite(path.join(dir, BASE_FILE), JSON.stringify(j));
}
const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// 存成 UTF-8（開頭帶 BOM，舊版記事本和 Excel 才不會認成 Big5）
function storedText(st, rev = '') {
  return '\uFEFF' + companionText.toText(editablePatch(st), { scenarioLabels: persona.SCENARIO_LABELS, stored: true, memory: memoryTexts(st), rev });
}

/** 套用解析好的角色檔。dir 有給、檔案帶版本號時，「她記得的事」只套用使用者改動的行。 */
function applyParsed(st, parsed, { dir = null, now = Date.now() } = {}) {
  const info = { at: new Date(now).toISOString(), found: parsed.found.length, unknown: parsed.unknown, warnings: [...parsed.warnings], applied: parsed.found.length > 0, memory: [] };
  if (!info.applied) return info;
  const { memory, ...personaPatch } = parsed.patch;
  applyPatch(st, personaPatch);
  if (memory) {
    const base = dir && parsed.rev ? readBases(dir).revs[parsed.rev] || null : null;
    if (parsed.rev && dir && !base) info.warnings.push('找不到這份檔案當時的版本紀錄，改用目前的記憶比對：檔案裡沒有列出的記憶會被當成「忘掉」');
    const r = applyMemoryText(st, memory, base, now);
    info.memory = r.changed;
    info.warnings.push(...r.warnings);
  }
  return info;
}

/** persona.txt 跟上次讀／寫時不一樣（使用者在 App 外改過）就套用。回傳這次的套用結果或 null。 */
function syncFromFile(dir, st) {
  let buf;
  try { buf = fs.readFileSync(personaFileOf(dir)); } catch { return syncFromLegacyHtml(dir, st); }
  const hash = sha1(buf);
  if (hash === st.profile.fileHash) return null;
  const parsed = companionText.fromText(companionText.decodeTextBytes(buf), { scenarioLabels: persona.SCENARIO_LABELS });
  const info = applyParsed(st, parsed, { dir });
  // 這份檔案的內容就是這個版本新的基準：同一份檔案再改一次時，只看新改的地方
  if (parsed.rev && parsed.patch.memory) saveBase(dir, parsed.rev, { ...memoryTexts(st), ...parsed.patch.memory });
  // 記下這份檔案已經讀過；內容也記成「已同步」，所以不會回頭用 App 的格式覆寫使用者的檔案
  st.profile.fileHash = hash;
  st.profile.fileSig = sigOf(st);
  st.profile.fileSync = info;
  st.fileChanged = true;
  return info;
}

/** 從 1.9.15～1.9.16 升級、還沒有 persona.txt：舊的 persona.html 在 App 最後一次寫入後被改過，就先套用它 */
function syncFromLegacyHtml(dir, st) {
  let buf;
  try { buf = fs.readFileSync(path.join(dir, LEGACY_HTML_FILE)); } catch { return null; }
  if (sha1(buf) === st.profile.htmlHash) return null;
  const info = applyParsed(st, companionHtml.fromHtml(companionHtml.decodeHtmlBytes(buf), { scenarioLabels: persona.SCENARIO_LABELS }));
  st.profile.htmlHash = sha1(buf);
  st.profile.fileSync = info;
  st.fileChanged = true;
  return info;
}

/** 舊的 persona.html 改名成 persona.old.html 保留（不刪），免得使用者改了舊檔卻沒有作用 */
function retireLegacyHtml(dir, st) {
  const old = path.join(dir, LEGACY_HTML_FILE);
  if (fs.existsSync(old)) {
    let target = path.join(dir, LEGACY_HTML_MOVED);
    if (fs.existsSync(target)) target = path.join(dir, `persona.old-${Date.now().toString(36)}.html`);
    try { fs.renameSync(old, target); } catch { /* 被別的程式開著：下次再試，不影響 persona.txt */ return; }
  }
  delete st.profile.htmlHash; delete st.profile.htmlSig; delete st.profile.htmlSync;
}

/** 人物設定在 App 裡改過（或還沒有 persona.txt）就重寫檔案。會改 st.profile，之後要存 profile.json。 */
function writeFileIfNeeded(dir, st) {
  const sig = sigOf(st);
  if (st.profile.fileSig === sig && fs.existsSync(personaFileOf(dir))) return false;
  const rev = newRev();
  const text = storedText(st, rev);
  saveBase(dir, rev, memoryTexts(st));
  atomicWrite(personaFileOf(dir), text);
  st.profile.fileHash = sha1(Buffer.from(text, 'utf8'));
  st.profile.fileSig = sig;
  retireLegacyHtml(dir, st);
  return true;
}

function renameCharacter(st, name) {
  const old = st.profile.name;
  st.profile.name = name;
  if (old) {
    st.profile.identity = (st.profile.identity || []).map((s) => s.split(old).join(name));
    st.memory.core.persona = String(st.memory.core.persona || '').split(old).join(name);
  }
}

function save(dir, st) {
  writeFileIfNeeded(dir, st);
  atomicWrite(path.join(dir, 'profile.json'), st.profile);
  atomicWrite(path.join(dir, 'memory.json'), st.memory);
  atomicWrite(path.join(dir, 'timeline.json'), st.timeline);
  atomicWrite(path.join(dir, 'relation.json'), st.relation);
}

function reset(root, characterId) {
  const dir = dirFor(root, characterId);
  if (!fs.existsSync(dir)) return { ok: true, removed: false };
  // 不直接刪：改名成備份資料夾，按錯還救得回來
  const backup = `${dir}.reset-${Date.now()}`;
  fs.renameSync(dir, backup);
  return { ok: true, removed: true, backup };
}

// ---------------------------------------------------------------- 文字相似度（本機檢索，不用 embedding API）
const STOP = new Set(['你的', '我的', '我們', '你們', '什麼', '一個', '這個', '那個', '就是', '不是', '沒有', '可以', '因為', '所以', '然後', '覺得', '真的', '現在', '今天', '一下', '知道', '還是', '怎麼', '這樣', '那樣', '自己', '他們', '對方']);
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of s.match(/[㐀-鿿]+/g) || []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) { const bg = run.slice(i, i + 2); if (!STOP.has(bg)) out.add(bg); }
  }
  return out;
}
function similarity(a, b) {
  const A = a instanceof Set ? a : tokens(a), B = b instanceof Set ? b : tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.sqrt(A.size * B.size);
}

// ---------------------------------------------------------------- 衰減
/** 記憶強度 0–1：重要度越高半衰期越長，被想起（檢索）過會加長；重要度 8 以上的事不會淡到 0.6 以下。 */
function memoryStrength(m, now = Date.now()) {
  const imp = clamp(num(m.importance, 3), 1, 10);
  const age = Math.max(0, now - Date.parse(m.lastAccessAt || m.createdAt || now)) / DAY;
  const halfLife = 0.75 * Math.pow(2, (imp - 1) / 1.5) * (1 + 0.25 * Math.min(8, num(m.accessCount)));
  const s = Math.exp(-Math.LN2 * age / halfLife);
  return imp >= 8 ? Math.max(0.6, s) : s;
}

/** 淡掉的記憶：細節（數字、時間）變模糊，允許她偶爾記錯小細節，但事情本身還在。 */
function blur(text) {
  return String(text || '').replace(/\d+(?:[.:：]\d+)?/g, '幾').replace(/(星期|週|禮拜)[一二三四五六日天]/g, '某天');
}

/** 時間造成的狀態回落：心情回到平常、火氣消退、舊帳慢慢淡掉。只依時間計算，可重複呼叫。 */
function decayRelation(rel, now = Date.now()) {
  const last = Date.parse(rel.decayedAt || now);
  const hours = Math.max(0, (now - last) / HOUR);
  if (hours > 0) {
    const f = (half) => Math.pow(0.5, hours / half);
    rel.irritation = Math.round(num(rel.irritation) * f(10) * 10) / 10;
    rel.mood.valence = Math.round((0.1 + (num(rel.mood.valence, 0.1) - 0.1) * f(6)) * 100) / 100;
    if (hours > 8) rel.mood.label = '普通';
    for (const g of rel.grudges) {
      if (g.status !== 'open') continue;
      g.severity = Math.round(num(g.severity) * f(g.severity >= 0.8 ? 168 : 72) * 100) / 100;
      // 氣消了但事情還記得
      if (g.severity < 0.1) { g.status = 'faded'; g.fadedAt = iso(now); }
    }
  }
  rel.decayedAt = iso(now);
  return rel;
}

// ---------------------------------------------------------------- 檢索
function retrieve(memory, query, now = Date.now(), k = 8) {
  const q = tokens(query);
  const scored = [];
  const rels = new Map(memory.archival.map((m) => [m, m.status === 'forgotten' ? 0 : similarity(q, m.text)]));
  // 相關度以這次候選中最相關的一則為基準正規化（Generative Agents 對三個分數做 min-max 的簡化版），
  // 但分母至少 0.15，免得只沾到一個常見字的記憶被放大成「很相關」
  const top = Math.max(0.15, ...rels.values());
  for (const m of memory.archival) {
    if (m.status === 'forgotten') continue;
    const strength = memoryStrength(m, now);
    const rel = rels.get(m) / top;
    const faded = strength < 0.2;
    // 淡掉的記憶要有線索（這次提到相關的字）才會被想起來
    if (faded && rel === 0) continue;
    const recency = Math.exp(-Math.max(0, now - Date.parse(m.lastAccessAt || m.createdAt)) / (72 * HOUR));
    const score = 1.2 * rel + 0.6 * clamp(num(m.importance, 3), 1, 10) / 10 + 0.4 * recency + 0.3 * strength;
    scored.push({ m, score, rel, strength, faded });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, k);
  // 被想起的記憶會變牢（只算真的相關的，免得每則都被無差別強化）
  for (const p of picked) if (p.rel >= 0.5) { p.m.lastAccessAt = iso(now); p.m.accessCount = num(p.m.accessCount) + 1; }
  return picked.map((p) => ({ id: p.m.id, kind: p.m.kind, importance: p.m.importance, at: p.m.createdAt, strength: Math.round(p.strength * 100) / 100,
    text: p.faded || (p.strength < 0.35 && num(p.m.importance) < 8) ? `（印象有點模糊）${blur(p.m.text)}` : p.m.text }));
}

// ---------------------------------------------------------------- 時間線（雙時間事實）
const normKey = (k) => String(k || '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60);

function upsertFact(timeline, { key, text, valid_at }, now = Date.now(), episode = null) {
  const k = normKey(key);
  const body = String(text || '').trim().slice(0, 200);
  if (!k || !body) return null;
  const at = valid_at && Number.isFinite(Date.parse(valid_at)) ? iso(Date.parse(valid_at)) : iso(now);
  const current = timeline.facts.find((f) => f.key === k && !f.invalid_at);
  if (current && similarity(current.text, body) >= 0.8) { current.confirmedAt = iso(now); return current; }
  const fact = { id: newId('fact'), key: k, text: body, valid_at: at, invalid_at: null, created_at: iso(now), expired_at: null, episode };
  if (current) { current.invalid_at = at; current.expired_at = iso(now); current.superseded_by = fact.id; }
  timeline.facts.push(fact);
  return fact;
}

function invalidateFact(timeline, key, now = Date.now(), reason = '') {
  const f = timeline.facts.find((x) => x.key === normKey(key) && !x.invalid_at);
  if (!f) return null;
  f.invalid_at = iso(now); f.expired_at = iso(now); f.invalid_reason = String(reason || '').slice(0, 120);
  return f;
}

/** 在某個時間點成立的事實（預設現在）。 */
function activeFacts(timeline, at = Date.now()) {
  return timeline.facts.filter((f) => Date.parse(f.valid_at) <= at && (!f.invalid_at || Date.parse(f.invalid_at) > at));
}

// ---------------------------------------------------------------- 時間感知
const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
function partOfDay(h) {
  return h < 5 ? '深夜' : h < 8 ? '清晨' : h < 11 ? '早上' : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜';
}
function spellGap(ms) {
  if (ms < 2 * 60000) return '剛剛才聊過';
  if (ms < HOUR) return `${Math.round(ms / 60000)} 分鐘`;
  if (ms < DAY) return `大約 ${Math.round(ms / HOUR)} 小時`;
  if (ms < 14 * DAY) return `${Math.round(ms / DAY)} 天`;
  if (ms < 60 * DAY) return `${Math.round(ms / (7 * DAY))} 週`;
  return `${Math.round(ms / (30 * DAY))} 個月`;
}
function timeContext(now, lastAt, profile) {
  const d = new Date(now);
  const gap = lastAt ? Math.max(0, now - Date.parse(lastAt)) : null;
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return {
    date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`,
    clock: `${hh}:${mm}`, part: partOfDay(d.getHours()),
    gapMs: gap, gapText: gap == null ? '這是你們在這裡第一次聊' : spellGap(gap),
    activity: persona.activityAt(d, profile),
    longAbsence: gap != null && gap >= 3 * DAY,
    needOffscreen: gap != null && gap >= 3 * HOUR,
  };
}

/** 兩次對話之間她大概做了哪些事：依作息抽樣當骨架，細節交給同一次模型呼叫補（不另花呼叫）。 */
function offscreenSkeleton(lastAt, now, profile) {
  const from = Date.parse(lastAt);
  if (!Number.isFinite(from) || now - from < 3 * HOUR) return [];
  const span = now - from;
  const steps = Math.min(6, Math.max(2, Math.round(span / (8 * HOUR))));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = from + (span * i) / (steps + 1);
    const a = persona.activityAt(new Date(t), profile);
    const d = new Date(t);
    const line = `${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]} ${partOfDay(d.getHours())}：${a.what}`;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- 關係
function stageOf(rel) {
  const f = num(rel.familiarity);
  return f < 20 ? '才認識不久' : f < 45 ? '聊得來的熟人' : f < 70 ? '朋友' : f < 88 ? '很熟的朋友' : '很重要的人';
}
const level = (v) => (v < 15 ? '很低' : v < 35 ? '偏低' : v < 60 ? '普通' : v < 80 ? '高' : '很高');
function describeRelation(rel) {
  return `關係：${stageOf(rel)}（熟悉度 ${Math.round(rel.familiarity)}、信任 ${Math.round(rel.trust)}、親近 ${Math.round(rel.closeness)}、火氣 ${Math.round(rel.irritation)}，0–100）`;
}

// ---------------------------------------------------------------- 提示詞
function buildPrompt(st, { userText, now, time, memories, scenarios, skeleton }) {
  const p = st.profile, rel = st.relation, name = p.name;
  const t = p.traits.current;
  const trait = (v, hi, lo) => (v >= 0.6 ? hi : v <= 0.4 ? lo : `${hi}與${lo}之間`);
  const facts = activeFacts(st.timeline, now).slice(-14);
  const changed = st.timeline.facts.filter((f) => f.invalid_at && f.superseded_by && now - Date.parse(f.expired_at) < 30 * DAY).slice(-4)
    .map((f) => { const n = st.timeline.facts.find((x) => x.id === f.superseded_by); return n ? `・以前「${f.text}」→ 現在「${n.text}」` : null; }).filter(Boolean);
  const episodes = st.timeline.episodes.slice(-8);
  const grudges = rel.grudges.filter((g) => g.status === 'open');
  const faded = rel.grudges.filter((g) => g.status === 'faded').slice(-3);
  const offscreen = st.timeline.offscreen.slice(-3);
  const when = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const P = promptSections(p);
  const list = (v) => (Array.isArray(v) ? v : []).filter(Boolean);

  return [
    P.intro,
    `【你】\n${list(p.identity).join('\n')}${p.age ? `\n年齡：${p.age}` : ''}\n個性：${trait(t.extraversion, '外向、行動派', '慢熟')}；${trait(t.agreeableness, '好相處', '不隨和、直來直往、會吐槽')}；${trait(t.neuroticism, '容易急躁上火', '情緒穩')}；${trait(t.openness, '好奇愛嘗鮮', '保守')}；${trait(t.conscientiousness, '做事有條理', '隨性不愛規劃')}。${p.facets || ''}。\n想事情的方式：${p.cognitiveStyle || ''}\n在乎：${list(p.values).join('、')}\n喜歡：${list(p.likes).join('、')}；討厭：${list(p.dislikes).join('、')}\n習慣：${list(p.habits).join('；')}\n界線：${list(p.boundaries).join('；')}\n講話：${p.speech || ''}\n刻在心裡的事：${list(p.lifeEpisodes).map((e) => e.text).join(' ')}`,
    P.principles ? `【你這個人】\n${P.principles.split('\n').filter((l) => l.trim()).map((l) => (/^[・\-*]/.test(l.trim()) ? l.trim() : `・${l.trim()}`)).join('\n')}` : '',
    `【現在】${time.date} ${time.clock}，${time.part}。你這時候大概：${time.activity.what}。\n距離上次跟對方聊天：${time.gapText}。${time.longAbsence ? '對方很久沒出現了，你可能有點在意（但不會直說），也可能已經不太在乎，看你們的關係。' : ''}${time.activity.availability === 'asleep' ? '你本來在睡覺。' : time.activity.availability === 'busy' ? '你正在忙，回得短很正常。' : ''}`,
    `【你和對方】\n${describeRelation(rel)}\n你現在的心情：${rel.mood.label}（愉快度 ${rel.mood.valence}，精神 ${rel.mood.energy}）\n${rel.lastImpression ? `你上次對對方的印象：${rel.lastImpression}\n` : ''}${grudges.length ? `還沒消氣／還在意的事：\n${grudges.map((g) => `・[${g.id}] ${g.text}（在意程度 ${g.severity}）`).join('\n')}\n` : ''}${faded.length ? `以前不爽過、現在氣消了但還記得：${faded.map((g) => g.text).join('；')}\n` : ''}`,
    `【你的核心記憶（你自己寫的筆記，可以改）】\n〈persona：關於你自己〉${st.memory.core.persona}\n〈human：關於對方〉${st.memory.core.human}\n〈relationship：你們之間〉${st.memory.core.relationship}`,
    `【跟這次有關、你想起來的事】\n${memories.length ? memories.map((m) => `・[${m.id}] ${when(m.at)} ${m.text}`).join('\n') : '（沒特別想起什麼）'}`,
    facts.length || changed.length ? `【你知道的近況（時間線）】\n${facts.map((f) => `・${f.key}：${f.text}（${when(f.valid_at)} 起）`).join('\n')}${changed.length ? `\n變過的事：\n${changed.join('\n')}` : ''}` : '',
    offscreen.length ? `【你之前沒在聊天時的生活（要跟這些一致）】\n${offscreen.map((o) => `・${when(o.from)}～${when(o.to)}：${o.text}`).join('\n')}` : '',
    skeleton.length ? `【上次聊完到現在，依你的作息你大概經歷了】\n${skeleton.join('\n')}\n（在 update.offscreen 用一兩句補上這段時間實際發生的事，要跟你的生活和之前的紀錄一致；可以有小插曲，但不要誇張。）` : '',
    episodes.length ? `【最近的對話（舊的在前）】\n${episodes.map((e) => `${when(e.at)} 對方：${e.user}\n${when(e.at)} 你：${e.reply}`).join('\n')}` : '',
    scenarios.length ? `【這次的情況】\n${scenarios.map((s) => `・${s.guide}`).join('\n')}` : '',
    P.extra ? `【另外要注意】\n${P.extra}` : '',
    `【對方剛剛傳來】（${time.clock}）\n${userText}`,
    `【怎麼回】
1. ${P.mind}
2. ${P.reply}
3. <update></update> 裡放一個 JSON，記下這回合真正值得留下的東西（大多數回合很少，寒暄閒聊不要記）：
{"memories":[{"text":"用你的口吻記一件事","kind":"promise|conflict|joke|event|preference|fact|feeling","importance":1到10}],
 "memory_edits":[{"id":"mem_…","text":"改寫後的內容","importance":數字}或{"id":"mem_…","forget":true}],
 "core_edits":[{"block":"human|relationship|persona","op":"append","text":"…"}或{"block":"…","op":"replace","old":"原本的一段字","text":"新的"}],
 "facts":[{"key":"例如 user.job、user.pet、me.climbing_route","text":"目前成立的事"}],
 "invalidate":[{"key":"…","reason":"…"}],
 "relationship":{"familiarity":-1到2,"trust":-4到3,"closeness":-3到2,"irritation":-20到25,"reason":"一句話"},
 "mood":{"label":"一兩個字","valence":-1到1,"energy":0到1},
 "grudges":{"add":[{"text":"你介意的事","severity":0到1}],"resolve":["g_…"]},
 "trait_shift":{"agreeableness":-0.01到0.01, "reason":"…"},
 "impression":"你現在對對方的一句話印象",
 "offscreen":"（只有上面要求補生活時才填）"}
沒有要改的欄位就省略。對方沒講過自己的性別之前，記憶、筆記、印象裡一律稱「對方」或「這個人」，不要用「他」「她」。importance 8 以上只給真的會記很久的事（承諾、大吵、重要事件）。
輸出格式固定是：<mind>…</mind><reply>…</reply><update>{…}</update>`,
  ].filter(Boolean).join('\n\n');
}

function rewritePrompt(st, { userText, draft, inner, issues, time }) {
  const name = st.profile.name;
  return [
    `你是${name}（${st.profile.speech}）。現在是 ${time.clock}，${time.part}；心情：${st.relation.mood.label}；${describeRelation(st.relation)}。`,
    `對方傳來：${userText}`,
    inner ? `你剛剛心裡嘀咕的是（照這個意思回，不要說出來）：${String(inner).slice(0, 800)}` : '',
    `你打了一則訊息但還沒送出，問題是：${issues.map((i) => i.message).join('；')}`,
    `草稿：${draft}`,
    `用${name}自己會傳的方式重寫這則訊息：口語、簡短、不條列、不講客套話和諮商腔、不提設定、不把心聲說出來。只輸出 <reply>重寫後的訊息</reply>。`,
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- 輸出解析、檢查、清理
function section(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, 'i').exec(text);
  return m ? m[1].trim() : null;
}
function parseJsonLoose(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
function parseOutput(text) {
  const raw = String(text || '');
  const inner = section(raw, 'mind') ?? section(raw, 'inner');
  const update = parseJsonLoose(section(raw, 'update'));
  let reply = section(raw, 'reply');
  if (reply == null) {
    // 模型沒照格式：拿掉心聲／update 區塊後剩下的當回覆，後面的檢查會再把關
    reply = raw.replace(/<(mind|inner)>[\s\S]*?(<\/\1>|$)/gi, '').replace(/<update>[\s\S]*?(<\/update>|$)/gi, '').trim();
  }
  return { inner, reply, update: update && typeof update === 'object' ? update : null, formatted: /<reply>/i.test(raw) };
}

const TEMPLATES = [
  /我(能|可以|完全)?理解你的(感受|心情|想法)/, /如果你(願意|想要?|需要)的話/, /如果你願意/, /這是一個(很|非常)?(有趣|好)的問題/,
  /需要我(幫|為)你/, /有什麼(我)?(可以|能)(幫|為)你/, /有什麼需要(幫忙)?(的)?(話)?(隨時)?(告訴|跟)我/, /希望(這|以上)?(對你)?有(所)?幫助/,
  /總(結|而言之)[，,：:]/, /總之，/, /以下(是|為)/, /首先[，,].*其次/s, /作為(一個)?(AI|人工智慧|語言模型|助理)/i, /我是(一個)?(AI)?助理/,
  /隨時(都)?(可以)?(來)?找我(聊)?/, /你的感受(是)?(很)?(正常|合理|重要)的/, /我(會)?一直(都)?在(這裡)?(陪著你)?[。！]?$/,
];
const LEAKS = [
  /<\/?(mind|inner|update|reply)>/i, /核心記憶|記憶(系統|區塊|模組)|人格(模組|設定)|角色(設定|卡)|長期記憶庫|檢索到/, /(熟悉度|信任度|親近度|好感度|火氣值)\s*[0-9０-９]/,
  /\b(familiarity|closeness|irritation|importance|core_edits|memory_edits|PsyAgent|RAR|Letta|Graphiti|Zep)\b/i, /system prompt|提示詞/i, /[（(]內心(戲|獨白|想法)?[:：]/, /^\s*內心[:：]/m, /\{\s*"(memories|relationship|mood)"/,
];
const HUMAN_CLAIM = /我(當然|就)?是(真人|真的人|人類)|我不是\s*AI|我有(真的)?身體|我不是(機器人|程式)/i;

/** 回傳 issues 陣列；空陣列代表可以直接送出。 */
function checkReply(reply, { identity = false, userText = '' } = {}) {
  const r = String(reply || '');
  const issues = [];
  if (!r.trim()) issues.push({ code: 'empty', message: '訊息是空的' });
  for (const re of TEMPLATES) if (re.test(r)) { issues.push({ code: 'template', message: `有模板句／客服腔（${(re.exec(r) || [''])[0]}）` }); break; }
  const lines = r.split('\n').filter((l) => l.trim());
  if (lines.filter((l) => /^\s*(?:[-*•・]|\d+[.、)）]|[一二三四五六七八九十]+、)\s*\S/.test(l)).length >= 2 || lines.some((l) => /^\s*#{1,6}\s/.test(l)) || /\*\*[^*]+\*\*/.test(r))
    issues.push({ code: 'list', message: '用了條列、標題或粗體，不像聊天' });
  for (const re of LEAKS) if (re.test(r)) { issues.push({ code: 'leak', message: '把內部推理、設定或記憶系統講出來了' }); break; }
  if (identity && HUMAN_CLAIM.test(r)) issues.push({ code: 'false_human', message: '被問到身分時假稱自己是真人或有身體' });
  const len = r.replace(/\s/g, '').length;
  if (len > 420 || (len > 220 && String(userText).replace(/\s/g, '').length < 40)) issues.push({ code: 'too_long', message: '太長了，像在寫文章而不是傳訊息' });
  if (/[？?]\s*$/.test(r) && /(要不要|需不需要|想不想)(我)?(幫|再|繼續|多)/.test(lines[lines.length - 1] || '')) issues.push({ code: 'next_step', message: '結尾在問對方下一步要不要幫忙' });
  return issues;
}

/** 把回覆整理成可以直接顯示的訊息（不改內容，只拿掉格式殘渣）。 */
function cleanReply(text, name = '') {
  let r = String(text || '');
  r = r.replace(/<(mind|inner)>[\s\S]*?(<\/\1>|$)/gi, '').replace(/<update>[\s\S]*?(<\/update>|$)/gi, '').replace(/<\/?reply>/gi, '');
  r = r.replace(/^```\w*\n?|```$/g, '').trim();
  if (name) r = r.replace(new RegExp(`^(?:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*[：:]\\s*`), '');
  r = r.replace(/^「([\s\S]*)」$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
  r = r.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*#{1,6}\s+/gm, '');
  return r.replace(/\n{3,}/g, '\n\n').trim();
}

/** 重寫後仍有問題時的最後防線：刪掉出問題的句子、拿掉條列符號；不再呼叫模型。 */
function scrub(reply) {
  let r = cleanReply(reply).replace(/^\s*(?:[-*•・]|\d+[.、)）])\s*/gm, '');
  const parts = r.split(/(?<=[。！？!?\n])/);
  const bad = (s) => TEMPLATES.some((re) => re.test(s)) || LEAKS.some((re) => re.test(s));
  const kept = parts.filter((s) => !bad(s));
  r = kept.join('').trim();
  return r || '……嗯。';
}

// ---------------------------------------------------------------- 更新（角色自己決定寫什麼，程式負責上限與一致性）
const KINDS = new Set(['promise', 'conflict', 'joke', 'event', 'preference', 'fact', 'feeling', 'offscreen', 'core_overflow']);

function addMemory(memory, m, now) {
  const text = String(m.text || '').trim().slice(0, 300);
  if (!text) return null;
  const kind = KINDS.has(m.kind) ? m.kind : 'event';
  const importance = clamp(Math.round(num(m.importance, 4)), 1, 10);
  // 瑣事不寫；承諾與偏好即使不重要也值得留（之後會自然衰減）
  if (importance < 3 && !['promise', 'preference'].includes(kind)) return null;
  const q = tokens(text);
  const dup = memory.archival.find((x) => x.status === 'active' && similarity(q, x.text) >= 0.6);
  if (dup) { dup.text = text; dup.importance = Math.max(num(dup.importance), importance); dup.lastAccessAt = iso(now); dup.accessCount = num(dup.accessCount) + 1; dup.updatedAt = iso(now); return dup; }
  const item = { id: newId('mem'), text, kind, importance, createdAt: iso(now), lastAccessAt: iso(now), accessCount: 0, status: 'active' };
  memory.archival.push(item);
  return item;
}

function pruneArchival(memory, now) {
  if (memory.archival.length <= MAX_ARCHIVAL) return;
  const ranked = memory.archival.map((m) => ({ m, s: m.status === 'active' ? memoryStrength(m, now) * num(m.importance, 3) : -1 })).sort((a, b) => a.s - b.s);
  const drop = new Set(ranked.slice(0, memory.archival.length - MAX_ARCHIVAL).map((x) => x.m.id));
  memory.archival = memory.archival.filter((m) => !drop.has(m.id));
}

function editCore(memory, e, now) {
  const block = ['persona', 'human', 'relationship'].includes(e.block) ? e.block : null;
  const text = String(e.text || '').trim().slice(0, 300);
  if (!block || !text) return false;
  let cur = String(memory.core[block] || '');
  if (e.op === 'replace') {
    const old = String(e.old || '');
    if (!old || !cur.includes(old)) return false;
    cur = cur.replace(old, text);
  } else cur = cur ? `${cur}\n${text}` : text;
  // 區塊有上限：超過時把最舊的行擠到長期記憶（Letta 的 memory pressure 處理方式）
  const lines = cur.split('\n');
  while (lines.join('\n').length > CORE_LIMIT[block] && lines.length > 1) {
    const oldLine = lines.shift();
    addMemory(memory, { text: `（從${block}筆記移出）${oldLine}`, kind: 'core_overflow', importance: 5 }, now);
  }
  memory.core[block] = lines.join('\n').slice(-CORE_LIMIT[block]);
  return true;
}

function applyUpdate(st, update, { now = Date.now(), episodeId = null, skeleton = [] } = {}) {
  const u = update && typeof update === 'object' ? update : {};
  const rel = st.relation, applied = { memories: 0, edits: 0, core: 0, facts: 0, invalidated: 0, grudges: 0 };

  for (const m of (Array.isArray(u.memories) ? u.memories : []).slice(0, 3)) if (addMemory(st.memory, m, now)) applied.memories++;
  for (const e of (Array.isArray(u.memory_edits) ? u.memory_edits : []).slice(0, 4)) {
    const m = st.memory.archival.find((x) => x.id === e.id);
    if (!m) continue;
    if (e.forget) { m.status = 'forgotten'; m.forgottenAt = iso(now); } else {
      if (e.text) m.text = String(e.text).slice(0, 300);
      if (e.importance != null) m.importance = clamp(Math.round(num(e.importance, m.importance)), 1, 10);
      m.updatedAt = iso(now);
    }
    applied.edits++;
  }
  for (const e of (Array.isArray(u.core_edits) ? u.core_edits : []).slice(0, 3)) if (editCore(st.memory, e, now)) applied.core++;
  for (const f of (Array.isArray(u.facts) ? u.facts : []).slice(0, 5)) if (upsertFact(st.timeline, f, now, episodeId)) applied.facts++;
  for (const f of (Array.isArray(u.invalidate) ? u.invalidate : []).slice(0, 5)) if (invalidateFact(st.timeline, f.key || f, now, f.reason)) applied.invalidated++;

  // 關係：每回合變化有上限；熟悉度隨互動自然增加（越熟增加越慢）
  const r = u.relationship || {};
  const before = { familiarity: rel.familiarity, trust: rel.trust, closeness: rel.closeness, irritation: rel.irritation };
  rel.familiarity = clamp(num(rel.familiarity) + 0.4 * (1 - num(rel.familiarity) / 100) + clamp(num(r.familiarity), -1, 2), 0, 100);
  rel.trust = clamp(num(rel.trust) + clamp(num(r.trust), -4, 3), 0, 100);
  let dc = clamp(num(r.closeness), -3, 2);
  // 不每次推進關係：12 小時內已經拉近過，這次最多再 +0.5
  if (dc > 0 && rel.lastClosenessGainAt && now - Date.parse(rel.lastClosenessGainAt) < 12 * HOUR) dc = Math.min(dc, 0.5);
  if (dc > 0) rel.lastClosenessGainAt = iso(now);
  rel.closeness = clamp(num(rel.closeness) + dc, 0, 100);
  rel.irritation = clamp(num(rel.irritation) + clamp(num(r.irritation), -20, 25), 0, 100);
  for (const k of Object.keys(before)) rel[k] = Math.round(rel[k] * 10) / 10;
  const changed = Object.keys(before).filter((k) => Math.abs(rel[k] - before[k]) >= 1);
  if (changed.length || r.reason) rel.log.push({ at: iso(now), ...Object.fromEntries(Object.keys(before).map((k) => [k, Math.round((rel[k] - before[k]) * 10) / 10])), reason: String(r.reason || '').slice(0, 120), episode: episodeId });
  if (rel.log.length > 300) rel.log = rel.log.slice(-300);

  if (u.mood && typeof u.mood === 'object') {
    if (u.mood.label) rel.mood.label = String(u.mood.label).slice(0, 12);
    if (u.mood.valence != null) rel.mood.valence = Math.round(clamp(num(u.mood.valence, rel.mood.valence), -1, 1) * 100) / 100;
    if (u.mood.energy != null) rel.mood.energy = Math.round(clamp(num(u.mood.energy, rel.mood.energy), 0, 1) * 100) / 100;
  }
  const g = u.grudges || {};
  for (const x of (Array.isArray(g.add) ? g.add : []).slice(0, 2)) {
    const text = String(x.text || '').trim().slice(0, 160);
    if (!text) continue;
    rel.grudges.push({ id: newId('g'), text, severity: clamp(num(x.severity, 0.4), 0.05, 1), status: 'open', createdAt: iso(now) });
    addMemory(st.memory, { text: `我不爽的事：${text}`, kind: 'conflict', importance: clamp(Math.round(4 + num(x.severity, 0.4) * 5), 4, 9) }, now);
    applied.grudges++;
  }
  for (const id of Array.isArray(g.resolve) ? g.resolve : []) {
    const x = rel.grudges.find((y) => y.id === id && y.status !== 'resolved');
    if (x) { x.status = 'resolved'; x.resolvedAt = iso(now); applied.grudges++; }
  }
  if (rel.grudges.length > 60) rel.grudges = rel.grudges.filter((x) => x.status === 'open').concat(rel.grudges.filter((x) => x.status !== 'open').slice(-40));

  // 人格漂移：每回合每項最多 ±0.01，累積不離開出廠值 ±0.12（長期穩定、慢慢被經歷改變）
  const ts = u.trait_shift || {};
  const traits = st.profile.traits;
  for (const k of Object.keys(traits.baseline)) {
    if (ts[k] == null) continue;
    const d = clamp(num(ts[k]), -0.01, 0.01);
    if (!d) continue;
    const next = clamp(traits.current[k] + d, traits.baseline[k] - 0.12, traits.baseline[k] + 0.12);
    if (next !== traits.current[k]) { traits.current[k] = Math.round(next * 1000) / 1000; traits.drift.push({ at: iso(now), trait: k, delta: d, reason: String(ts.reason || '').slice(0, 120) }); }
  }
  if (traits.drift.length > 200) traits.drift = traits.drift.slice(-200);

  if (u.impression) rel.lastImpression = String(u.impression).slice(0, 160);
  if (skeleton.length && u.offscreen) {
    const text = String(u.offscreen).trim().slice(0, 400);
    if (text) {
      st.timeline.offscreen.push({ id: newId('off'), from: rel.lastInteractionAt, to: iso(now), text, at: iso(now) });
      if (st.timeline.offscreen.length > 120) st.timeline.offscreen = st.timeline.offscreen.slice(-120);
      addMemory(st.memory, { text: `（沒聊天的時候）${text}`, kind: 'offscreen', importance: 3 }, now);
    }
  }
  pruneArchival(st.memory, now);
  return applied;
}

// ---------------------------------------------------------------- 一個回合
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/**
 * 跑一個回合。
 * opts: { root, characterId, name, userText, runner, signal, now, timeoutMs, onProgress }
 * 回傳 { reply, calls, issues, applied, name }
 */
function turn(opts = {}) {
  const dir = dirFor(opts.root, opts.characterId);
  return withLock(dir, () => runTurn(dir, opts));
}

async function runTurn(dir, { name, userText, runner, signal, now: nowOpt, timeoutMs = 300000, onProgress } = {}) {
  if (!runner) throw new Error('陪伴角色尚未取得目前對話的模型');
  const text = String(userText || '').trim();
  if (!text) throw new Error('沒有訊息內容');
  const now = nowOpt ? +new Date(nowOpt) : Date.now();
  const st = load(dir, { name, now });
  decayRelation(st.relation, now);
  const time = timeContext(now, st.relation.lastInteractionAt, st.profile);
  const scenarios = persona.detectScenarios(text, (st.profile.prompt || {}).scenarios);
  const identity = scenarios.some((s) => s.id === 'identity');
  const recentText = st.timeline.episodes.slice(-2).map((e) => `${e.user} ${e.reply}`).join(' ');
  const memories = retrieve(st.memory, `${text} ${recentText}`, now, 8);
  const skeleton = time.needOffscreen ? offscreenSkeleton(st.relation.lastInteractionAt, now, st.profile) : [];
  const start = Date.now();
  let calls = 0;
  const ask = async (prompt, label) => {
    if (signal?.aborted) throw new Error('已取消');
    if (calls >= MAX_CALLS) throw new Error('已達每回合模型呼叫上限');
    calls++;
    onProgress?.(`${st.profile.name}：${label}`);
    const left = Math.max(15000, timeoutMs - (Date.now() - start));
    const r = await runner.ask(prompt, { name: `陪伴角色：${label}`, signal, timeoutMs: left, preamble: '', ephemeral: true });
    return String(r?.text || '');
  };

  const out = parseOutput(await ask(buildPrompt(st, { userText: text, now, time, memories, scenarios, skeleton }), '想一下再回'));
  let reply = cleanReply(out.reply, st.profile.name);
  let issues = checkReply(reply, { identity, userText: text });
  const firstIssues = issues;
  if (issues.length) {
    const second = parseOutput(await ask(rewritePrompt(st, { userText: text, draft: reply, inner: out.inner, issues, time }), '重寫訊息'));
    const again = cleanReply(second.reply, st.profile.name);
    const againIssues = checkReply(again, { identity, userText: text });
    if (again && againIssues.length <= issues.length) { reply = again; issues = againIssues; }
    if (issues.length) reply = scrub(reply);
  }
  if (!reply) reply = '……嗯。';

  const episodeId = newId('ep');
  const applied = applyUpdate(st, out.update, { now, episodeId, skeleton });
  st.timeline.episodes.push({ id: episodeId, at: iso(now), user: text.slice(0, 600), reply: reply.slice(0, 600), inner: String(out.inner || '').slice(0, 600), scenarios: scenarios.map((s) => s.id), calls, issues: firstIssues.map((i) => i.code) });
  if (st.timeline.episodes.length > MAX_EPISODES) st.timeline.episodes = st.timeline.episodes.slice(-MAX_EPISODES);
  st.relation.turns = num(st.relation.turns) + 1;
  st.relation.lastInteractionAt = iso(now);
  save(dir, st);
  return { reply, calls, issues: firstIssues, applied, name: st.profile.name, updateParsed: !!out.update };
}

// ---------------------------------------------------------------- 使用者自己編輯角色與提示詞
const PROMPT_KEYS = ['intro', 'principles', 'mind', 'reply', 'extra'];
const LIST_KEYS = ['identity', 'values', 'likes', 'dislikes', 'habits', 'boundaries'];
const TEXT_KEYS = ['facets', 'cognitiveStyle', 'speech', 'schedule'];
const TRAIT_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

/** 目前生效的提示詞段落：有自訂就用自訂的，否則用預設；{name} 換成角色名字。 */
function promptSections(profile) {
  const o = (profile && profile.prompt) || {};
  const name = (profile && profile.name) || persona.DEFAULT_NAME;
  const out = {};
  for (const k of PROMPT_KEYS) {
    const v = typeof o[k] === 'string' && o[k].trim() ? o[k] : persona.DEFAULT_PROMPT[k];
    out[k] = String(v || '').split('{name}').join(name).trim();
  }
  return out;
}

const episodesToText = (eps) => (Array.isArray(eps) ? eps : []).map((e) => `[${clamp(Math.round(num(e.importance, 7)), 1, 10)}] ${e.text}`).join('\n');
function textToEpisodes(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 30).map((l) => {
    const m = /^[[［(（]?\s*(\d{1,2})\s*[\]］)）]\s*(.+)$/.exec(l);
    return m ? { text: m[2].slice(0, 400), importance: clamp(Number(m[1]), 1, 10) } : { text: l.slice(0, 400), importance: 7 };
  });
}

function editable(st) {
  const p = st.profile, o = p.prompt || {};
  return {
    name: p.name, age: p.age == null ? '' : String(p.age),
    ...Object.fromEntries(LIST_KEYS.map((k) => [k, (Array.isArray(p[k]) ? p[k] : []).join('\n')])),
    ...Object.fromEntries(TEXT_KEYS.map((k) => [k, String(p[k] || '')])),
    lifeEpisodes: episodesToText(p.lifeEpisodes),
    traits: { ...p.traits.baseline },
    prompt: Object.fromEntries(PROMPT_KEYS.map((k) => [k, typeof o[k] === 'string' && o[k].trim() ? o[k] : persona.DEFAULT_PROMPT[k]])),
    promptCustom: PROMPT_KEYS.filter((k) => typeof o[k] === 'string' && o[k].trim()),
    scenarios: persona.SCENARIOS.map((s) => ({ id: s.id, label: persona.SCENARIO_LABELS[s.id] || s.id, guide: String((o.scenarios || {})[s.id] || '').trim() || s.guide, custom: !!String((o.scenarios || {})[s.id] || '').trim(), default: s.guide })),
    defaults: { prompt: persona.DEFAULT_PROMPT, scheduleExample: persona.SCHEDULE_EXAMPLE },
    scheduleOk: !String(p.schedule || '').trim() || persona.parseSchedule(p.schedule).length > 0,
  };
}

const withFile = (dir, st) => ({ ...editable(st), personaFile: personaFileOf(dir), personaSync: st.profile.fileSync || null });

function getEditable(root, characterId, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withFile(dir, load(dir, { name, now }));
}

/** 確保 persona.txt 存在且是最新的（剛升級、還沒聊過時也要有檔案可以打開）。回傳 getEditable 的內容。 */
function ensurePersonaFile(root, characterId, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withLock(dir, async () => {
    const st = load(dir, { name, now });
    if (writeFileIfNeeded(dir, st) || st.fileChanged) saveAll(dir, st); // 角色檔裡改了記憶／關係時也要存
    return withFile(dir, st);
  });
}

/** 把編輯器格式的內容套到人物設定上（編輯器儲存與 persona.txt 共用）。 */
function applyPatch(st, patch = {}) {
    const p = st.profile;
    const newName = String(patch.name ?? p.name).trim().slice(0, 20);
    if (newName && newName !== p.name) renameCharacter(st, newName);
    if (patch.age !== undefined) { const a = String(patch.age).trim(); p.age = /^\d{1,3}$/.test(a) ? Number(a) : a.slice(0, 20); }
    for (const k of LIST_KEYS) if (patch[k] !== undefined) p[k] = String(patch[k]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40).map((l) => l.slice(0, 400));
    for (const k of TEXT_KEYS) if (patch[k] !== undefined) p[k] = String(patch[k]).slice(0, k === 'schedule' ? 4000 : 1200).trim();
    if (patch.lifeEpisodes !== undefined) p.lifeEpisodes = textToEpisodes(patch.lifeEpisodes);
    if (patch.traits && typeof patch.traits === 'object') {
      for (const k of TRAIT_KEYS) {
        if (patch.traits[k] == null || !Number.isFinite(Number(patch.traits[k]))) continue;
        const nb = Math.round(clamp(Number(patch.traits[k]), 0, 1) * 100) / 100;
        const delta = nb - p.traits.baseline[k];
        p.traits.baseline[k] = nb;
        // 已經累積的漂移保留：目前值跟著出廠值一起平移
        p.traits.current[k] = Math.round(clamp(p.traits.current[k] + delta, Math.max(0, nb - 0.12), Math.min(1, nb + 0.12)) * 1000) / 1000;
      }
    }
    const o = { ...(p.prompt || {}) };
    if (patch.prompt && typeof patch.prompt === 'object') {
      for (const k of PROMPT_KEYS) {
        if (patch.prompt[k] === undefined) continue;
        const v = String(patch.prompt[k] || '').slice(0, 6000);
        // 跟預設一樣（或清空）就不存，之後預設更新時才會跟著更新
        if (!v.trim() || v.trim() === String(persona.DEFAULT_PROMPT[k] || '').trim()) delete o[k]; else o[k] = v;
      }
    }
    if (patch.scenarios && typeof patch.scenarios === 'object') {
      const sc = { ...(o.scenarios || {}) };
      for (const s of persona.SCENARIOS) {
        if (patch.scenarios[s.id] === undefined) continue;
        const v = String(patch.scenarios[s.id] || '').trim().slice(0, 1500);
        if (!v || v === s.guide) delete sc[s.id]; else sc[s.id] = v;
      }
      if (Object.keys(sc).length) o.scenarios = sc; else delete o.scenarios;
    }
    if (Object.keys(o).length) p.prompt = o; else delete p.prompt;
}

/** 只改人物設定與提示詞；記憶、關係、時間線都不動。回傳 { ...editable, name, personaFile }。 */
function saveEditable(root, characterId, patch = {}, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withLock(dir, async () => {
    const st = load(dir, { name, now });
    applyPatch(st, patch);
    writeFileIfNeeded(dir, st);
    saveAll(dir, st); // 改名時核心筆記裡的名字也要跟著換；檔案剛被記事本改過記憶時也要存
    return withFile(dir, st);
  });
}

/** 全文編輯用：目前角色檔的完整內容（和 persona.txt 一樣，帶檔案版本）。 */
function getFullText(root, characterId, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withLock(dir, async () => {
    const st = load(dir, { name, now });
    if (writeFileIfNeeded(dir, st) || st.fileChanged) saveAll(dir, st);
    const text = companionText.decodeTextBytes(fs.readFileSync(personaFileOf(dir)));
    return { text, personaFile: personaFileOf(dir), name: st.profile.name };
  });
}

/**
 * 全文編輯按儲存／載入整份 TXT：人物與 Prompt 照檔案；她記得的事只套用改動的行
 * （文字帶的檔案版本還在紀錄裡時，和當時的內容比；外來的檔案就和目前的記憶比）。
 */
function saveFullText(root, characterId, text, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withLock(dir, async () => {
    const st = load(dir, { name, now });
    const parsed = companionText.fromText(String(text || ''), { scenarioLabels: persona.SCENARIO_LABELS });
    if (!parsed.found.length) { const e = new Error('這份文字裡找不到任何【欄位】（每個欄位要以一行「【名字】」這樣的標題開頭），沒有儲存。'); e.code = 'NO_FIELDS'; throw e; }
    const info = applyParsed(st, parsed, { dir, now });
    st.profile.fileSync = info;
    writeFileIfNeeded(dir, st);
    saveAll(dir, st);
    return { ...withFile(dir, st), result: info };
  });
}

/** 另存用：編輯器上的人物設定（patch）＋目前她記得的事，組成一份完整的 TXT。 */
function exportFullText(root, characterId, patch = {}, { name, now = Date.now(), exportedAt = new Date() } = {}) {
  const st = load(dirFor(root, characterId), { name, now });
  const merged = { ...editablePatch(st), ...patch };
  return '\uFEFF' + companionText.toText(merged, { scenarioLabels: persona.SCENARIO_LABELS, exportedAt, memory: memoryTexts(st) });
}

function saveAll(dir, st) {
  atomicWrite(path.join(dir, 'profile.json'), st.profile);
  atomicWrite(path.join(dir, 'memory.json'), st.memory);
  atomicWrite(path.join(dir, 'timeline.json'), st.timeline);
  atomicWrite(path.join(dir, 'relation.json'), st.relation);
}

/** 人物設定與提示詞回到預設（記憶、關係不動）。 */
function resetEditable(root, characterId, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  return withLock(dir, async () => {
    const st = load(dir, { name, now });
    st.profile = { ...persona.defaultProfile(name || persona.DEFAULT_NAME), nameFromSettings: name || undefined };
    writeFileIfNeeded(dir, st);
    atomicWrite(path.join(dir, 'profile.json'), st.profile);
    return withFile(dir, st);
  });
}

/** 預覽這一刻真正會送給模型的完整提示詞（不呼叫模型、不寫檔）。 */
function previewPrompt(root, characterId, { name, userText = '（這裡會是對方傳來的訊息）', now = Date.now() } = {}) {
  const st = load(dirFor(root, characterId), { name, now });
  decayRelation(st.relation, now);
  const time = timeContext(now, st.relation.lastInteractionAt, st.profile);
  const scenarios = persona.detectScenarios(userText, (st.profile.prompt || {}).scenarios);
  const recentText = st.timeline.episodes.slice(-2).map((e) => `${e.user} ${e.reply}`).join(' ');
  const memories = retrieve(st.memory, `${userText} ${recentText}`, now, 8);
  const skeleton = time.needOffscreen ? offscreenSkeleton(st.relation.lastInteractionAt, now, st.profile) : [];
  return buildPrompt(st, { userText, now, time, memories, scenarios, skeleton });
}

// ---------------------------------------------------------------- 設定畫面：她記得什麼、關係狀態
function inspect(root, characterId, { name, now = Date.now() } = {}) {
  const dir = dirFor(root, characterId);
  const exists = fs.existsSync(path.join(dir, 'relation.json'));
  const st = load(dir, { name, now });
  decayRelation(st.relation, now);
  const mems = st.memory.archival.filter((m) => m.status === 'active')
    .map((m) => ({ ...m, strength: Math.round(memoryStrength(m, now) * 100) / 100 }))
    .sort((a, b) => b.strength * b.importance - a.strength * a.importance);
  return {
    exists, dir, name: st.profile.name, turns: st.relation.turns, lastInteractionAt: st.relation.lastInteractionAt,
    stage: stageOf(st.relation), relation: { familiarity: st.relation.familiarity, trust: st.relation.trust, closeness: st.relation.closeness, irritation: st.relation.irritation },
    mood: st.relation.mood, impression: st.relation.lastImpression, core: st.memory.core,
    grudges: st.relation.grudges.filter((g) => g.status !== 'resolved').slice(-10),
    memories: mems.slice(0, 40), memoryCount: mems.length,
    facts: activeFacts(st.timeline, now), expiredFacts: st.timeline.facts.filter((f) => f.invalid_at).slice(-10),
    offscreen: st.timeline.offscreen.slice(-5), traits: st.profile.traits.current, relationLog: st.relation.log.slice(-10),
  };
}

function describeText(info) {
  const when = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '還沒聊過');
  const lines = [
    `${info.name}｜${info.stage}｜聊過 ${info.turns} 回合｜上次：${when(info.lastInteractionAt)}`,
    `熟悉 ${Math.round(info.relation.familiarity)}／信任 ${Math.round(info.relation.trust)}／親近 ${Math.round(info.relation.closeness)}／火氣 ${Math.round(info.relation.irritation)}｜心情：${info.mood.label}`,
    info.impression ? `她對你的印象：${info.impression}` : '',
    info.grudges.length ? `還在意的事：\n${info.grudges.map((g) => `  ・${g.text}（${g.status === 'open' ? `在意 ${g.severity}` : '氣消了但記得'}）`).join('\n')}` : '',
    `核心筆記\n  關於自己：${info.core.persona}\n  關於你：${info.core.human}\n  你們之間：${info.core.relationship}`,
    info.facts.length ? `目前成立的事：\n${info.facts.map((f) => `  ・${f.key}：${f.text}`).join('\n')}` : '',
    info.expiredFacts.length ? `已經不成立的事：\n${info.expiredFacts.map((f) => `  ・${f.key}：${f.text}（${when(f.invalid_at)} 失效）`).join('\n')}` : '',
    `記得的事（共 ${info.memoryCount} 件，依印象深刻程度）：\n${info.memories.slice(0, 20).map((m) => `  ・[${m.kind}｜重要 ${m.importance}｜印象 ${m.strength}] ${m.text}`).join('\n')}`,
    info.offscreen.length ? `最近沒聊天時的生活：\n${info.offscreen.map((o) => `  ・${o.text}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/** 不呼叫模型的自我測試：寫入、衰減、時間線、檢查器都要正常。 */
function health() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-health-'));
  try {
    const now = Date.now();
    const st = load(dirFor(root, 'h'), { now });
    upsertFact(st.timeline, { key: 'user.job', text: '在做餐飲' }, now - DAY);
    upsertFact(st.timeline, { key: 'user.job', text: '換去當工程師' }, now);
    save(dirFor(root, 'h'), st);
    const back = load(dirFor(root, 'h'), { now });
    const ok = activeFacts(back.timeline, now).length === 1 && checkReply('我理解你的感受').length > 0 && checkReply('蛤？你現在才吃飯？').length === 0;
    return { ok };
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } }
}

module.exports = {
  MAX_CALLS, atomicWrite, load, save, reset, dirFor, turn, inspect, describeText, health,
  tokens, similarity, memoryStrength, blur, decayRelation, retrieve, upsertFact, invalidateFact, activeFacts,
  getEditable, saveEditable, resetEditable, ensurePersonaFile, previewPrompt, promptSections, PERSONA_FILE, LEGACY_HTML_FILE, LEGACY_HTML_MOVED, editablePatch,
  getFullText, saveFullText, exportFullText, memoryTexts, applyMemoryText, BASE_FILE,
  timeContext, offscreenSkeleton, stageOf, buildPrompt, rewritePrompt, parseOutput, checkReply, cleanReply, scrub, applyUpdate, addMemory, editCore,
};
