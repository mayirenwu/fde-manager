/**
 * 「打开网页 → 新窗口归到当前桌面」链路测试：electron scripts/test-url-intent.js
 *
 * 验证真机上最关键的前提（不会打开任何网页、不碰你的默认浏览器）：
 *  1. 助手新增的 FG 命令能拿到前台窗口句柄（浏览器"就地开标签页"时靠它认窗口）
 *  2. 我们自己起一个进程开窗口，ENUM 能读到它的 exe / 标题（认领的原料）
 *  3. urlopen.matchIntent 能用"打开意图"认领这个窗口 —— 不认领就会被当成别的桌面的窗口藏起来
 *  4. 藏起来之后仍能被枚举到并搬回来（rescue 的前提）
 *  5. 真机默认浏览器能被解析出来，并且 launchPlan 会带 --new-window
 *
 * 用 electron 自己当"假浏览器"：起第二个进程开一个窗口，标题里带站点名。
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const urlopen = require('../urlopen');

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
  const tmp = path.join(os.tmpdir(), 'fde-fake-browser');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}
  const exe = process.execPath;
  const host = 'jd.com';
  const pageTitle = '京东(JD.COM) 假浏览器窗口 ' + Date.now().toString(36);
  const script = path.join(tmp, 'fake-win.js');
  fs.writeFileSync(script, `
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 520, height: 360, show: true, title: ${JSON.stringify(pageTitle)} });
  w.loadURL('data:text/html,<title>${pageTitle}</title><h1>fake</h1>');
  w.setTitle(${JSON.stringify(pageTitle)});
});
`);

  let child = null, helper = null;

  // ---- 起窗口助手 ----
  helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'winhelper.ps1')
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  const queue = [];
  let buf = '', stderr = '', sawReady = false;
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (d) => { buf += d; });
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (d) => { stderr += d; });
  const send = (cmd, timeout = 15000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), timeout);
    queue.push({ resolve: (v) => { clearTimeout(timer); resolve(v); } });
    try { helper.stdin.write(cmd + '\n'); } catch (e) {}
  });
  const pump = setInterval(() => {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.includes('"ready":true')) sawReady = true;
      if (line.startsWith('@@')) {
        const job = queue.shift();
        if (job) job.resolve(line.slice(2));
      }
    }
  }, 30);
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && !sawReady) await wait(150);
  ok('窗口助手可用', sawReady, stderr.slice(0, 200));
  if (!sawReady) return finish();

  const enumRows = async (known = '') => {
    const raw = await send('ENUM||' + known);
    let rows = [];
    try { rows = JSON.parse(raw); } catch (e) {}
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
  };

  // ---- 1) FG 命令 ----
  const selfTitle = 'FDE-FG-' + Date.now().toString(36);
  const win = new BrowserWindow({ width: 420, height: 300, show: true, title: selfTitle });
  await win.loadURL('data:text/html,<title>' + selfTitle + '</title><b>fg</b>');
  await wait(700);
  win.setAlwaysOnTop(true);
  win.focus();
  await wait(800);
  const fgHwnd = Number(String((await send('FG')) || '').trim()) || 0;
  ok('FG 返回前台窗口句柄', fgHwnd > 0, 'fg=' + fgHwnd + ' self=' + hwndOf(win));
  win.setAlwaysOnTop(false);
  win.hide();
  await wait(300);

  // ---- 2) "浏览器"起窗口，ENUM 能不能读到 ----
  const before = new Set((await enumRows()).map(r => Number(r.hwnd)));
  child = spawn(exe, [script], { detached: true, stdio: 'ignore' });
  child.unref();

  let hitRow = null;
  for (let i = 0; i < 40 && !hitRow; i++) {
    await wait(250);
    const rows = await enumRows();
    hitRow = rows.find(r => !before.has(Number(r.hwnd)) &&
      String(r.title || '').includes('京东(JD.COM) 假浏览器窗口')) || null;
  }
  ok('新开的窗口能在 ENUM 里看到', !!hitRow, 'before=' + before.size);
  if (hitRow) {
    ok('读得到 exe（认领的判据之一）',
      String(hitRow.exe).toLowerCase() === exe.toLowerCase(), String(hitRow.exe));
    ok('读得到窗口标题', String(hitRow.title || '').includes('京东'), JSON.stringify(hitRow.title));

    // ---- 3) 意图认领 ----
    const it = { owner: 'p1', url: 'https://www.jd.com', host, exe, at: Date.now(), used: false };
    const claimed = urlopen.matchIntent([it], {
      exe: String(hitRow.exe), title: String(hitRow.title || '')
    }, Date.now());
    ok('刚打开的窗口能被"打开意图"认领（不会被当成别的桌面的窗口藏起来）', !!claimed,
      JSON.stringify({ host, title: hitRow.title }));
    if (claimed) claimed.used = true;   // 主进程 claimByIntent 就是这一步（matchIntent 本身不改状态）
    ok('认领后意图标记为已用，不会重复认领',
      !!claimed && claimed.used === true &&
      urlopen.matchIntent([it], { exe, title: hitRow.title }, Date.now()) === null);

    const later = urlopen.matchIntent([{ ...it, used: false, at: Date.now() - 15000 }],
      { exe, title: '' }, Date.now());
    ok('过期意图不再乱认领', later === null, JSON.stringify(later));

    // ---- 4) 藏起来后仍能枚举（rescue 的前提）----
    await send('HIDE|' + hitRow.hwnd);
    await wait(400);
    const known = await enumRows(String(hitRow.hwnd));
    const hidden = known.find(r => Number(r.hwnd) === Number(hitRow.hwnd));
    ok('藏起来后仍能被枚举到（救回"就地开标签页"窗口的前提）',
      !!hidden && hidden.vis === false, JSON.stringify(hidden || null));
    // 救回逻辑只认浏览器 exe；electron 不是浏览器，用等价的列表验证选择逻辑
    const fakeList = [{
      hwnd: Number(hitRow.hwnd), exe: 'C:\\x\\360se.exe', title: '京东',
      vis: false, iconic: false, fg: false
    }];
    ok('救回逻辑能选中被藏起来的那个窗口',
      (urlopen.pickRescueWindow(fakeList, { host }, { fgHits: [Number(hitRow.hwnd)] }) || {}).hwnd === Number(hitRow.hwnd));
  }

  // ---- 5) 真机默认浏览器 + 启动参数 ----
  const def = await urlopen.resolveDefaultBrowser({ browsers: async () => [] });
  ok('能解析出默认浏览器', !!def, '解析结果=' + JSON.stringify(def));
  if (def) {
    const plan = urlopen.launchPlan(def, 'https://www.jd.com');
    console.log('  · 默认浏览器: ' + def + ' → 参数 ' + JSON.stringify(plan && plan.args));
    ok('默认浏览器的启动参数带"新开窗口"', !!plan && plan.args.length === 2 &&
      /^-{1,2}new-window$/.test(plan.args[0]), JSON.stringify(plan && plan.args));
  }

  finish();

  function finish() {
    clearInterval(pump);
    try { if (child && child.pid) process.kill(child.pid); } catch (e) {}
    try { if (helper) helper.stdin.write('QUIT\n'); } catch (e) {}
    setTimeout(() => { try { if (helper) helper.kill(); } catch (e) {} }, 300);
    console.log('\n' + (fail ? '✗ 失败 ' + fail + ' 项' : '✓ 全部通过') + '（通过 ' + pass + ' 项）');
    setTimeout(() => app.exit(fail ? 1 : 0), 400);
  }
});
