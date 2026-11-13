/** 探针：直接 spawn 默认浏览器带 URL / --new-window，看窗口到底起不起来 */
const { app } = require('electron');
const { spawn, execFile } = require('child_process');

const URL = 'https://ai.my10086.cn/api/console/keys';
// 真机排障用的探针：--exe= 传你要试的浏览器路径，不给就从环境变量取
const EXE_360 = process.env.FDE_PROBE_BROWSER || '';
const exeArg = (process.argv.find(a => a.startsWith('--exe=')) || '').slice(6);
const EXE = exeArg || EXE_360;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const shellCmd = (script) => new Promise(res => execFile('powershell.exe', ['-NoProfile', '-Command', script],
  { windowsHide: true, timeout: 15000 }, (e, o) => res(String(o || '').trim())));

const listWin = () => shellCmd("$ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 30 | ForEach-Object { $_.ProcessName + ' | ' + $_.MainWindowTitle }");
const only360 = () => shellCmd("$ErrorActionPreference='SilentlyContinue'; Get-Process 360se | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id + ' | ' + $_.MainWindowTitle }");

app.whenReady().then(async () => {
  const args = process.argv.slice(2).includes('--newwin') ? ['--new-window', URL] : [URL];
  console.log('spawn: ' + EXE + ' ' + JSON.stringify(args));
  const child = spawn(EXE, args, { detached: true, stdio: 'ignore' });
  child.on('error', e => console.log('spawn error: ' + e.message));
  child.on('exit', (c, s) => console.log('child exit code=' + c + ' signal=' + s));
  await wait(5000);

  console.log('-- 有标题的可见窗口 --');
  console.log((await listWin()).split(/\r?\n/).filter(Boolean).map(l => '  ' + l).join('\n') || '  （无）');
  console.log('-- 360se 里有主窗口的进程 --');
  console.log((await only360()).split(/\r?\n/).filter(Boolean).map(l => '  ' + l).join('\n') || '  （无）');
  app.exit(0);
});
