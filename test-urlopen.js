/**
 * urlopen.js 单测：网页打开意图 / 浏览器识别 / 注册表解析
 * 跑法：node test-urlopen.js
 */
const u = require('./urlopen');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      期望 ' + JSON.stringify(want) + '\n      实际 ' + JSON.stringify(got)); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n== 1. 可执行文件名 / 浏览器识别 ==');
eq('带引号路径', u.baseName('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'), 'chrome.exe');
eq('反斜杠路径', u.baseName('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'), 'msedge.exe');
eq('正斜杠路径', u.baseName('C:/x/firefox.exe'), 'firefox.exe');
ok('msedge 是浏览器', u.isBrowserExe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
ok('chrome 是浏览器', u.isBrowserExe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
ok('360se 是浏览器', u.isBrowserExe('C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe'));
ok('不区分大小写', u.isBrowserExe('C:\\X\\CHROME.EXE'));
ok('记事本不是浏览器', !u.isBrowserExe('C:\\Windows\\notepad.exe'));
ok('powershell 不是浏览器', !u.isBrowserExe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
ok('空值不是浏览器', !u.isBrowserExe('') && !u.isBrowserExe(null));
ok('chromium 内核判定', u.isChromium('msedge.exe') && u.isChromium('360se.exe') && !u.isChromium('firefox.exe'));

console.log('\n== 2. 网址 → 主机名 / 匹配串 ==');
eq('https + www', u.hostOf('https://www.amazon.com/dp/B08?x=1'), 'www.amazon.com');
eq('无协议', u.hostOf('jd.com/item/1'), 'jd.com');
eq('带端口', u.hostOf('http://127.0.0.1:3000/a'), '127.0.0.1');
eq('带账号', u.hostOf('https://u:p@shop.example.com/x'), 'shop.example.com');
eq('空', u.hostOf(''), '');
eq('www 三档', u.hostLabels('www.amazon.com'), ['www.amazon.com', 'amazon.com', 'amazon']);
eq('首段太短不猜', u.hostLabels('www.x.com'), ['www.x.com', 'x.com']);

console.log('\n== 3. 标题像不像这个站点 ==');
ok('标题含域名', u.titleLooksLike('Amazon.com. Spend less. Smile more.', 'www.amazon.com'));
ok('标题只含站点名', u.titleLooksLike('Amazon 卖家中心', 'www.amazon.com'));
ok('中文站点标题', u.titleLooksLike('京东(JD.COM)-正品低价', 'www.jd.com'));
ok('不相干标题', !u.titleLooksLike('记事本', 'www.amazon.com'));
ok('空标题', !u.titleLooksLike('', 'www.amazon.com'));

console.log('\n== 4. 启动参数（关键：要新开窗口，不要复用标签页）==');
eq('Chrome 用 --new-window', u.launchPlan('C:\\x\\chrome.exe', 'https://a.com'), { exe: 'C:\\x\\chrome.exe', args: ['--new-window', 'https://a.com'] });
eq('Edge 用 --new-window', u.launchPlan('C:\\x\\msedge.exe', 'https://a.com'), { exe: 'C:\\x\\msedge.exe', args: ['--new-window', 'https://a.com'] });
eq('360 也用 --new-window', u.launchPlan('C:\\x\\360se.exe', 'https://a.com'), { exe: 'C:\\x\\360se.exe', args: ['--new-window', 'https://a.com'] });
eq('Firefox 用 -new-window', u.launchPlan('C:\\x\\firefox.exe', 'https://a.com'), { exe: 'C:\\x\\firefox.exe', args: ['-new-window', 'https://a.com'] });
eq('不认识的浏览器只传网址', u.launchPlan('C:\\x\\weird.exe', 'https://a.com'), { exe: 'C:\\x\\weird.exe', args: ['https://a.com'] });
eq('空 exe', u.launchPlan('', 'https://a.com'), null);

console.log('\n== 5. 解析注册表默认浏览器命令 ==');
eq('带引号 + 参数', u.parseRegExe(
  'HKEY_CLASSES_ROOT\\MSEdgeHTM\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1\r\n'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
eq('无引号带参数', u.parseRegExe('    (Default)    REG_SZ    C:\\Chrome\\chrome.exe -- "%1"'), 'C:\\Chrome\\chrome.exe');
eq('只有路径', u.parseRegExe('    (Default)    REG_SZ    "C:\\A B\\browser.exe"'), 'C:\\A B\\browser.exe');
eq('认不出的输出', u.parseRegExe('错误: 系统找不到指定的注册表项或值。'), '');
eq('PowerShell 直接输出命令（360se 真实写法）',
  u.parseRegExe('"C:\\Users\\Administrator\\AppData\\Roaming\\360se6\\Application\\360se.exe" -- "%1"'),
  'C:\\Users\\Administrator\\AppData\\Roaming\\360se6\\Application\\360se.exe');
eq('parseExe: 引号路径 + -- "%1"',
  u.parseExe('"D:\\Program Files\\360\\360se.exe" -- "%1"'), 'D:\\Program Files\\360\\360se.exe');
eq('parseExe: 空', u.parseExe('  '), '');
eq('parseExe: 不是 exe', u.parseExe('rundll32 something'), '');

console.log('\n== 6. 新窗口认领（matchIntent）==');
const now = 1000000;
const it1 = { owner: 'p1', url: 'https://www.amazon.com/x', host: 'www.amazon.com', exe: 'C:\\x\\msedge.exe', at: now - 2000, used: false };
eq('同一个浏览器 + 标题像 → 认领',
  (u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: 'Amazon 商品页' }, now) || {}).owner, 'p1');
eq('同一浏览器开头空标题（加载中）→ 9 秒内认领',
  (u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: '' }, now) || {}).owner, 'p1');
eq('空标题但已过 9 秒 → 不认',
  u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: '' }, now + 20000), null);
