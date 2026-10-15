@echo off
rem Build Mainline desktop client (one-folder mode, recommended for distribution)
setlocal
cd /d "%~dp0"

if not exist .venv-build\Scripts\python.exe (
    echo [1/4] Creating build venv .venv-build ...
    python -m venv .venv-build || goto :err
    .venv-build\Scripts\python.exe -m pip install --upgrade pip || goto :err
    .venv-build\Scripts\python.exe -m pip install pyinstaller pypdf pywebview || goto :err
) else (
    echo [1/4] Reusing build venv .venv-build
)

echo [2/4] Cleaning old build output ...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo [3/4] Running PyInstaller ...
.venv-build\Scripts\python.exe -m PyInstaller --noconfirm --clean ^
  --onedir --windowed --name Mainline ^
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

echo [4/4] Done. Output: dist\Mainline\Mainline.exe
echo Distribute the WHOLE dist\Mainline folder. Recipients just double-click Mainline.exe.
exit /b 0

:err
echo Build FAILED. Check the errors above.
exit /b 1
