"""Materialize the 1.0 installed edition without editing the portable edition."""
from __future__ import annotations

import hashlib
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VERSION = '1.0'
WORK = HERE / '.build' / VERSION
SOURCE = WORK / 'source'


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Portable source changed; review the installer overlay before building.')
    return text.replace(old, new, 1)


def prepare():
    if SOURCE.exists():
        if not SOURCE.resolve().is_relative_to(WORK.resolve()):
            raise RuntimeError('Unexpected staging path; refusing to clear it.')
        shutil.rmtree(SOURCE)
    SOURCE.mkdir(parents=True, exist_ok=True)
    # An explicit source list prevents data, backups and unrelated build artifacts
    # from entering the package. Public assets are checked separately before release.
    sources = ['desktop.py', 'server.py', 'note_store.py', 'documents.py', 'serverchan.py', 'llm_config.py']
    for name in sources:
        if not (ROOT / name).is_file():
            raise RuntimeError('Missing runtime source: ' + name)
        shutil.copy2(ROOT / name, SOURCE / name)
    shutil.copytree(ROOT / 'public', SOURCE / 'public', dirs_exist_ok=True)
    shutil.copy2(HERE / 'background_reminders.py', SOURCE / 'background_reminders.py')
    desktop = (SOURCE / 'desktop.py').read_text(encoding='utf-8')
    desktop = replace_once(desktop, "APP_DATA_VERSION = '2026-10-16-v12.1'", "APP_DATA_VERSION = 'installed-1.0'")
    desktop = replace_once(desktop, 'def main() -> int:\n', """def main() -> int:
    if '--uninstall-background-task' in sys.argv:
        # Uninstall touches only the task pointing at this installed executable.
        # This branch runs before any database access or legacy migration.
        background_reminders.remove_for_uninstall(sys.executable)
        return 0
""")
    start = desktop.index("    if getattr(sys, 'frozen', False) and background_reminders.enabled():")
    end = desktop.index('    port = free_port(', start)
    desktop = desktop[:start] + '    # Installed edition never registers or repairs tasks during startup.\n' + desktop[end:]
    (SOURCE / 'desktop.py').write_text(desktop, encoding='utf-8')
    server = (SOURCE / 'server.py').read_text(encoding='utf-8')
    server = replace_once(server, "'background_enabled': background_reminders.enabled()", "**background_reminders.status(sys.executable)")
    (SOURCE / 'server.py').write_text(server, encoding='utf-8')
    public = SOURCE / 'public'
    app = (public / 'app.js').read_text(encoding='utf-8')
    app = replace_once(app, "$('#background-reminders-button').textContent=profile.background_enabled?'关闭关窗后提醒':'开启关窗后提醒';", """$('#background-reminders-button').textContent=profile.background_enabled?'关闭关窗后提醒':profile.background_state==='needs_repair'?'修复关窗后提醒':'开启关窗后提醒';
    $('#background-disable').hidden=!profile.background_exists||profile.background_enabled;
    $('#background-details').textContent='Mainline 安装版 1.0 · '+(profile.background_state==='active'?'后台提醒正常':profile.background_state==='needs_repair'?'原后台任务需要修复；点击上方按钮后才会更新':profile.background_state==='unavailable'?'无法确认后台任务状态；未做任何修改':'关窗后提醒尚未开启')+'。任务：'+profile.background_task_name+'；每 '+profile.background_interval_minutes+' 分钟检查一次，仅在登录期间运行。'+(profile.background_target?' 当前程序位置：'+profile.background_target:'');""")
    app = replace_once(app, "  if(name==='toggle-background-reminders'){", """  if(name==='disable-background-reminders'){
    button.disabled=true;$('#serverchan-error').textContent='';
    try{await api('/api/background-reminders','POST',{enabled:false});await loadServerChanProfile();toast('关窗后提醒已关闭');}
    catch(error){$('#serverchan-error').textContent=error.message;}finally{button.disabled=false;}return;
  }
  if(name==='toggle-background-reminders'){""")
    (public / 'app.js').write_text(app, encoding='utf-8')
    html = (public / 'index.html').read_text(encoding='utf-8')
    html = replace_once(html, 'id="background-reminders-button">开启关窗后提醒</button>', 'id="background-reminders-button">开启关窗后提醒</button><button type="button" class="quiet-button" data-action="disable-background-reminders" id="background-disable" hidden>关闭原后台任务</button>')
    html = replace_once(html, '<p id="serverchan-status"', '<p id="background-details" class="help-text"></p><p id="serverchan-status"')
    (public / 'index.html').write_text(html, encoding='utf-8')
    # Pin an audit receipt to the precise portable inputs used by this build.
    receipt = [hashlib.sha256((ROOT / name).read_bytes()).hexdigest() + '  ' + name for name in sources]
    (WORK / 'portable-inputs.sha256').write_text('\n'.join(receipt) + '\n', encoding='utf-8')
    return SOURCE


if __name__ == '__main__':
    print(prepare())
