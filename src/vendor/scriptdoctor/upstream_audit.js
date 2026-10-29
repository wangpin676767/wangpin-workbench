// Ported from ScriptDoctor-AI (https://github.com/Masngo/ScriptDoctor-AI)
// Commit 54612070c4154210c9d64a9e9292b041fa2ce6f7, Apache License 2.0 (see LICENSE).
//
// Modifications (Apache-2.0 §4b): translated from Python to JavaScript; the
// deterministic keyword rule of `script_doctor.py::run_screenplay_audit` is kept
// verbatim in behaviour (same keywords, same scores, same messages), minus the
// simulated asyncio delay and HTML rendering. The prompt texts and report schema of
// `src/agents/script_doctor.py::ScriptDoctorEngine` are reproduced as strings so the
// workbench can send them through the conversation's own model instead of the
// hard-wired Gemini client; the Parallel Search web grounding step is not included.

const UPSTREAM = {
  repo: 'https://github.com/Masngo/ScriptDoctor-AI',
  commit: '54612070c4154210c9d64a9e9292b041fa2ce6f7',
  license: 'Apache-2.0',
};

/** script_doctor.py::run_screenplay_audit，確定性規則（未改動判斷邏輯）。 */
function runScreenplayAudit(scriptText) {
  const scriptLower = String(scriptText || '').toLowerCase();
  let hasRisk = false;
  let riskScore = 10;
  const violations = [];
  if (['iphone', 'digital', 'macbook', 'ipad'].some((w) => scriptLower.includes(w))) {
    hasRisk = true;
    riskScore = 88;
    violations.push('Modern electronic device or digital interface detected in historical/retro setting.');
  }
  if (scriptLower.includes('taxi cabs') && scriptLower.includes('1888')) {
    hasRisk = true;
    riskScore = 75;
    violations.push('Motorized taxi cabs referenced in 1888 Victorian London (pre-dates automobiles).');
  }
  if (!hasRisk) return { has_risk: false, risk_score: 0, violations: [] };
  return {
    has_risk: true,
    risk_score: riskScore,
    violations,
    suggested_fix: 'Replace modern technological references with period-appropriate props (e.g., rotary phone, telegram, or pocket watch).',
  };
}

/** src/agents/script_doctor.py 的兩段提示詞（萃取斷言 → 綜合稽核）。 */
const EXTRACTOR_PROMPT = (scriptText) => `
        Extract factual, historical, medical, technical, or legal IP assertions from this screenplay.
        Formulate target search objectives for Parallel Search.

        SCREENPLAY:
        ${scriptText}
        `;

const SYNTHESIS_PROMPT = (scriptText, evidence) => `
        Synthesize the original script text with live ground-truth evidence provided by Parallel MCP.

        ORIGINAL SCRIPT:
        ${scriptText}

        PARALLEL WEB EVIDENCE:
        ${evidence}

        Generate a line-by-line Script Coverage Audit with severity scores, citations, and screenwriter rewrites.
        `;

/** 上游 pydantic 模型 AuditIssue／ScriptAuditReport 的欄位。 */
const AUDIT_SCHEMA = {
  AuditIssue: { line_number: 'int', claim: 'str', severity: 'HIGH, MEDIUM, or LOW', fact_check_verdict: 'str', citations: 'List[str]', suggested_rewrite: 'str' },
  ScriptAuditReport: { scene_summary: 'str', total_issues_found: 'int', overall_risk_score: 'str', audit_issues: 'List[AuditIssue]' },
  FactAssertionCategory: 'HISTORICAL, MEDICAL, LEGAL_IP, or TECHNICAL',
};

module.exports = { UPSTREAM, runScreenplayAudit, EXTRACTOR_PROMPT, SYNTHESIS_PROMPT, AUDIT_SCHEMA };
