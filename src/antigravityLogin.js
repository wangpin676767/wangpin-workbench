'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Keep OAuth entirely inside the official CLI and the user's normal browser.
// Never capture terminal output or the authorization code in App logs.
function script(executable, { switchAccount = false } = {}) {
  if (!executable || /["\r\n]/.test(executable)) throw new Error('Antigravity CLI 路徑無效');
  const quoted = String(executable).replace(/%/g, '%%');
  const helper = path.join(__dirname, 'antigravitySwitch.ps1');
  if (/["\r\n]/.test(helper)) throw new Error('Antigravity 切換程式路徑無效');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (/["\r\n]/.test(powershell)) throw new Error('PowerShell 路徑無效');
  const command = switchAccount
    ? `"${powershell.replace(/%/g, '%%')}" -NoProfile -ExecutionPolicy Bypass -File "${helper.replace(/%/g, '%%')}" -Executable "${quoted}"`
    : `"${quoted}"`;
  return [
    '@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul',
    'title Antigravity CLI sign-in',
    'echo Official Antigravity CLI sign-in / switch account',
    switchAccount ? 'echo Automatic mode: pick the Google account in your browser; the authorization code is entered here for you.' : 'echo Complete sign-in in your normal Brave browser, then paste the authorization code HERE.',
    'echo This code is NOT an API key. Do not paste it into a chat or share it.',
    'echo If Brave does not open, copy the complete sign-in URL from the CLI into Brave.',
    switchAccount ? 'echo Account switch: logout, sign-in and code entry are automatic. Just choose the Google account.' : 'echo Complete sign-in, then return to the App.',
    'echo Press Ctrl+C to cancel. This terminal stays open if the CLI exits or fails.',
    'echo.', command,
    'set "AGY_LOGIN_EXIT=%errorlevel%"', 'echo.',
    'echo Antigravity CLI exited with code: %AGY_LOGIN_EXIT%',
    'echo Keep any error above for troubleshooting. Type exit to close this window.', ''
  ].join('\r\n');
}

async function open({ executable, directory, spawnProcess = spawn, platform = process.platform, switchAccount = false, onExit = () => {} }) {
  if (platform !== 'win32') throw new Error('此登入終端機啟動方式目前只支援 Windows；請在終端機執行 agy 登入。');
  const file = path.join(directory, switchAccount ? 'antigravity-switch-account.cmd' : 'antigravity-login.cmd');
  if (/["%\r\n]/.test(file)) throw new Error('登入終端機路徑包含不支援的字元');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(file, script(executable, { switchAccount }), 'utf8');
  // /k keeps the console open even when the CLI crashes. Do not rely on the
  // user's .cmd file association (which may run in a temporary closing host).
  await new Promise((resolve, reject) => {
    const child = spawnProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/d', '/s', '/k', `""${file}""`],
      { cwd: directory, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
    child.once('error', reject);
    child.once('close', onExit);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true };
}

module.exports = { script, open };
