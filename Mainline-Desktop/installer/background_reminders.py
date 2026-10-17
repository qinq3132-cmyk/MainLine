"""Installed edition: scheduled tasks change only after an explicit settings action."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

TASK_NAME = 'Mainline-Personal-Reminders'
NS = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}


def _run(arguments):
    system = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'schtasks.exe'
    return subprocess.run([str(system), *arguments], capture_output=True, timeout=20,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def _text(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')) or b'\x00' in raw[:80]:
        return raw.decode('utf-16')
    # schtasks may declare UTF-16 while actually redirecting OEM-codepage bytes.
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('oem')


def status(executable=None):
    result = {'background_enabled': False, 'background_exists': False,
              'background_state': 'off', 'background_target': '', 'background_owned': False,
              'background_task_name': TASK_NAME, 'background_interval_minutes': 5}
    if os.name != 'nt':
        result['background_state'] = 'unavailable'
        return result
    try:
        query = _run(['/Query', '/TN', TASK_NAME, '/XML'])
        if query.returncode:
            # Absence and permission failures both leave the real task untouched.
            return result
        root = ET.fromstring(_text(query.stdout))
        commands = root.findall('t:Actions/t:Exec', NS)
        if len(commands) != 1:
            result.update(background_exists=True, background_state='unavailable')
            return result
        command = commands[0].findtext('t:Command', '', NS).strip('"')
        arguments = commands[0].findtext('t:Arguments', '', NS).strip()
        target = Path(command)
        owned = target.name.lower().startswith('mainline') and target.suffix.lower() == '.exe' and arguments == '--check-reminders'
        active = root.findtext('t:Settings/t:Enabled', 'true', NS).lower() != 'false'
        matches = not executable or os.path.normcase(str(target.resolve())) == os.path.normcase(str(Path(executable).resolve()))
        result.update(background_exists=True, background_target=command, background_owned=owned,
                      background_enabled=bool(owned and active and matches),
                      background_state='active' if owned and active and matches else 'needs_repair' if owned else 'unavailable')
    except (OSError, subprocess.TimeoutExpired, ET.ParseError, UnicodeError):
        result['background_state'] = 'unavailable'
    return result


def enabled():
    return status()['background_enabled']


def remove_for_uninstall(executable):
    old = status(executable)
    if old['background_owned'] and old['background_target'] and os.path.normcase(str(Path(old['background_target']).resolve())) == os.path.normcase(str(Path(executable).resolve())):
        configure(executable, False)


def configure(executable, activate):
    path = Path(executable).resolve()
    old = status(path)
    if old['background_exists'] and not old['background_owned']:
        raise ValueError('同名 Windows 任务无法确认归属，未修改。请检查任务计划程序。')
    if activate:
        if path.name.lower() != 'mainline.exe' or not path.is_file() or not (path.parent / '_internal' / 'public' / 'index.html').is_file():
            raise ValueError('请从安装版 Mainline.exe 中开启后台提醒。')
        arguments = ['/Create', '/F', '/SC', 'MINUTE', '/MO', '5', '/TN', TASK_NAME,
                     '/TR', f'"{path}" --check-reminders', '/RL', 'LIMITED', '/IT']
    elif old['background_exists']:
        arguments = ['/Delete', '/F', '/TN', TASK_NAME]
    else:
        return False
    try:
        result = _run(arguments)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('Windows 后台提醒设置失败，未更改防护设置。') from None
    if result.returncode:
        raise ValueError('Windows 后台提醒设置失败，请检查任务计划程序权限。')
    current = status(path)
    if activate and not current['background_enabled']:
        raise ValueError('后台任务未通过状态核验，请在设置中重试。')
    return current['background_enabled']
