"""Mainline 桌面客户端：把本机服务包进一个桌面窗口（pywebview）。

流程：确定用户数据目录 → 检查/占用端口 → 启动本机后台线程 → 等待就绪 →
打开窗口 → 关窗即安全退出服务。
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
if getattr(sys, 'frozen', False):
    exe_dir = Path(sys.executable).resolve().parent
    internal = exe_dir / '_internal'
    BASE = internal if (internal / 'public' / 'index.html').is_file() else Path(getattr(sys, '_MEIPASS', exe_dir))

import server as backend  # noqa: E402

APP_NAME = 'Mainline'
DEFAULT_PORT = 5179


def user_data_dir() -> Path:
    root = os.environ.get('LOCALAPPDATA') or str(Path.home() / 'AppData' / 'Local')
    return Path(root) / APP_NAME / 'data'


def free_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', preferred))
            return preferred
        except OSError:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]


def wait_ready(url: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url + '/api/health', headers={'Host': f'127.0.0.1:{url.rsplit(":", 1)[1]}'})
            with opener.open(req, timeout=1.5) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def start_backend(port: int, data_dir: Path) -> 'backend.DeskServer':
    store = backend.Store(str(data_dir))
    models = backend.Models(Path(data_dir) / 'llm-config.json')
    for job in store.all('jobs'):
        if job['status'] == 'running':
            store.put('jobs', {**job, 'status': 'error', 'error': '服务上次退出时请求中断，请重新请求。'})
    srv = backend.DeskServer(('127.0.0.1', port), store, models)
    metadata = {'pid': os.getpid(), 'instance': srv.instance, 'port': port, 'root': str(BASE)}
    (store.dir / 'service.json').write_text(json.dumps(metadata), encoding='utf-8')
    threading.Thread(target=srv.assistant.loop, daemon=True, name='reminders').start()
    threading.Thread(target=srv.serve_forever, daemon=True, name='http').start()
    return srv


def setup_error_log(data_dir: Path) -> None:
    # windowed EXE has no console; keep a plain log file for diagnosing startup failures.
    if getattr(sys, 'frozen', False) or not sys.stderr or not sys.stderr.isatty():
        try:
            log = open(data_dir / 'mainline.log', 'a', encoding='utf-8')
            sys.stdout = log
            sys.stderr = log
        except OSError:
            pass


def main() -> int:
    data_dir = Path(os.environ.get('MAINLINE_DATA_DIR') or user_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    setup_error_log(data_dir)
    port = free_port(int(os.environ.get('MAINLINE_PORT') or DEFAULT_PORT))
    url = f'http://127.0.0.1:{port}'

    def fail(message: str) -> None:
        print(message, file=sys.stderr)
        try:
            import webview
            webview.create_window('Mainline 启动失败', html=f'<h2>启动失败</h2><pre>{message}</pre><p>详情见数据目录 mainline.log</p>', width=520, height=300)
            webview.start()
        except Exception:
            pass

    try:
        srv = start_backend(port, data_dir)
    except Exception as exc:
        fail(f'服务启动失败: {exc}')
        return 1

    if not wait_ready(url):
        fail('服务未在预期时间内就绪。')
        return 1

    try:
        import webview
    except ImportError:
        # 无窗口环境时退回浏览器
        import webbrowser
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            srv.shutdown()
            srv.server_close()
            srv.assistant.pool.shutdown(wait=False, cancel_futures=True)
        return 0

    window = webview.create_window(APP_NAME, url, width=1280, height=860, min_size=(960, 640))

    def reload_when_ready():
        # WebView2 can finish creating the window before the HTTP service accepts
        # its first request; retry loading so the user never sees an error page.
        for _ in range(50):
            if window.events.loaded.is_set():
                return
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                req = urllib.request.Request(url + '/api/health', headers={'Host': f'127.0.0.1:{port}'})
                with opener.open(req, timeout=1.5) as response:
                    if response.status == 200:
                        window.load_url(url)
                        return
            except Exception:
                time.sleep(0.3)

    threading.Thread(target=reload_when_ready, daemon=True).start()
    webview.start()
    # 关闭窗口 → 安全停止后台
    srv.assistant.stop.set()
    srv.shutdown()
    srv.server_close()
    srv.assistant.pool.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
