RAGthoven MWAHAHA workbench adapter

Upstream framework: https://github.com/ragthoven-dev/ragthoven
Commit: a2b312e854b360e83329f7a1bbdaa4b95fa780d2
`mwahaha_tools.py` and `base_tools.py` are unchanged upstream tool sources.
The framework's MIT license is included in LICENSE.

Humor experiment and corpus: https://github.com/ragthoven-dev/semeval-2026-task-1
Commit: fda90590ab6cb6253e83985c7fd40e34ba6681a8
`joke_summaries.tsv` retains each record's source attribution.

Integration: ragthoven_worker.py loads the original stage classes with the
workbench model executor substituted for the LiteLLM executor dependency.
This is a bundled humor-toolchain adapter, not a full installation of the
RAGthoven CLI/Chroma/embedding stack. Retrieval uses local keyword matching
and mechanism diversity. Generation uses the conversation's selected model
and authentication route. The tool exposes constraint results without claiming
they measure funniness; topic and Chinese language quality need model judgment.
