@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=..\.venv-build\Scripts\python.exe"
set "ISCC=.tools\inno\ISCC.exe"
if not exist "%ISCC%" (
  echo Install the verified Inno Setup compiler into installer\.tools\inno first.
  exit /b 1
)
"%PYTHON%" prepare.py || exit /b 1
"%PYTHON%" -m PyInstaller --noconfirm --workpath .build\1.0\pyinstaller --distpath .build\1.0\dist Mainline-Installed.spec || exit /b 1
"%ISCC%" Mainline-Setup.iss || exit /b 1
echo Built: ..\downloads\Mainline-Setup-1.0.exe
