@echo off
title LiteLLM 参数兼容代理
cd /d "%~dp0"
echo [INFO] LiteLLM 参数兼容代理 - 用于 VS Code Copilot 自定义 endpoint
echo [INFO] 请保持此窗口运行，启动后可切换回 VS Code 使用
echo.
node litellm-proxy.js
if errorlevel 1 (
    echo.
    echo [错误] 代理启动失败，请确认 Node.js 已安装
    pause
)
