'use strict';
const fs = require('fs');
const path = require('path');
const MARKER = '# Codex Multi worker startup diagnostics v1';
function ensure(root) {
  const file = path.join(root, 'src', 'zenith_harness', 'acp_runner.py');
  const original = fs.readFileSync(file, 'utf8');
  if (original.includes(MARKER)) return;
  let src = original.replace(/\r\n/g, '\n');
  const start = src.indexOf('    async def _start_worker_mcp_server(');
  const end = src.indexOf('    async def _poll_attempt_file(', start);
  if (start < 0 || end < 0) throw new Error('Zenith 版本與 worker 修補不相容，請更新工作台。');
  let block = src.slice(start, end);
  if (block.split('return await asyncio.create_subprocess_exec(').length !== 3 ||
      !block.includes('*, timeout: float = 15)')) throw new Error('Zenith worker 啟動程式已變更，未覆寫。');
  block = block.replaceAll('return await asyncio.create_subprocess_exec(', 'process = await asyncio.create_subprocess_exec(');
  block = block.replaceAll('            limit=SUBPROCESS_STREAM_LIMIT,\n        )', `            limit=SUBPROCESS_STREAM_LIMIT,
        )
        ${MARKER}
        process._codex_multi_stderr = ""
        async def drain(stream, record=False):
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    return
                if record:
                    process._codex_multi_stderr = (process._codex_multi_stderr + chunk.decode("utf-8", errors="replace"))[-4000:]
        process._codex_multi_drains = [asyncio.create_task(drain(process.stdout)), asyncio.create_task(drain(process.stderr, True))]
        return process`);
  block = block.replace('*, timeout: float = 15)', '*, timeout: float = 60, process=None)');
  block = block.replace('        while asyncio.get_event_loop().time() < deadline:\n', `        while asyncio.get_event_loop().time() < deadline:
            if process is not None and process.returncode is not None:
                await asyncio.gather(*getattr(process, "_codex_multi_drains", []))
                raise RuntimeError(f"Worker MCP exited ({process.returncode}): {getattr(process, '_codex_multi_stderr', '')}")
`);
  block = block.replace('raise TimeoutError(f"MCP server on {host}:{port} not ready within {timeout}s")', 'raise TimeoutError(f"MCP server on {host}:{port} not ready within {timeout}s: {getattr(process, \'_codex_multi_stderr\', \'\')}")');
  src = src.slice(0, start) + block + src.slice(end);
  const before = 'await self._wait_for_server_ready("127.0.0.1", mcp_port)\n        except TimeoutError:';
  if (!src.includes(before)) throw new Error('Zenith worker readiness 呼叫已變更，未覆寫。');
  src = src.replaceAll(before, 'await self._wait_for_server_ready("127.0.0.1", mcp_port, process=mcp_process)\n        except (TimeoutError, RuntimeError) as startup_error:');
  src = src.replace('task, summary="Worker MCP server failed to start"', 'task, summary=f"Worker MCP server failed to start: {startup_error}"');
  if (!fs.existsSync(file + '.codex-multi.orig')) fs.writeFileSync(file + '.codex-multi.orig', original);
  fs.writeFileSync(file, src, 'utf8');
}
module.exports = { ensure, MARKER };
