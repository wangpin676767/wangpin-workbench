# Chat hot-path accelerator

The Electron interface and CLI integrations remain JavaScript. The optional Windows x64 Rust Node-API module handles cached UTF-16 substring scans and background JSONL/Zstandard transcript filtering. Unicode normalization, snippets, message deduplication, attachments and tool presentation remain in the existing JavaScript implementation.

Build with an MSVC x64 Rust toolchain and Visual Studio C++ Build Tools:

```powershell
python build/build_native.py
python build/build_offline.py
```

`--toolchain-dir PATH` optionally selects an isolated directory containing `cargo` and `rustup` homes. The generated `.node`, source fingerprints and third-party notices live in `src/native`. Packaging checks that the binary matches the recorded Rust source inputs. Users do not need Rust installed.

Search indexes retain complete message indices, validate text/role changes and use an LRU capped at 128 histories and a conservative 32 MiB retained-data estimate. Small histories use cached JavaScript. Native matching operates on little-endian UTF-16 code units, including lone surrogates, and checks even-byte alignment.

Native transcript filtering runs on libuv workers. The existing parser handles retained messages in yielding batches. Unsupported JSON, native read errors and oversized records fall back to the original streaming reader, preserving strict physical-line diagnostics. No conversation files are modified. `CODEX_MULTI_NATIVE_DISABLED=1` disables native execution for diagnostics.

Focused verification:

```powershell
node --test tests/native-accelerator.test.js tests/chat-search.test.js tests/distill-export.test.js tests/recent-messages.test.js
node native/benchmark.cjs PATH_TO_EVIDENCE
```

`native/baseline` freezes the 1.9.86 reference for differential tests. Benchmarks use fixed synthetic conversations, compare full search results and report cold setup, warm queries and equivalent cached JavaScript separately. Results concern these hot paths, not model/network response time or overall application speed. No stress tests are required.
