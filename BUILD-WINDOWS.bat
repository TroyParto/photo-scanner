@echo off
title Photo Scanner Builder
color 0A
echo.
echo  ============================================
echo   Photo Scanner - Windows Installer Builder
echo  ============================================
echo.

:: Check Node.js by running it directly
echo [1/4] Checking for Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js was not found.
    echo  Please install from https://nodejs.org and restart, then try again.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODEVER=%%i
echo  OK - Node.js %NODEVER% found.
echo.

:: Check npm
echo [2/4] Checking for npm...
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: npm not found. Try reinstalling Node.js.
    pause
    exit /b 1
)
echo  OK - npm found.
echo.

:: Install dependencies
echo [3/4] Installing build dependencies...
echo  Downloading Electron - this may take a few minutes, please wait...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: npm install failed.
    echo  Check your internet connection and try again.
    pause
    exit /b 1
)
echo.
echo  OK - Dependencies installed.
echo.

:: Build
echo [4/4] Building installer...
echo  This takes 1-3 minutes, please wait...
echo.
call npm run build-win
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Build failed.
    echo  Try right-clicking BUILD-WINDOWS.bat and selecting "Run as Administrator"
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   SUCCESS! Your installer is ready.
echo  ============================================
echo.
echo  Opening dist folder...
explorer "%~dp0dist"
pause
