/**
 * 窗口助手回归测试：electron scripts/test-helper-enum.js
 *
 * 目的：
 *  1. 改了 winhelper.ps1 的 C# 之后必须确认它还能编译、还能跑（编译失败会让整个软件瘫掉）
 *  2. ENUM 返回的字段数量要够（多了 cloaked / fg 两列，主进程靠它们判定"窗口是不是被挂起/用户刚打开"）
 *  3. 真的能枚举到一个真实的窗口，并且坐标/可见/前台标记是对的
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const rl = require('readline');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (detail || '')));
  cond ? pass++ : fail++;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length === 8) return Number(buf.readBigInt64LE(0));
  return buf.readInt32LE(0);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'winhelper.ps1')
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  const queue = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  let replies = 0;
  const send = (cmd, timeout = 20000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), timeout);
    queue.push({ cmd, resolve: (v) => { clearTimeout(timer); resolve(v); } });
    try { child.stdin.write(cmd + '\n'); } catch (e) { /* 进程已退出 */ }
  });

  // 逐行解析 "@@..." 响应
  let sawReady = false;
  const pump = setInterval(() => {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.includes('"ready":true')) sawReady = true;
      if (line.startsWith('@@')) {
        replies++;
        const job = queue.shift();
        if (job) job.resolve(line.slice(2));
      }
    }
  }, 30);

  // 等 ready
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && !sawReady) {
    await wait(150);
  }
  const compileOk = sawReady;
  ok('助手脚本能编译并启动', compileOk, 'stderr=' + stderr.slice(0, 300));
  if (!compileOk) { finish(); return; }

  // 开一个真实窗口，标题可识别
  const title = 'FDE-TEST-WIN-' + Date.now().toString(36);
  const win = new BrowserWindow({
    width: 520, height: 340, x: 260, y: 160, title,
    show: true, skipTaskbar: false,
    webPreferences: { nodeIntegration: false }
  });
  win.setTitle(title);
  await win.loadURL('data:text/html,<title>' + title + '</title><h1>test</h1>');
  await wait(900);
  win.focus();
  await win.show();
  await wait(600);

  const hwnd = hwndOf(win);
  // 不排除自己，才能看到这个窗口
  const tEnv = Date.now();
  const raw = await send('ENUM|');
  console.log('  · ENUM 用时 ' + (Date.now() - tEnv) + 'ms, 收到的回复数 ' + replies);
  let rows = [];
  try { rows = JSON.parse(raw); } catch (e) { rows = []; }
  rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const mine = rows.find(r => Number(r.hwnd) === hwnd);

  ok('ENUM 能返回窗口列表', rows.length > 0, 'raw(len=' + String(raw).length + ')=' + String(raw).slice(0, 160));
  ok('能找到自己开的那扇窗', !!mine, 'hwnd=' + hwnd + ' 列表=' + rows.length);
  if (mine) {
    ok('新字段 cloaked 存在', 'cloaked' in mine, JSON.stringify(Object.keys(mine)));
    ok('新字段 fg 存在', 'fg' in mine, JSON.stringify(Object.keys(mine)));
    ok('可见窗口 vis=true 且未挂起', mine.vis === true && mine.cloaked === false, JSON.stringify(mine));
    ok('标题正确', String(mine.title).includes('FDE-TEST-WIN'), String(mine.title));
    ok('坐标可用（非 0 兜底）', Number(mine.x) !== 0 || Number(mine.y) !== 0, mine.x + ',' + mine.y);
  }

  // 隐藏后：可见=0，但仍然能被枚举到（known 机制）；用 MOVE 搬到屏幕外则坐标成立
  await send('HIDE|' + hwnd);
  await wait(400);
  let raw2 = await send('ENUM||' + hwnd);
  let rows2 = [];
  try { rows2 = JSON.parse(raw2); } catch (e) {}
  rows2 = Array.isArray(rows2) ? rows2 : (rows2 ? [rows2] : []);
  const hiddenRow = rows2.find(r => Number(r.hwnd) === hwnd);
  ok('隐藏的窗口仍能被枚举到（known 句柄）', !!hiddenRow && hiddenRow.vis === false,
    JSON.stringify(hiddenRow || null));

  await send('MOVE|' + hwnd + '|-30000|-30000');
  await wait(400);
  let raw3 = await send('ENUM||' + hwnd);
  let rows3 = [];
  try { rows3 = JSON.parse(raw3); } catch (e) {}
  rows3 = Array.isArray(rows3) ? rows3 : (rows3 ? [rows3] : []);
  const parked = rows3.find(r => Number(r.hwnd) === hwnd);
  ok('搬到屏幕外后坐标可读（验证"救回屏幕外窗口"的前提）',
    !!parked && Number(parked.x) <= -10000, JSON.stringify(parked ? { x: parked.x, y: parked.y } : null));

  await send('SHOW|' + hwnd);
  await wait(300);
  await send('MOVE|' + hwnd + '|260|160');
  await wait(300);

  finish();
  function finish() {
    clearInterval(pump);
    try { child.stdin.write('QUIT\n'); } catch (e) {}
    setTimeout(() => { try { child.kill(); } catch (e) {} }, 300);
    console.log('\n' + (fail ? '✗ 失败 ' + fail + ' 项' : '✓ 全部通过') + '（通过 ' + pass + ' 项）');
    setTimeout(() => app.exit(fail ? 1 : 0), 400);
  }
});
