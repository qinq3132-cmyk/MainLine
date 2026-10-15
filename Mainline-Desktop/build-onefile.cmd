@echo off
rem Build Mainline desktop client (single-file EXE mode, slower startup)
setlocal
cd /d "%~dp0"

if not exist .venv-build\Scripts\python.exe (
    echo [1/3] Creating build venv .venv-build ...
    python -m venv .venv-build || goto :err
    .venv-build\Scripts\python.exe -m pip install --upgrade pip || goto :err
    .venv-build\Scripts\python.exe -m pip install pyinstaller pypdf pywebview || goto :err
) else (
    echo [1/3] Reusing build venv .venv-build
)

echo [2/3] Cleaning old build output ...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo [3/3] Running PyInstaller ...
.venv-build\Scripts\python.exe -m PyInstaller --noconfirm --clean ^
  --onefile --windowed --name Mainline ^
  --add-data "public;public" ^
  --collect-all pypdf ^
  --collect-all webview ^
  --hidden-import clr_loader ^
  --hidden-import pythonnet ^
  --exclude-module tkinter ^
  --exclude-module unittest ^
  --exclude-module tests ^
  --exclude-module PyQt5 ^
  --exclude-module PyQt6 ^
  --exclude-module PySide2 ^
  --exclude-module PySide6 ^
  --exclude-module gi ^
  --exclude-module gtk ^
  --exclude-module Cocoa ^
  --exclude-module AppKit ^
  desktop.py || goto :err

echo Done. Output: dist\Mainline.exe (single file)
echo Data is stored in %%LOCALAPPDATA%%\Mainline\data. Just double-click to run.
exit /b 0

:err
echo Build FAILED. Check the errors above.
exit /b 1
