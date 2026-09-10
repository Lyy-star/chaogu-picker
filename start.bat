@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
    echo 正在启动「lyy创意选股」桌面应用...
    start "" "node_modules\electron\dist\electron.exe" .
) else (
    echo 未检测到 Electron 运行时，改用浏览器外壳启动（功能相同）...
    node src\web-shell.js
)
