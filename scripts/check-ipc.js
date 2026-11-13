/**
 * 接口对账：preload 里调用的每个通道，主进程都必须有 handler，反之亦然。
 * 这类"少注册一个"的问题在真机上只表现为"点了没反应"，很难查，所以用脚本卡住。
 * 跑法：node scripts/check-ipc.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const invoked = [...pre.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]);
const handled = [...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]);
const sent = [...main.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map(m => m[1]);
const allowed = (pre.match(/ALLOWED_CHANNELS\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
const subscribed = [...allowed.matchAll(/'([^']+)'/g)].map(m => m[1]);

const uniq = (a) => [...new Set(a)].sort();
const missingHandler = uniq(invoked).filter(c => !handled.includes(c));
const orphanHandler = uniq(handled).filter(c => !invoked.includes(c));
const missingAllow = uniq(sent).filter(c => !subscribed.includes(c) && !c.startsWith('fde:'));

let bad = 0;
function line(ok, text) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + text);
  if (!ok) bad++;
}

console.log('preload 调用 ' + uniq(invoked).length + ' 个通道 / 主进程注册 ' + uniq(handled).length + ' 个');
line(missingHandler.length === 0, '每个调用都有 handler' + (missingHandler.length ? '：缺 ' + missingHandler.join(', ') : ''));
line(orphanHandler.length === 0, '没有没人用的 handler' + (orphanHandler.length ? '：多 ' + orphanHandler.join(', ') : ''));
line(missingAllow.length === 0, '主进程推送的通道都在白名单里' + (missingAllow.length ? '：缺 ' + missingAllow.join(', ') : ''));

// 新功能的关键入口别被误删
const must = ['apps:get', 'apps:save', 'apps:scan', 'apps:install', 'apps:to-canvas', 'ai:get', 'ai:save', 'ai:detect', 'ai:test', 'ai:chat'];
const missingMust = must.filter(c => !handled.includes(c));
line(missingMust.length === 0, '应用功能 / AI 算力的关键接口都在' + (missingMust.length ? '：缺 ' + missingMust.join(', ') : ''));

process.exit(bad ? 1 : 0);
