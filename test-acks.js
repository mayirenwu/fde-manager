/**
 * 确认台账测试。重点不是"能不能存"，而是几条会影响信任的规则：
 *  - 不许匿名确认
 *  - 异议必须写原因
 *  - 有异议就绝不能算"全部完成"（这是最容易写错、也最伤人的地方）
 *  - 脏数据不能让页面白屏
 */
const assert = require('assert');
const acks = require('./acks');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n[确认台账]');

t('定义完整且 key 不重复', () => {
  assert.strictEqual(acks.ACK_DEFS.length, 8);
  const keys = acks.ACK_DEFS.map(d => d.key);
  assert.strictEqual(new Set(keys).size, 8, '有重复 key');
  for (const d of acks.ACK_DEFS) {
    assert.ok(d.title && d.who && d.hint && d.page, d.key + ' 字段不全');
    // 每一项都要说清"轮到谁"，否则页面上没人认领
    assert.ok(d.who.length > 0);
    assert.ok(Array.isArray(d.roles) && d.roles.length > 0, d.key + ' 缺 roles');
    assert.ok(d.why && d.why.length > 8, d.key + ' 缺「对各方有什么用」');
  }
});

t('没有数据时全部是待确认', () => {
  const list = acks.acksOf({});
  assert.strictEqual(list.length, 8);
  assert.ok(list.every(x => x.state === 'pending'));
  assert.ok(list.every(x => x.by === '' && x.at === 0));
});

t('初始进度：0/8，未完成', () => {
  const st = acks.ackStats(acks.acksOf({}));
  assert.deepStrictEqual(
    { total: st.total, ok: st.ok, object: st.object, pending: st.pending, pct: st.pct, complete: st.complete },
    { total: 8, ok: 0, object: 0, pending: 8, pct: 0, complete: false }
  );
});

t('确认后记录署名与时间', () => {
  const p = {};
  const r = acks.setAck(p, 'scope', 'ok', '张伟', '');
  assert.ok(r.ok);
  const item = r.acks.find(a => a.key === 'scope');
  assert.strictEqual(item.state, 'ok');
  assert.strictEqual(item.by, '张伟');
  assert.ok(item.at > 0);
  assert.strictEqual(r.ackStats.ok, 1);
});

t('拒绝匿名确认', () => {
  const r = acks.setAck({}, 'scope', 'ok', '   ', '');
  assert.strictEqual(r.ok, false);
  assert.ok(/署名/.test(r.error), r.error);
});

t('异议必须写原因', () => {
  const r = acks.setAck({}, 'runs', 'object', '李会计', '  ');
  assert.strictEqual(r.ok, false);
  assert.ok(/原因/.test(r.error), r.error);
  const ok = acks.setAck({}, 'runs', 'object', '李会计', '成功率没扣掉重试，需要重算');
  assert.ok(ok.ok);
  assert.strictEqual(ok.acks.find(a => a.key === 'runs').remark, '成功率没扣掉重试，需要重算');
});

t('未知条目与非法状态都拒绝', () => {
  assert.strictEqual(acks.setAck({}, 'nope', 'ok', '张伟').ok, false);
  assert.strictEqual(acks.setAck({}, 'scope', 'done', '张伟').ok, false);
});

t('撤回后回到待确认且不留残迹', () => {
  const p = {};
  acks.setAck(p, 'fee', 'ok', '张伟');
  assert.ok(p.acks.fee);
  const r = acks.setAck(p, 'fee', 'pending', '张伟');
  assert.ok(r.ok);
  assert.strictEqual(p.acks.fee, undefined);
  assert.strictEqual(r.acks.find(a => a.key === 'fee').state, 'pending');
});

t('进度按 8 项算（4/8 = 50%）', () => {
  const p = {};
  ['scope', 'baseline', 'scripts', 'runs'].forEach(k => acks.setAck(p, k, 'ok', '张伟'));
  const st = acks.ackStats(acks.acksOf(p));
  assert.strictEqual(st.ok, 4);
  assert.strictEqual(st.pct, 50);
  assert.strictEqual(st.complete, false);
});

t('全部确认才算完成', () => {
  const p = {};
  acks.ACK_DEFS.forEach(d => acks.setAck(p, d.key, 'ok', '张伟'));
  const st = acks.ackStats(acks.acksOf(p));
  assert.strictEqual(st.ok, 8);
  assert.strictEqual(st.pct, 100);
  assert.strictEqual(st.complete, true);
});

t('7 项通过 + 1 项异议 ≠ 完成', () => {
  const p = {};
  acks.ACK_DEFS.forEach((d, i) => {
    acks.setAck(p, d.key, i === 0 ? 'object' : 'ok', '张伟', i === 0 ? '口径不对' : '');
  });
  const st = acks.ackStats(acks.acksOf(p));
  assert.strictEqual(st.ok, 7);
  assert.strictEqual(st.object, 1);
  assert.strictEqual(st.pending, 0);
  assert.strictEqual(st.complete, false, '有异议时不能算完成');
});

t('脏数据不炸：acks 是数组 / 非法状态', () => {
  const a = acks.acksOf({ acks: [] });
  assert.ok(a.every(x => x.state === 'pending'));
  const b = acks.acksOf({ acks: { scope: { state: 'weird', by: 123 }, runs: 'x' } });
  assert.strictEqual(b.find(x => x.key === 'scope').state, 'pending');
  assert.strictEqual(b.find(x => x.key === 'scope').by, '');
  assert.strictEqual(b.find(x => x.key === 'runs').state, 'pending');
});

t('摘要文本含进度、署名和异议原因', () => {
  const p = {};
  acks.setAck(p, 'scope', 'ok', '张伟');
  acks.setAck(p, 'runs', 'object', '李会计', '成功率算法要改');
  const d = acks.ackDigest(p);
  assert.ok(d.includes('1/8'), d);
  assert.ok(d.includes('张伟'));
  assert.ok(d.includes('成功率算法要改'));
  assert.ok(d.includes('有异议'));
});

t('重复确认是覆盖，不会累积多条', () => {
  const p = {};
  acks.setAck(p, 'scope', 'ok', '张伟');
  acks.setAck(p, 'scope', 'object', '李会计', '我又看了一遍，有问题');
  const list = acks.acksOf(p);
  assert.strictEqual(list.filter(a => a.key === 'scope').length, 1);
  assert.strictEqual(list.find(a => a.key === 'scope').by, '李会计');
  assert.strictEqual(acks.ackStats(list).object, 1);
});

console.log('waitByRole / digest');
t('待确认项按在等哪一方分组', () => {
  const ok = { state: 'ok', by: 'a' };
  const p2 = { acks: {
    scope: ok, baseline: ok, scripts: ok, roles: ok, security: ok, accept: ok,
    runs: { state: 'pending' }, fee: { state: 'pending' }
  } };
  const w = acks.waitByRole(acks.acksOf(p2));
  assert.strictEqual(w['复核人'], 1, JSON.stringify(w));
  assert.strictEqual(w['决策人'], 1, JSON.stringify(w));
  assert.strictEqual(w['服务方'], undefined, JSON.stringify(w));
});
t('摘要带项目名与完成线', () => {
  const d = acks.ackDigest({ name: '亚马逊', acks: { scope: { state: 'ok', by: 'a', at: Date.now() } } });
  assert.ok(d.includes('项目：亚马逊'));
  assert.ok(d.includes('不作为验收依据'));
});

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
