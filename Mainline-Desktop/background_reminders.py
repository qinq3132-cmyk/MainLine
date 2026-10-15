"""Optional Windows scheduled checker, activated only by a user action in settings."""
import os
from pathlib import Path
import subprocess


TASK_NAME = 'Mainline-Personal-Reminders'


def _run(arguments):
    if os.name != 'nt':
        return False
    try:
        result = subprocess.run(['schtasks.exe', *arguments], capture_output=True, timeout=20,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def enabled():
    return _run(['/Query', '/TN', TASK_NAME])


def configure(executable, activate):
    if activate:
        path = Path(executable).resolve()
        if not path.is_file() or path.suffix.lower() != '.exe':
            raise ValueError('后台提醒需要从 Windows EXE 客户端启用。')
        command = f'"{path}" --check-reminders'
        ok = _run(['/Create', '/F', '/SC', 'MINUTE', '/MO', '5', '/TN', TASK_NAME,
                   '/TR', command, '/RL', 'LIMITED'])
    else:
        ok = _run(['/Delete', '/F', '/TN', TASK_NAME]) if enabled() else True
    if not ok:
        raise ValueError('Windows 后台提醒设置失败，请检查任务计划程序权限。')
    return enabled()
