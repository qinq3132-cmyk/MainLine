"""Exercise the real setup against preinitialized synthetic data only.

Creates a uniquely named, future-dated test task and removes it in finally.
Does not create, modify or run the user's actual reminder task.
"""
from __future__ import annotations
import ctypes
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
import winreg

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    key = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\{0DF72060-3E71-4A97-86B4-33B4B8BE1080}_is1'
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key):
            raise RuntimeError('An installed edition already exists; refusing to replace its registration during testing.')
    except FileNotFoundError:
        pass
    folder = HERE / '.qa' / ('run-' + uuid.uuid4().hex[:10])
    folder.mkdir(parents=True)
    data = folder / 'synthetic-data'
    install = folder / 'installed'
    # Initialize before running either setup or the application: no legacy migration.
    sys.path.insert(0, str(HERE / '.build' / '1.0' / 'source'))
    import server
    import background_reminders as reminders
    store = server.Store(data)
    store.save_settings({'review_enabled': False})
    store.note({'title': 'Synthetic installation journal', 'content': 'An invented reflection.'})
    store.task({'title': 'Synthetic retained task', 'deadline': '2030-01-01'})
    store.put('messages', {'id': 'synthetic-message', 'role': 'user', 'content': 'An invented message.', 'created_at': server.stamp()})
    baseline = {table: store.all(table) for table in ['notes', 'tasks', 'messages', 'projects']}
    (data / 'llm-config.json').write_text(json.dumps({'use_opencode': False, 'models': []}), encoding='utf-8')
    config_bytes = (data / 'llm-config.json').read_bytes()
    (data / 'last-app-version.txt').write_text('2026-10-16-v12.1\n', encoding='utf-8')
    env = dict(os.environ, MAINLINE_DATA_DIR=str(data))
    setup = ROOT / 'downloads' / 'Mainline-Setup-1.0.exe'
    args = [str(setup), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=',
            '/DIR=' + str(install), '/LOG=' + str(folder / 'install.log')]
    actual_task = reminders.TASK_NAME
    before = reminders._run(['/Query', '/TN', actual_task, '/XML'])
    before_task = (before.returncode, before.stdout)
    process = None
    installed = False
    try:
        subprocess.run(args, env=env, check=True, timeout=90)
        installed = True
        exe = install / 'Mainline.exe'
        payload = HERE / '.build' / '1.0' / 'dist' / 'Mainline'
        files = [p for p in payload.rglob('*') if p.is_file()]
        for path in files:
            assert path.read_bytes() == (install / path.relative_to(payload)).read_bytes(), path.name
        extras = {p.relative_to(install).as_posix() for p in install.rglob('*') if p.is_file()} - {p.relative_to(payload).as_posix() for p in files}
        assert extras <= {'unins000.exe', 'unins000.dat'}, extras
        print(f'Installed payload verified: {len(files)} matching files.', flush=True)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        env['MAINLINE_PORT'] = str(port)
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        process = subprocess.Popen([str(exe)], env=env, startupinfo=startup)
        base = f'http://127.0.0.1:{port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def get(path):
            request = urllib.request.Request(base + path, headers={'X-Personal-Desk': '1'})
            with opener.open(request, timeout=3) as response:
                return response.read()
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('Installed application exited before becoming ready.')
            try:
                current = json.loads(get('/api/state'))
                break
            except (OSError, ValueError):
                time.sleep(0.2)
        else:
            raise RuntimeError('Installed application did not start.')
        assert current['notes'] == baseline['notes']
        assert 'Mainline 安装版 1.0'.encode() in get('/app.js')
        profile = json.loads(get('/api/serverchan-config'))
        assert profile['background_task_name'] == actual_task
        # Read-only settings and startup must not repair the actual user's task.
        after = reminders._run(['/Query', '/TN', actual_task, '/XML'])
        assert (after.returncode, after.stdout) == before_task
        # Close only this test process through its own window.
        def close_window(hwnd, _):
            pid = ctypes.c_ulong()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == process.pid:
                ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)
            return True
        callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(close_window)
        ctypes.windll.user32.EnumWindows(callback, 0)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
        process = None
        subprocess.run([str(exe), '--check-reminders'], env=env, check=True, timeout=30)
        assert (data / 'last-app-version.txt').read_text(encoding='utf-8').strip() == 'installed-1.0'
        print('Native launch, settings, read-only startup and isolated reminder check passed.', flush=True)
        # A future-dated task exercises real registration without allowing a
        # scheduler-launched process to access a real data directory.
        test_task = 'Mainline-Installer-Test-' + uuid.uuid4().hex[:10]
        reminders.TASK_NAME = test_task
        original_run = reminders._run
        future = (dt.date.today() + dt.timedelta(days=365)).strftime('%Y/%m/%d')
        def deferred(arguments):
            if arguments[0] == '/Create':
                arguments = [*arguments, '/SD', future, '/ST', '23:59']
            return original_run(arguments)
        try:
            with __import__('unittest.mock', fromlist=['patch']).patch.object(reminders, '_run', side_effect=deferred):
                assert reminders.configure(exe, True)
                assert reminders.status(exe)['background_state'] == 'active'
                time.sleep(3)
        finally:
            original_run(['/Delete', '/F', '/TN', test_task])
            reminders.TASK_NAME = actual_task
        print('Real limited-user task registration/query/cleanup passed using an isolated future-dated task.', flush=True)
        subprocess.run(args, env=env, check=True, timeout=90)
        assert (data / 'llm-config.json').read_bytes() == config_bytes
        assert {table: store.all(table) for table in baseline} == baseline
        with store.connect() as db:
            assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
        assert list((data / 'backups').glob('before-update-*.sqlite3'))
        print('Reinstallation preserved synthetic tasks, messages, notes, projects and configuration; backup passed.', flush=True)
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        if installed and (install / 'unins000.exe').exists():
            subprocess.run([str(install / 'unins000.exe'), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                            '/LOG=' + str(folder / 'uninstall.log')], env=env, check=True, timeout=90)
    assert (data / 'desk.sqlite3').is_file()
    assert {table: store.all(table) for table in baseline} == baseline
    after = reminders._run(['/Query', '/TN', actual_task, '/XML'])
    assert (after.returncode, after.stdout) == before_task
    print('Uninstall preserved all synthetic data and left the real reminder task unchanged.', flush=True)


if __name__ == '__main__':
    main()
