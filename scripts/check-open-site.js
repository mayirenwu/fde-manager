/**
 * 检查「打开官网 / 看用量」这类链接真的能打开（不会闪一下就没、也不会打不开）。
 *
 * 背景（真机复现）：
 *  - 这台机器注册表里的"默认浏览器"是 360se，直接起会 exit 21、一个窗口都没有，
 *    shell.openExternal 也不报错 —— 光靠系统壳就是"点了没反应"；
 *  - 旧代码还传 owner=null（=原电脑桌面），当前是项目桌面时浏览器窗口会被立刻藏起来；
 *  - 浏览器自己的助手小窗（纯数字标题）还会把"打开意图"吃掉。
 *
 * 所以现在的契约是「能看见才算成功」：
 *   系统默认浏览器 → 换一个装着的浏览器 → 最后在 FDE 里开内置窗口。
 * 跑法：node scripts/check-open-site.js
 */
const fs = require('fs');
const path = require('path');
const urlopen = require('../urlopen');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const urlSrc = fs.readFileSync(path.join(ROOT, 'urlopen.js'), 'utf8');
const appsHtml = fs.readFileSync(path.join(ROOT, 'apps.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  [' + String(extra).slice(0, 120) + ']' : '')); }
};
const fnBody = (name) => {
  const i = main.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = main.indexOf('\n}\n', i);
  return j < 0 ? main.slice(i) : main.slice(i, j + 3);
};

console.log('== 1. 打开通道：能看见才算成功 ==');
const fn = fnBody('openUserSite');
ok(!!fn, 'main.js 有 openUserSite（专门打开"给人看的网页"）');
ok(/shell\.openExternal\(target\)/.test(fn), '第一步交给系统默认浏览器');
ok(fn.indexOf('shell.openExternal') < fn.indexOf('altBrowsers'), '系统默认浏览器是首选，换浏览器只是兜底');
ok(/noteOpenIntent\(activeId, target/.test(fn), '意图记在当前桌面（activeId），不再写死 null=原电脑桌面');
ok(/adoptSiteWindow\(it, 2200/.test(fn), '打开后会等窗口出现并认领（默认浏览器这一档）');
ok(/for \(const b of await altBrowsers\(defExe\)\)/.test(fn), '默认浏览器没起来时，换一个装着的浏览器再试');
ok(/openSiteInside\(target\)/.test(fn), '全都不行就用 FDE 内置窗口打开（保证能看见页面）');
ok(/if \(!IS_WIN\) return/.test(fn), 'mac / Linux 交给系统，不掺和窗口归属');

console.log('\n== 2. 备用浏览器清单 ==');
const alt = fnBody('altBrowsers');
ok(/detectBrowsers\(\)/.test(alt), '先看注册表里登记的浏览器');
ok(/platform\.knownBrowsers\(\)/.test(alt), '注册表没有就按常见安装路径补（绿色版 / 干净系统也能找到 Edge、Chrome）');
ok(/!== defBase/.test(alt), '跳过起不来的那个默认浏览器（否则会反复试同一个）');
ok(/slice\(0, 3\)/.test(alt), '最多试 3 个，不会一路弹窗口');

console.log('\n== 3. 认领窗口（真让它留在当前桌面）==');
const adopt = fnBody('adoptSiteWindow');
ok(/applyVisibility\(\)/.test(adopt), '认领后重新算可见性（不会再被藏）');
ok(/SHOW\|/.test(adopt) && /FOCUS\|/.test(adopt), '认领后显示 + 前置');
ok(/isBrowserExe/.test(adopt) && /iconic/.test(adopt), '只在浏览器窗口里找，且跳过最小化的小窗');
ok(/before/.test(adopt), '跟打开前的窗口清单比对，不把原来就在的窗口当新打开的');
ok(/setTimeout\(\(\) => \{ try \{ winCmd\('SHOW/.test(adopt), '加载完再补一次显示（有的浏览器会自己抢焦点）');

console.log('\n== 4. 意图不被助手小窗吃掉（行为验证）==');
const now = 500000;
const it = { owner: 'p1', url: 'https://ai.my10086.cn/api/console/keys', host: 'ai.my10086.cn', exe: '', at: now - 500, used: false };
ok(urlopen.matchIntent([it], { exe: 'C:\\x\\360se.exe', title: '9004' }, now) === null, '360 的纯数字助手小窗不会认领');
ok(urlopen.matchIntent([it], { exe: 'C:\\x\\360se.exe', title: '36516 - 800' }, now) === null, '数字+尺寸的小窗也不会认领');
ok((urlopen.matchIntent([it], { exe: 'C:\\x\\360se.exe', title: 'ai.my10086.cn 密钥管理' }, now) || {}).owner === 'p1', '真页面（标题含站点）照常认领');
ok((urlopen.matchIntent([it], { exe: 'C:\\x\\360se.exe', title: '' }, now) || {}).owner === 'p1', '还在加载、标题为空时也能认领');
ok(/纯数字标题/.test(urlSrc), 'urlopen.js 里写明了这条规则（防止以后被删）');

console.log('\n== 5. 谁在用 / 界面入口 ==');
const aiHandler = (main.match(/ipcMain\.handle\('ai:open'[\s\S]*?\n  \}\);/) || [''])[0];
ok(/openUserSite\(url\)/.test(aiHandler), '模型设置里「打开网站 / 拿密钥 / 看用量」走 openUserSite');
ok(!/openUrlOn\(null/.test(main), 'main.js 里不再有 owner 写死 null 的 openUrlOn 调用');
const appsHandler = (main.match(/ipcMain\.handle\('apps:open-target'[\s\S]*?\n  \}\);/) || [''])[0];
ok(/openUserSite\(target\)/.test(appsHandler), '应用功能里「用一下试试」的网页链接也走 openUserSite');
ok(/id="aiOpenKey"/.test(appsHtml) && /openSite\('keys'/.test(appsHtml) && /window\.fde\.aiOpen\(which\)/.test(appsHtml), '「打开网站 ↗」按钮在（点击有"正在打开…"反馈）');
ok(/id="aiOpenKeyLink"/.test(appsHtml) && /ai\.my10086\.cn\/api\/console\/keys/.test(appsHtml), '「拿密钥 / 看用量」链接在');

console.log('\n' + (fail ? ('FAIL ' + fail + ' 项，') : '') + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
