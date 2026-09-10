@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem NOTE: keep this file ASCII-only. cmd.exe parses .bat with the OEM code page,
rem and UTF-8 Chinese bytes can contain 0x29 / 0x26, which silently breaks the
rem "if ... ( ... ) else ( ... )" block structure.
rem
rem Launch the desktop app as a detached process, then exit right away so no
rem console window is left hanging around.

if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
    exit /b
)

rem Fallback: browser shell, also detached and hidden
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'src\web-shell.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b
