# Codex Multi 用的 SearXNG 啟動器（不改 SearXNG 原始碼）。
# 用法：python searxng_launcher.py <SearXNG 原始碼資料夾> <host> <port>
# 設定檔路徑由環境變數 SEARXNG_SETTINGS_PATH 指定。
import os
import sys
import types

# searx/valkeydb.py 開頭就 import pwd（Linux 專用模組），Windows 沒有它會整個載入失敗。
# 我們把 valkey 關掉了，實際不會呼叫到，只要讓 import 通過即可。
if os.name == 'nt' and 'pwd' not in sys.modules:
    try:
        import pwd  # noqa: F401
    except ImportError:
        shim = types.ModuleType('pwd')

        def getpwuid(uid):
            raise KeyError(uid)

        shim.getpwuid = getpwuid
        sys.modules['pwd'] = shim


def main():
    if len(sys.argv) < 4:
        print('usage: searxng_launcher.py <src> <host> <port>', file=sys.stderr)
        return 2
    src, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    sys.path.insert(0, src)
    os.chdir(src)
    from searx.webapp import app
    from werkzeug.serving import run_simple
    print(f'CODEX_MULTI_SEARXNG_READY http://{host}:{port}', flush=True)
    run_simple(host, port, app, threaded=True, use_reloader=False, use_debugger=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())