eq('标题像但已过 TTL → 不认（窗口早就是老窗口了）',
  u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: 'Amazon 商品页' }, now + 25000), null);
eq('换成了别的浏览器 → 不认（指定了浏览器就只认它）',
  u.matchIntent([it1], { exe: 'C:\\x\\chrome.exe', title: 'Amazon 商品页' }, now), null);
eq('已用过的不重复认领',
  u.matchIntent([{ ...it1, used: true }], { exe: 'C:\\x\\msedge.exe', title: 'Amazon 商品页' }, now), null);
// 360 / QQ 浏览器会顺手弹自己的助手小窗（标题就是一串数字），不能让它吃掉意图
eq('纯数字标题的助手小窗 → 不认（否则真页面没人认领会被藏起来）',
  u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: '9004' }, now), null);
eq('纯数字标题不吃意图，紧接着的真窗口照样能认领',
  (u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: 'Amazon 商品页' }, now) || {}).owner, 'p1');
eq('数字+横线的助手小窗也不认',
  u.matchIntent([it1], { exe: 'C:\\x\\msedge.exe', title: '23276 - 1200' }, now), null);

const it2 = { owner: null, url: 'https://jd.com', host: 'jd.com', exe: '', at: now - 1000, used: false };
eq('没指定浏览器 → 任意浏览器都行',
  (u.matchIntent([it2], { exe: 'C:\\y\\firefox.exe', title: '京东' }, now) || {}).owner, null);
eq('没指定浏览器但来的是记事本 → 不认',
  u.matchIntent([it2], { exe: 'C:\\Windows\\notepad.exe', title: 'jd.com' }, now), null);
eq('意图归"原电脑桌面"(null) 也要认',
  (u.matchIntent([it2], { exe: 'C:\\y\\firefox.exe', title: '京东' }, now) || {}).host, 'jd.com');

console.log('\n== 7. 没开新窗口时的救回（pickRescueWindow）==');
const list = [
  { hwnd: 1, exe: 'C:\\x\\msedge.exe', title: '旧页面', vis: false, iconic: false, fg: false },
  { hwnd: 2, exe: 'C:\\x\\msedge.exe', title: 'Amazon 商品页', vis: false, iconic: false, fg: false },
  { hwnd: 3, exe: 'C:\\Windows\\notepad.exe', title: 'jd.com', vis: true, iconic: false, fg: false }
];
eq('藏起来了也能靠标题找回来', (u.pickRescueWindow(list, it1) || {}).hwnd, 2);
eq('有前台浏览器窗口就优先它',
  (u.pickRescueWindow([{ ...list[0], hwnd: 9, fg: true, vis: true }, list[1]], it1) || {}).hwnd, 9);
eq('刚刚还是前台的窗口（已被藏）也能靠 hwnd 命中',
  (u.pickRescueWindow([list[0], list[1]], it1, { recentFgHwnd: 1 }) || {}).hwnd, 1);
eq('列表里没有浏览器 → null',
  u.pickRescueWindow([list[2]], it1), null);
eq('最小化的浏览器不算', u.pickRescueWindow([{ ...list[1], iconic: true }], it1), null);

console.log('\n== 8. 默认浏览器解析（注入式，不打真注册表）==');
(async () => {
  u.resetBrowserCache();
  const plan1 = () => u.resolveDefaultBrowser({
    query: async () => ({ progId: 'MSEdgeHTM', cmdLine: '"C:\\PF\\msedge.exe" --single-argument %1' }),
    exists: () => true, browsers: async () => [], ttl: 60000
  });
  eq('注册表里的默认浏览器', await plan1(), 'C:\\PF\\msedge.exe');

  const again = await u.resolveDefaultBrowser({
    query: async () => ({ progId: 'X', cmdLine: '"C:\\B\\b.exe"' }),
    exists: () => true, ttl: 60000
  });
  eq('第二次命中缓存', again, 'C:\\PF\\msedge.exe');

  u.resetBrowserCache();
  const fallback = await u.resolveDefaultBrowser({
    query: async () => ({ progId: '360seURL', cmdLine: '"C:\\Users\\Administrator\\360se6\\360se.exe" -- "%1"' }),
    exists: (p) => p === 'C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe',
    browsers: async () => ([
      { name: '360安全浏览器', path: 'C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe' },
      { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    ])
  });
  eq('默认浏览器路径不可用 → 按 ProgId 找同类顶上', fallback,
    'C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe');

  u.resetBrowserCache();
  eq('完全查不到 → 空（交给系统打开）',
    await u.resolveDefaultBrowser({ query: async () => ({ progId: '', cmdLine: '' }) }), '');

  // 真机查询：验证 PowerShell 这条路在这台机器上确实能读出默认浏览器
  u.resetBrowserCache();
  const real = await u.queryDefaultBrowser();
  ok('真机注册表查询有返回', !!(real.progId || real.cmdLine), JSON.stringify(real));
  if (real.cmdLine) {
    const realExe = u.parseExe(real.cmdLine);
    ok('真机命令能解析出 exe', /\.exe$/i.test(realExe), realExe);
    console.log('      · 本机默认浏览器: ' + realExe + '  (ProgId ' + real.progId + ')');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
