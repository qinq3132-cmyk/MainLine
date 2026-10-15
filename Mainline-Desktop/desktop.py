"""Mainline 桌面客户端：把本机服务包进一个桌面窗口（pywebview）。

流程：确定用户数据目录 → 检查/占用端口 → 启动本机后台线程 → 等待就绪 →
打开窗口 → 关窗即安全退出服务。
"""
from __future__ import annotations

import json
from contextlib import closing
import os
import shutil
import socket
import sqlite3
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parent
if getattr(sys, 'frozen', False):
    exe_dir = Path(sys.executable).resolve().parent
    internal = exe_dir / '_internal'
    BASE = internal if (internal / 'public' / 'index.html').is_file() else Path(getattr(sys, '_MEIPASS', exe_dir))

import server as backend  # noqa: E402
import background_reminders  # noqa: E402

APP_NAME = 'Mainline'
APP_DATA_VERSION = '2026-10-15-v8'
DEFAULT_PORT = 5179


def user_data_dir() -> Path:
    root = os.environ.get('LOCALAPPDATA') or str(Path.home() / 'AppData' / 'Local')
    return Path(root) / APP_NAME / 'data'


def legacy_data_candidates():
    explicit = os.environ.get('MAINLINE_LEGACY_DATA_DIR')
    if explicit:
        yield Path(explicit)
    executable = Path(sys.executable).resolve() if getattr(sys, 'frozen', False) else Path(__file__).resolve()
    for parent in (executable.parent, *list(executable.parents)[:4], Path.cwd()):
        yield parent / 'personal-desk' / 'data'


def migrate_legacy_data(target: Path) -> bool:
    """First-run copy only; SQLite backup includes live WAL data and leaves the source intact."""
    if (target / 'desk.sqlite3').exists():
        return False
    source = next((p for p in legacy_data_candidates()
                   if (p / 'desk.sqlite3').is_file() and p.resolve() != target.resolve()), None)
    if source is None:
        return False
    target.mkdir(parents=True, exist_ok=True)
    temporary = target / '.desk-migration.sqlite3'
    try:
        with closing(sqlite3.connect(source / 'desk.sqlite3', timeout=20)) as old, closing(sqlite3.connect(temporary)) as new:
            old.backup(new)
            if new.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('旧数据完整性检查失败。')
        if (source / 'attachments').is_dir():
            shutil.copytree(source / 'attachments', target / 'attachments', dirs_exist_ok=True)
        os.replace(temporary, target / 'desk.sqlite3')
        return True
    finally:
        temporary.unlink(missing_ok=True)


def backup_before_update(data_dir: Path) -> bool:
    """Keep a database snapshot whenever this build first opens an existing store."""
    source = data_dir / 'desk.sqlite3'
    marker = data_dir / 'last-app-version.txt'
    if not source.is_file() or (marker.read_text(encoding='utf-8').strip() if marker.exists() else '') == APP_DATA_VERSION:
        return False
    folder = data_dir / 'backups'
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / ('before-update-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6] + '.sqlite3')
    try:
        with closing(sqlite3.connect(source, timeout=20)) as old, closing(sqlite3.connect(destination)) as backup:
            old.backup(backup)
            if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('升级前备份完整性检查失败。')
        marker.write_text(APP_DATA_VERSION + '\n', encoding='utf-8')
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return True


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


class DesktopBridge:
    def __init__(self):
        # pywebview walks every public attribute of js_api. Keep the native
        # Window private so it cannot recursively inspect the entire GUI.
        self._window = None

    def choose_folder(self):
        if self._window is None:
            return ''
        import webview
        selected = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        return str(selected[0]) if selected else ''


def main() -> int:
    data_dir = Path(os.environ.get('MAINLINE_DATA_DIR') or user_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    setup_error_log(data_dir)
    try:
        migrated = migrate_legacy_data(data_dir)
        if migrated:
            print('已将旧网页数据安全复制到桌面版数据目录；原数据保留。')
        backup_before_update(data_dir)
    except Exception:
        print('旧数据迁移未完成；原数据仍保留，请检查迁移日志。', file=sys.stderr)
        return 1
    if '--check-reminders' in sys.argv:
        try:
            store = backend.Store(str(data_dir))
            assistant = backend.Assistant(store, backend.Models(data_dir / 'llm-config.json'))
            assistant.tick(allow_ai=False)
            assistant.flush_push()
            assistant.pool.shutdown(wait=False, cancel_futures=True)
            return 0
        except Exception:
            print('后台提醒检查未完成；本机记录保留。', file=sys.stderr)
            return 1
    if getattr(sys, 'frozen', False) and background_reminders.enabled():
        try:
            background_reminders.configure(sys.executable, True)
        except ValueError:
            print('后台提醒计划未更新，请在设置中重新启用。', file=sys.stderr)
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

    bridge = DesktopBridge()
    window = webview.create_window(APP_NAME, url, width=1280, height=860, min_size=(960, 640), js_api=bridge)
    bridge._window = window
    webview.start()
    # 关闭窗口 → 安全停止后台
    srv.assistant.stop.set()
    srv.shutdown()
    srv.server_close()
    srv.assistant.pool.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
