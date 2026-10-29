Script Doctor workbench adapter

Upstream: ScriptDoctor-AI — https://github.com/Masngo/ScriptDoctor-AI
Commit: 54612070c4154210c9d64a9e9292b041fa2ce6f7
License: Apache License 2.0 (copy in LICENSE)

`upstream_audit.js` is a JavaScript port of two upstream pieces, marked as modified:
- `script_doctor.py::run_screenplay_audit` — the deterministic anachronism keyword
  rule (same keywords, scores and messages).
- `src/agents/script_doctor.py::ScriptDoctorEngine` — the assertion-extraction and
  coverage-audit prompts plus the AuditIssue / ScriptAuditReport report schema
  (categories HISTORICAL / MEDICAL / LEGAL_IP / TECHNICAL, severity HIGH / MEDIUM / LOW,
  verdict, citations, suggested rewrite).

Not included: the Gemini client (`google-genai`), Google Cloud Agent Builder, the
Parallel Search MCP web grounding, the Streamlit UI and video previews. Every model
call goes through the workbench's conversation runner, i.e. the model and login route
the user selected for the current conversation. Because there is no live web search,
the fact-check verdicts rely on the model's own knowledge and are labelled as such.

Workbench-original parts (not from upstream): the multi-stage writing harness in
`src/scriptDoctor.js` (logline → beat sheet → scene list → Fountain draft → doctor
→ revision → final check) and the deterministic Fountain format checks. Fountain
syntax follows the public spec at https://fountain.io/syntax.

Other candidates reviewed and not used:
- STORYMACHINE (sergey9519546/STORYMACHINE): 14-pass deterministic Script Doctor,
  but its LICENSE grants no rights ("All rights reserved"), so nothing can be copied.
- screenplay_studio (avinashbgmi007-dot/screenplay_studio): 263-rule craft KB, but
  explicitly proprietary / not licensed for use.
