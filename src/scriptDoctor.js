// Script Doctor：寫故事／劇本的多階段 harness，外加劇本診斷。
// 診斷面向與確定性關鍵字規則取自 ScriptDoctor-AI（Apache-2.0，見 vendor/scriptdoctor/NOTICE.md）；
// 每一次模型呼叫都走傳進來的 conversation runner，也就是目前對話的模型與登入方式。
const upstream = require('./vendor/scriptdoctor/upstream_audit');

const PREFIX = '這是純文字創作任務，只輸出要求的文字，不使用工具或修改檔案。';
const MIN_LEFT = 10000;
const WRITE_STAGES = ['前提與 logline', '角色與結構大綱（beat sheet）', '分場表', '初稿', 'Script Doctor 診斷', '依診斷修稿', '最終檢查'];
const REVIEW_STAGES = ['確定性檢查', 'Script Doctor 診斷', '修稿建議'];

const isScreenplay = (format) => !/小說|散文|故事體|prose|novel|short story/i.test(String(format || ''));
const spell = (ms) => ms >= 60000 ? `${Math.round(ms / 60000)} 分鐘` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
const minutes = (value, fallback) => Math.min(60, Math.max(1, Number(value) || fallback)) * 60000;

function stripFence(text) {
  const m = /```[\w-]*\n([\s\S]*?)```/.exec(String(text || ''));
  return (m ? m[1] : String(text || '')).trim();
}
function parseJson(text) {
  const raw = stripFence(text);
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}
function countPlannedScenes(sceneList) {
  return String(sceneList || '').split('\n').filter((l) => /^\s*(?:第\s*\d+\s*場|場\s*\d+|\d+\s*[.、)）:：]|(?:INT|EXT|INT\.?\/EXT|I\/E)[.\s])/i.test(l)).length;
}

// ---- 確定性檢查（Fountain 語法依 https://fountain.io/syntax）----
const HEADING = /^(?:(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s]|\.[^.\s])/i;
const TRANSITION = /^(?:[A-Z\s]+TO:|>[^<]*)$/;
const CJK_CUE = /^[一-鿿·]{1,6}(?:\s*[（(][^)）]*[)）])?$/;

