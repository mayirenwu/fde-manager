/**
 * 一键测试：顺序跑根目录下所有 test-*.js（纯 Node 单测，不依赖显示窗口）。
 * 跑法：npm test
 *
 * 设计要点：
 *  - 用子进程跑而不是 require：单个测试崩了（process.exit / 未捕获异常）不会拖死整个 Runner；
 *  - 任一失败最后退出码非 0，CI 直接标红；
 *  - scripts/ 下的 test-*.js 是需要 Electron 显示窗口的集成测试，不在这里跑
 *    （CI 无头环境跑不了，本地排障时单独执行）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(root)
  .filter(f => /^test-.+\.js$/.test(f))
  .sort();

let failed = [];
const started = Date.now();
for (const f of files) {
  const p = path.join(root, f);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [p], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0;
  const out = String(r.stdout || '') + String(r.stderr || '');
  // 每个测试只留一行结果 + 失败时把输出倒出来，免得几百行绿字把失败淹了
  const m = out.match(/(\d+)\s*(?:passed|通过|✓)[^\n]*?(\d+)\s*(?:failed|失败|✗)/i)
    || out.match(/pass[^\d]*(\d+)[^\d]*fail[^\d]*(\d+)/i);
  const brief = m ? `（过 ${m[1]} / 挂 ${m[2]}）` : '';
  console.log((ok ? '  ✓ ' : '  ✗ ') + f + ' ' + brief + '(' + (Date.now() - t0) + 'ms)');
  if (!ok) {
    failed.push(f);
    console.log('---- 失败输出 ' + f + ' ----');
    console.log(out.split('\n').filter(l => /✗|Error|fail|失败|assert/i.test(l)).slice(0, 30).join('\n') || out.slice(-2000));
    console.log('----------------');
  }
}

console.log('\n共 ' + files.length + ' 个测试文件，耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
if (failed.length) {
  console.log('✗ 失败：' + failed.join(', '));
  process.exit(1);
}
console.log('✓ 全部通过');
