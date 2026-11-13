/**
 * platform.js 纯函数单测（不依赖 electron，node 直接跑）
 * 跑法：node test-platform.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const platform = require('./platform');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' | ' + e.message); }
}
function eq(name, a, b) {
  t(name + '（' + JSON.stringify(a) + '）', () => assert.deepStrictEqual(a, b));
}

/* ---------- 能力矩阵 ---------- */
t('三个平台都有能力矩阵', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const c = platform.caps(p);
    assert.ok(c.id === p && c.label && c.windowMgmt && c.scriptExt, p + ' 能力不全');
  }
});
eq('Windows：窗口级隔离 + AppBar + 壁纸', {
  windowMgmt: 'full', appBar: true, wallpaper: true
}, {
  windowMgmt: platform.caps('win32').windowMgmt,
  appBar: platform.caps('win32').appBar,
  wallpaper: platform.caps('win32').wallpaper
});
eq('macOS：应用级隔离、无 AppBar', { windowMgmt: 'app', appBar: false }, {
  windowMgmt: platform.caps('darwin').windowMgmt, appBar: platform.caps('darwin').appBar
});
eq('Linux：窗口级隔离（依赖 xdotool）', 'window', platform.caps('linux').windowMgmt);
t('未知平台退到 Linux 形状但不报错', () => {
  const c = platform.caps('freebsd');
  assert.strictEqual(c.scriptExt, '.sh');
});

/* ---------- 脚本执行计划 ---------- */
t('.ps1 在 Windows 走 PowerShell，其它平台走 pwsh', () => {
  assert.strictEqual(platform.scriptPlan('a.ps1', 'win32').cmd, 'powershell.exe');
  assert.strictEqual(platform.scriptPlan('a.ps1', 'darwin').cmd, 'pwsh');
});
t('.sh 在 Windows 上不执行（返回 null 提示不支持）', () => {
  assert.strictEqual(platform.scriptPlan('a.sh', 'win32'), null);
});
eq('.sh 在 macOS/Linux 走 /bin/sh', platform.scriptPlan('x.sh', 'linux').cmd, '/bin/sh');
eq('.py 在 Linux 优先 python3', platform.scriptPlan('x.py', 'linux').cmd, 'python3');
eq('.js 用 Electron 自带的 node（RUN_AS_NODE）', platform.scriptPlan('x.js', 'darwin').env.ELECTRON_RUN_AS_NODE, '1');
t('.bat 只在 Windows 有效', () => {
  assert.ok(platform.scriptPlan('a.bat', 'win32'));
  assert.strictEqual(platform.scriptPlan('a.bat', 'linux'), null);
});
eq('未知扩展返回 null', platform.scriptPlan('a.xyz', 'win32'), null);

/* ---------- 打开 / 结束进程 ---------- */
eq('Windows 用 explorer 代启（保持普通权限）', platform.openPlan('D:/a.exe', 'win32').cmd, 'explorer.exe');
eq('macOS 用 open 打开 .app', platform.openPlan('/Applications/Safari.app', 'darwin').cmd, 'open');
eq('Linux 用 xdg-open', platform.openPlan('/tmp/a.txt', 'linux').cmd, 'xdg-open');
eq('Windows 结束进程用 taskkill', platform.killPlan(123, 'win32').cmd, 'taskkill');
eq('POSIX 结束进程用 kill -9', platform.killPlan(123, 'darwin').args, ['-9', '123']);

/* ---------- 开机自启 ---------- */
t('自启路径分平台落点正确', () => {
  const home = os.tmpdir();
  const lnk = platform.autostartPath({ plat: 'win32', home, appData: home });
  const plist = platform.autostartPath({ plat: 'darwin', home });
  const desktop = platform.autostartPath({ plat: 'linux', home });
  assert.ok(/Startup[\\/]FDE Manager\.lnk$/.test(lnk), lnk);
  assert.ok(/Library[\\/]LaunchAgents[\\/]com\.fde\.manager\.plist$/.test(plist), plist);
  assert.ok(/autostart[\\/]fde-manager\.desktop$/.test(desktop), desktop);
});
t('plist / desktop 内容可解析且指向 exe', () => {
  const exe = '/Applications/FDE Manager.app/Contents/MacOS/FDE Manager';
  const plist = platform.autostartContent({ plat: 'darwin', exe });
  const d = platform.autostartContent({ plat: 'linux', exe });
  assert.ok(plist.includes('<string>' + exe + '</string>') && plist.includes('RunAtLoad'));
  assert.ok(d.includes('Exec="' + exe + '"') && d.startsWith('[Desktop Entry]'));
  assert.strictEqual(platform.autostartContent({ plat: 'win32', exe }), '');   // Windows 是 .lnk，不是文本
});

/* ---------- 热键 / 浏览器 / 托盘 / 必需文件 ---------- */
eq('macOS 热键前缀是 Cmd', platform.shortcutAccel('0', 'darwin'), 'Command+Alt+0');
eq('Windows 热键前缀是 Ctrl', platform.shortcutAccel('0', 'win32'), 'Control+Alt+0');
t('浏览器候选按平台给路径', () => {
  const w = platform.knownBrowsers({ plat: 'win32' });
  const m = platform.knownBrowsers({ plat: 'darwin' });
  const l = platform.knownBrowsers({ plat: 'linux' });
  assert.ok(w.some(x => /msedge\.exe$/.test(x[1])));
  assert.ok(m.some(x => x[1].includes('Safari.app')));
  assert.ok(l.some(x => x[1].includes('google-chrome')));
});
t('托盘图标候选包含 assets 与 build 两处', () => {
  const list = platform.trayIconCandidates({ plat: 'darwin', appDir: '/app' });
  assert.ok(list.some(p => p.includes('trayTemplate.png')));
  assert.ok(list.some(p => p.includes('icon.png')));
});
t('必需文件：只有 Windows 才要求 winhelper.ps1', () => {
  assert.ok(platform.requiredFiles('win32').includes('winhelper.ps1'));
  assert.ok(!platform.requiredFiles('darwin').includes('winhelper.ps1'));
  assert.ok(platform.requiredFiles('darwin').includes('wmp.js'));
});
eq('只有 Windows 有提权概念', platform.needsElevation('darwin'), false);

console.log('\nPASS ' + pass + ' 通过' + (fail ? '，FAIL ' + fail + ' 失败' : '，全部通过'));
process.exit(fail ? 1 : 0);