function lint(text, { screenplay = true, plannedScenes = 0 } = {}) {
  const body = String(text || '').replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
  let lines = body.split('\n');
  if (/^(?:title|credit|authors?|source|draft date|date|contact|notes|copyright)\s*:/i.test(lines[0] || '')) {
    const blank = lines.findIndex((l) => !l.trim());
    lines = blank < 0 ? [] : lines.slice(blank);
  }
  const issues = [];
  const audit = upstream.runScreenplayAudit(body);
  if (audit.has_risk) issues.push({ level: 'warn', code: 'upstream_anachronism', message: `上游 ScriptDoctor-AI 關鍵字規則（風險 ${audit.risk_score}）：${audit.violations.join(' ')} 若故事不是發生在過去年代可忽略。` });
  if (!screenplay) {
    const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
    const quoted = (body.match(/[「“"][^」”"]*[」”"]/g) || []).join('').length;
    const ratio = body.trim() ? quoted / body.replace(/\s/g, '').length : 0;
    if (!paragraphs.length) issues.push({ level: 'error', code: 'empty', message: '沒有任何內文。' });
    const long = paragraphs.filter((p) => p.length > 600).length;
    if (long) issues.push({ level: 'warn', code: 'long_paragraph', message: `有 ${long} 段超過 600 字，閱讀節奏偏重。` });
    return { ok: !issues.some((i) => i.level === 'error'), format: 'prose', stats: { paragraphs: paragraphs.length, dialogueRatio: Number(ratio.toFixed(2)) }, issues, upstream_audit: audit };
  }
  let scenes = 0, emptyScenes = 0, sceneHasContent = true, dialogueLines = 0, actionLines = 0, orphan = 0, cjkCues = 0, longAction = 0;
  const speakers = new Map();
  let block = [];
  const flushAction = () => { if (block.length > 4 || block.join('').length > 350) longAction++; block = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushAction(); continue; }
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const next = (lines[i + 1] || '').trim();
    if (prevBlank && HEADING.test(line)) {
      flushAction();
      if (scenes && !sceneHasContent) emptyScenes++;
      scenes++; sceneHasContent = false; continue;
    }
    if (prevBlank && TRANSITION.test(line)) { flushAction(); continue; }
    const cue = prevBlank && next && !/^[!]/.test(line) && (line.startsWith('@') || (/[A-Z]/.test(line) && !/[a-z]/.test(line.replace(/\(.*?\)/g, ''))));
    if (cue) {
      flushAction(); sceneHasContent = true;
      const name = line.replace(/^@/, '').replace(/\s*[（(].*$/, '').replace(/\s*\^$/, '').trim();
      let spoken = 0, j = i + 1;
      for (; j < lines.length && lines[j].trim(); j++) if (!/^\(.*\)$/.test(lines[j].trim())) spoken++;
      if (!spoken) orphan++;
      dialogueLines += spoken;
      speakers.set(name, (speakers.get(name) || 0) + 1);
      i = j - 1; continue;
    }
    // 角色名後面直接空行：常見的格式錯誤，台詞被隔開變成動作描述
    if (prevBlank && !next && !/^(?:THE END|END|FADE (?:IN|OUT)|CUT TO BLACK)\.?$/.test(line) && (line.startsWith('@') || /^[A-Z][A-Z .'-]{0,30}(?:\s*\(.*\))?$/.test(line))) { orphan++; continue; }
    if (prevBlank && next && CJK_CUE.test(line)) cjkCues++;
    sceneHasContent = true; actionLines++; block.push(line);
  }
  flushAction();
  if (scenes && !sceneHasContent) emptyScenes++;
  const ratio = dialogueLines + actionLines ? dialogueLines / (dialogueLines + actionLines) : 0;
  if (!scenes) issues.push({ level: 'error', code: 'no_scene_heading', message: '找不到任何場景標題（INT./EXT. 開頭，或以「.」強制標題），不是有效的 Fountain 劇本。' });
  if (orphan) issues.push({ level: 'error', code: 'orphan_cue', message: `有 ${orphan} 個角色名後面沒有台詞。` });
  if (cjkCues) issues.push({ level: 'warn', code: 'cjk_cue_without_at', message: `有 ${cjkCues} 行看起來是中文角色名，但沒有加「@」，Fountain 會把它當成動作描述。` });
  if (emptyScenes) issues.push({ level: 'warn', code: 'empty_scene', message: `有 ${emptyScenes} 場只有標題沒有內容。` });
  if (longAction) issues.push({ level: 'warn', code: 'long_action', message: `有 ${longAction} 段動作描述超過 4 行或 350 字，建議拆短。` });
  if (plannedScenes && Math.abs(scenes - plannedScenes) > Math.max(1, Math.round(plannedScenes / 3))) issues.push({ level: 'warn', code: 'scene_count_mismatch', message: `分場表規劃 ${plannedScenes} 場，劇本實際 ${scenes} 場。` });
  if (dialogueLines + actionLines && (ratio < 0.2 || ratio > 0.8)) issues.push({ level: 'info', code: 'dialogue_ratio', message: `對白占比 ${Math.round(ratio * 100)}%，${ratio < 0.2 ? '偏少' : '偏多'}。` });
  const once = [...speakers].filter(([, n]) => n === 1).map(([n]) => n);
  if (once.length) issues.push({ level: 'info', code: 'one_line_characters', message: `只說過一次話的角色：${once.slice(0, 5).join('、')}${once.length > 5 ? ' 等' : ''}。` });
  return { ok: !issues.some((i) => i.level === 'error'), format: 'fountain', stats: { scenes, characters: Object.fromEntries(speakers), dialogueLines, actionLines, dialogueRatio: Number(ratio.toFixed(2)) }, issues, upstream_audit: audit };
}
const lintText = (report) => report.issues.length ? report.issues.map((i) => `- [${i.level}] ${i.code}：${i.message}`).join('\n') : '- 沒有發現格式問題';

// ---- 時間預算、取消、進度：跟 RAGthoven 一樣，整條流程共用一個總時間 ----
function budgeted(stages, { runner, signal, timeoutMs, onProgress }, body) {
  if (!runner) return Promise.reject(new Error('Script Doctor 尚未取得目前對話的模型'));
  if (signal?.aborted) return Promise.reject(new Error('已取消'));
  const controller = new AbortController();
  const start = Date.now();
  const done = [];
  let calls = 0;
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = (error, result) => {
      if (ended) return; ended = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
      error ? reject(error) : resolve(JSON.stringify({ ...result, model_calls: calls, stages: done }));
    };
    const abort = () => finish(new Error('已取消'));
    const timer = setTimeout(() => finish(new Error(`Script Doctor 已達本次總時間上限（${spell(timeoutMs)}），整條流程沒有跑完。`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const progress = (index) => onProgress?.(`Script Doctor 第 ${index + 1}/${stages.length} 階段：${stages[index]}`);
    const ask = async (index, prompt) => {
      if (ended) throw new Error('已取消');
      // 剩下的時間見底時要直接說「整條流程的總時間用完」，而不是讓下一階段立刻逾時。
      const left = timeoutMs - (Date.now() - start);
      if (left < MIN_LEFT) throw new Error(`Script Doctor 的總時間（${spell(timeoutMs)}）在第 ${index + 1} 階段「${stages[index]}」前就用完了，整條流程沒有跑完。請縮短篇幅，或提高這次的時間上限（timeout_minutes）再試一次。`);
      progress(index);
      calls++;
      const t0 = Date.now();
      const result = await runner.ask(`${PREFIX}\n\n${prompt}`, { name: `Script Doctor：${stages[index]}`, signal: controller.signal, timeoutMs: left });
      if (ended) throw new Error('已取消');
      const text = String(result?.text || '').trim();
      if (!text) throw new Error(`Script Doctor 第 ${index + 1} 階段「${stages[index]}」模型沒有回傳文字`);
      done.push({ stage: index + 1, name: stages[index], model: true, ms: Date.now() - t0 });
      return text;
    };
    const local = (index) => { progress(index); done.push({ stage: index + 1, name: stages[index], model: false }); };
    Promise.resolve().then(() => body(ask, local)).then((result) => finish(null, result), finish);
  });
}

function doctorPrompt({ script, language, screenplay, report, context = '', goal = '' }) {
  const craft = screenplay ? 'structure, character, dialogue, pacing, scene_function, format' : 'structure, character, dialogue, pacing, scene_function, prose';
  return [
    '你是 Script Doctor。以下兩段是上游 ScriptDoctor-AI 的稽核指示，照它的精神做：先找出劇本中的事實、歷史、醫學、技術、法律/IP 斷言，再逐行產出帶嚴重度與改寫建議的 Coverage Audit。',
    upstream.EXTRACTOR_PROMPT('（見下方「劇本」）').trim(),
    upstream.SYNTHESIS_PROMPT('（見下方「劇本」）', '本工作台沒有即時網路查證；請依你自己的知識判斷，fact_check_verdict 開頭註明「未經即時查證」，citations 可留空陣列。').trim(),
    `另外補上寫作技藝診斷面向：${craft}；每一面向給出具體問題與可執行的修法。`,
    goal ? `使用者的修稿目標：${goal}` : '',
    context ? `創作脈絡（前面階段的產出）：\n${context}` : '',
    `確定性檢查結果（工作台程式計算，視為事實）：\n${lintText(report)}`,
    `只輸出一個 JSON 物件，欄位依上游 ScriptAuditReport：{"scene_summary":str,"total_issues_found":int,"overall_risk_score":str,"audit_issues":[{"line_number":int,"claim":str,"category":"HISTORICAL|MEDICAL|LEGAL_IP|TECHNICAL|CRAFT|FORMAT","severity":"HIGH|MEDIUM|LOW","fact_check_verdict":str,"citations":[str],"suggested_rewrite":str}],"craft_notes":{${craft.split(', ').map((k) => `"${k}":str`).join(',')}},"revision_plan":[str]}。文字值使用${language}。`,
    `劇本：\n${script}`,
  ].filter(Boolean).join('\n\n');
}

async function write(args, opts = {}) {
  const premise = String(args.premise || args.topic || '').trim();
  if (!premise) throw new Error('請提供題材或需求（premise）');
  const language = String(args.language || '繁體中文');
  const format = String(args.format || 'Fountain 劇本');
  const length = String(args.length || '短片，約 5 到 8 場');
  const screenplay = isScreenplay(format);
  const timeoutMs = opts.timeoutMs || minutes(args.timeout_minutes, 30);
  const spec = `題材／需求：${premise}\n篇幅：${length}\n格式：${format}\n語言：${language}${args.genre ? `\n類型與調性：${args.genre}` : ''}`;
  const fountainRules = '使用 Fountain 格式：場景標題以 INT. 或 EXT. 開頭（地點與時間可用' + language + '，例如「INT. 老公寓客廳 - 夜」）；角色名單獨一行，前一行空白，下一行接台詞；非拉丁字母的角色名前面一定要加「@」（例如「@阿明」）；括號提示單獨一行；轉場寫成大寫並以 TO: 結尾。';
  return budgeted(WRITE_STAGES, { ...opts, timeoutMs }, async (ask, local) => {
    const logline = await ask(0, `${spec}\n\n請產出：\n標題：一行\nLogline：一句話，包含主角、目標、阻礙與代價\n前提：三到五句，說清楚世界、主角的缺陷與故事要回答的問題\n主題：一句話\n用${language}。`);
    const title = (/^\s*(?:標題|title)\s*[:：]\s*(.+)$/im.exec(logline)?.[1] || premise.slice(0, 30)).trim();
    const beats = await ask(1, `${spec}\n\n前一階段：\n${logline}\n\n請產出：\n1. 主要角色表（名字、外在目標、內在需求、缺陷、弧線，每人三到四行）\n2. 結構大綱（beat sheet）：依篇幅選三幕或 Save the Cat 節拍，每個節拍一行，寫出發生什麼事、角色做了什麼選擇、局勢如何改變。\n用${language}。`);
    const scenes = await ask(2, `${spec}\n\n前提：\n${logline}\n\n角色與結構大綱：\n${beats}\n\n請把大綱拆成分場表，每場一行，格式：「編號. ${screenplay ? 'INT./EXT. 地點 - 時間' : '地點／時間'}｜這場的戲劇功能｜出場角色｜場尾局勢改變」。場數要符合篇幅。用${language}。`);
    const plannedScenes = countPlannedScenes(scenes);
    let draft = stripFence(await ask(3, `${spec}\n\n前提：\n${logline}\n\n角色與大綱：\n${beats}\n\n分場表：\n${scenes}\n\n請依分場表寫出完整${screenplay ? '劇本初稿' : '故事初稿'}。${screenplay ? fountainRules : '使用自然段落的小說體，對白用「」。'}只輸出${screenplay ? '劇本本文（可以用 Title: 開頭的標題頁）' : '故事本文'}，不要解說。`));
    const draftLint = lint(draft, { screenplay, plannedScenes });
    const raw = await ask(4, doctorPrompt({ script: draft, language, screenplay, report: draftLint, context: `${logline}\n\n${beats}\n\n${scenes}` }));
    const diagnosis = parseJson(raw);
    let final = stripFence(await ask(5, `${spec}\n\n以下是${screenplay ? '劇本' : '故事'}初稿與 Script Doctor 的診斷。請依診斷修稿：先處理 HIGH 與 FORMAT／確定性檢查問題，再處理技藝建議；保留有效的部分，不要改成大綱或摘要。${screenplay ? fountainRules : ''}只輸出修訂後的完整本文。\n\n診斷：\n${diagnosis ? JSON.stringify(diagnosis, null, 1) : raw}\n\n確定性檢查：\n${lintText(draftLint)}\n\n初稿：\n${draft}`));
    let finalLint = lint(final, { screenplay, plannedScenes });
    if (finalLint.ok) local(6);
    else {
      const polished = stripFence(await ask(6, `以下${screenplay ? '劇本' : '故事'}還有格式錯誤，只修正這些錯誤，不要改動情節與台詞內容。${screenplay ? fountainRules : ''}只輸出修正後的完整本文。\n\n錯誤：\n${lintText(finalLint)}\n\n本文：\n${final}`));
      const polishedLint = lint(polished, { screenplay, plannedScenes });
      if (polishedLint.issues.filter((i) => i.level === 'error').length <= finalLint.issues.filter((i) => i.level === 'error').length) { final = polished; finalLint = polishedLint; }
    }
    return {
      title, logline, beat_sheet: beats, scene_list: scenes, final,
      format: screenplay ? 'fountain' : 'prose', language,
      diagnosis: diagnosis || { raw },
      lint: { draft: draftLint, final: finalLint },
      note: '事實查核判斷來自目前對話模型本身的知識，沒有即時網路查證。',
      engine: 'Script Doctor 工作台 harness（診斷面向與關鍵字規則移植自 ScriptDoctor-AI）',
      upstream: upstream.UPSTREAM,
    };
  });
}

async function review(args, opts = {}) {
  const script = String(args.script || '').trim();
  if (!script) throw new Error('請貼上要診斷的劇本或故事（script）');
  const language = String(args.language || '繁體中文');
  // 沒指定格式時看稿子本身有沒有場景標題
  const screenplay = args.format ? isScreenplay(args.format) : /^\s*(?:(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s]|\.[^.\s])/im.test(script);
  const timeoutMs = opts.timeoutMs || minutes(args.timeout_minutes, 20);
  return budgeted(REVIEW_STAGES, { ...opts, timeoutMs }, async (ask, local) => {
    const report = lint(script, { screenplay });
    local(0);
    const raw = await ask(1, doctorPrompt({ script, language, screenplay, report, goal: String(args.goal || '') }));
    const diagnosis = parseJson(raw);
    const diag = diagnosis ? JSON.stringify(diagnosis, null, 1) : raw;
    const revision = stripFence(await ask(2, args.rewrite
      ? `依下列 Script Doctor 診斷修改這份${screenplay ? '劇本（維持 Fountain 格式，非拉丁字母角色名前加「@」）' : '故事'}，保留原作者的聲音與有效的部分，只輸出修訂後的完整本文。\n\n診斷：\n${diag}\n\n原稿：\n${script}`
      : `依下列 Script Doctor 診斷，寫出具體修稿建議，用${language}。依嚴重度排序，每條包含：位置（場次或行）、問題、為什麼重要、建議改寫（直接給可替換的文字）。最後列出三個最值得先做的修改。\n\n診斷：\n${diag}\n\n原稿：\n${script}`));
    return {
      format: screenplay ? 'fountain' : 'prose', language,
      lint: report, diagnosis: diagnosis || { raw },
      [args.rewrite ? 'revised' : 'suggestions']: revision,
      note: '事實查核判斷來自目前對話模型本身的知識，沒有即時網路查證。',
      engine: 'Script Doctor 工作台 harness（診斷面向與關鍵字規則移植自 ScriptDoctor-AI）',
      upstream: upstream.UPSTREAM,
    };
  });
}

function health() {
  const sample = lint('INT. 客廳 - 夜\n\n@阿明\n你回來了。\n\n@小美\n(低聲)\n嗯。\n');
  return { ok: sample.ok && sample.stats.scenes === 1 && sample.stats.dialogueLines === 2, upstream: upstream.UPSTREAM };
}

module.exports = { write, review, lint, health, WRITE_STAGES, REVIEW_STAGES, countPlannedScenes };
