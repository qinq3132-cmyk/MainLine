# Run from this installer directory after prepare.py.
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

source = Path(SPECPATH) / '.build' / '1.0' / 'source'
datas = [(str(source / 'public'), 'public')]
binaries = []
hiddenimports = ['clr_loader', 'pythonnet']
for package in ['pypdf', 'webview']:
    found_data, found_binaries, found_imports = collect_all(package)
    datas += found_data
    binaries += found_binaries
    hiddenimports += found_imports
a = Analysis([str(source / 'desktop.py')], pathex=[str(source)], binaries=binaries,
             datas=datas, hiddenimports=hiddenimports, hookspath=[], hooksconfig={},
             runtime_hooks=[], excludes=['tkinter', 'unittest', 'tests', 'PyQt5', 'PyQt6',
             'PySide2', 'PySide6', 'gi', 'gtk', 'Cocoa', 'AppKit'], noarchive=False, optimize=0)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='Mainline', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=False,
          disable_windowed_traceback=False, version=str(Path(SPECPATH) / 'version-info.txt'))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='Mainline')
