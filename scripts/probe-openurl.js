/**
 * 真机探针：用系统壳（shell.openExternal）打开官网，看看浏览器窗口到底起没起来、是不是可见。
 * 只验证"打开"这一步（FDE 的桌面归属逻辑不参与），跑法：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/probe-openurl.js
 */
const { app, shell } = require('electron');
const { execFile } = require('child_process');

const URL = 'https://ai.my10086.cn/api/console/keys';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function ps(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 },
      (err, out) => resolve(String(out || '').trim() || (err ? String(err.message) : '')));
  });
}

app.whenReady().then(async () => {
  console.log('用系统壳打开：' + URL);
  const t0 = Date.now();
  try {
    await shell.openExternal(URL);
  } catch (e) {
    console.log('FAIL openExternal 报错：' + e.message);
    return app.exit(1);
  }
  await wait(4200);

  const out = await ps(
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | " +
    "Select-Object -First 25 | ForEach-Object { $_.ProcessName + ' | ' + $_.MainWindowTitle }"
  );
  const lines = out.split(/\r?\n/).filter(Boolean);
  const browser = lines.filter(l => /chrome|msedge|360se|firefox|qqbrowser|browser/i.test(l));
  console.log('\n-- 打开后可见窗口里像浏览器的 --');
  browser.forEach(l => console.log('  ' + l));
  if (!browser.length) {
    console.log('（没看到浏览器窗口，全部窗口：）');
    lines.forEach(l => console.log('  ' + l));
  }
  console.log('\n耗时 ' + Math.round((Date.now() - t0) / 100) / 10 + 's');
  console.log(browser.length ? 'PROBE OK 浏览器窗口在' : 'PROBE FAIL 没看到浏览器窗口');
  app.exit(browser.length ? 0 : 1);
});
