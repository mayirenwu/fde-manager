/**
 * wmp.js 行为测试（不依赖 electron；在 Windows 上也能跑）：
 * 验证"任何一条命令失败都不抛异常、只回空/ok"——这是窗口隔离不拖垮主程序的底线。
 * 跑法：node test-wmp.js
 */
const assert = require('assert');
const wmp = require('./wmp');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' | ' + (e && e.message || e)); }
}

(async () => {
  // 本机（Windows）上没有 osascript / xdotool：这两个 provider 必须优雅退化
  await t('mac provider：ENUM 失败回 []，不抛异常', async () => {
    const m = wmp.create('darwin');
    const r = await m.exec('ENUM|1,2|');
    assert.strictEqual(r, '[]');
  });
  await t('mac provider：HIDE/SHOW/FOCUS 失败也回 ok', async () => {
    const m = wmp.create('darwin');
    for (const c of ['HIDE|123', 'SHOW|123', 'MIN|123', 'CLOSE|123', 'FOCUS|123', 'MOVE|123|1|2', 'RECT|123']) {
      const r = await m.exec(c);
      assert.ok(['ok', '[]'].includes(r), c + ' → ' + r);
    }
  });
  await t('mac provider：PPID 走 ps，失败回 []', async () => {
    const m = wmp.create('darwin');
    const r = await m.exec('PPID|1,2,3');
    assert.ok(r === '[]' || /^\[/.test(r), 'PPID → ' + r);
  });
  await t('linux provider：ENUM 失败回 []', async () => {
    const m = wmp.create('linux');
    assert.strictEqual(await m.exec('ENUM|1|'), '[]');
  });
  await t('linux provider：SETRECT/WORK 不报错', async () => {
    const m = wmp.create('linux');
    await m.exec('SETRECT|123|0|0|100|50');
    await m.exec('WORK');
  });
  await t('none provider：永远回空', async () => {
    const n = wmp.create('freebsd');
    assert.strictEqual(await n.exec('ENUM|'), '');
    const st = await n.start();
    assert.strictEqual(st.ok, false);
  });
  await t('start() 在缺失工具的系统上给出明确原因，不抛异常', async () => {
    const m = wmp.create('darwin');
    const st = await m.start();
    assert.ok(typeof st.detail === 'string' && st.detail.length > 0);
  });

  console.log('\nPASS ' + pass + ' 通过' + (fail ? '，FAIL ' + fail + ' 失败' : '，全部通过'));
  process.exit(fail ? 1 : 0);
})();
