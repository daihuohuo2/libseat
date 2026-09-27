@echo off
chcp 65001 >nul
title 图书馆座位预约助手
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 未找到 node 命令
    echo   请先安装 Node.js，或确保 node 已加入系统 PATH
    echo.
    pause
    exit /b 1
)

echo.
echo   正在启动图书馆座位预约助手...
echo   浏览器将自动打开 http://127.0.0.1:8848
echo   关闭本窗口即可停止服务
echo.

start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8848"
node server.js

pause
