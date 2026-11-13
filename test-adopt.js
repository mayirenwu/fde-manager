/**
 * adopt.js 单元测试：投入产出必须算得平，算不平要敢说"别做"。
 * 跑法：node test-adopt.js
 */
const assert = require('assert');
const trust = require('./trust');
const adopt = require('./adopt');

const now = Date.now();
const data = {
  stats: {}, canvas: { nodes: [], edges: [] },
  projects: [{
    id: 'p1', name: '亚马逊·订单处理', items: [
      { id: 'i1', name: '导订单', path: 'C:/s/a.ps1', lastRun: { at: now - 3600000, code: 0 } },
      { id: 'i2', name: '核对库存', path: 'C:/s/b.py', lastRun: { at: now - 7200000, code: 1 } }
    ],
    autorun: [], windows: [], context: [
      { kind: 'file', title: '订单表', value: 'C:/ctx/order.xlsx' },
      { kind: 'dir', title: '报表目录', value: 'C:/ctx/reports' },
      { kind: 'web', title: '后台', value: 'https://sellercentral.amazon.com' }
    ],
    case: { client: '华东某卖家', manualMinutes: 120, hourlyRate: 80, quote: '', allowPublish: true },
    stakeholders: [], adoption: {}
  }]
};
// 近 30 天 22 次执行
for (let i = 0; i < 22; i++) {
  data.logs = data.logs || [];
  data.logs.push({ time: now - i * 86400000, projectId: 'p1', text: '脚本完成: 导订单' });
}
const ev = trust.collectEvidence(data, 'p1', {});

let pass = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('computeAdoption');
t('频次留空时用近 30 天真实执行次数', () => {
  // 22 条日志 + 2 条脚本 lastRun 补漏 = 24 次（时间不同，不是重复）
  const c = adopt.computeAdoption(ev, { perRunMinutes: 120, reviewMinutes: 5 });
  assert.strictEqual(c.freq, 24, '实际 ' + c.freq);
  assert.ok(c.freqSource.includes('真实执行'));
});
t('手工填频次优先于实测', () => {
  const c = adopt.computeAdoption(ev, { perRunMinutes: 120, monthlyRuns: 10 });
  assert.strictEqual(c.freq, 10);
  assert.strictEqual(c.freqSource, '手工填写');
});
t('净释放 = 频次 ×(人工 − 复核)', () => {
  const c = adopt.computeAdoption(ev, { perRunMinutes: 120, reviewMinutes: 5, monthlyRuns: 10 });
  assert.strictEqual(c.beforeMin, 1200);
  assert.strictEqual(c.afterMin, 50);
  assert.strictEqual(c.savedMin, 1150);
});
t('复核 >= 人工 → 判定"别做"（不硬卖）', () => {
  const c = adopt.computeAdoption(ev, { perRunMinutes: 10, reviewMinutes: 12, monthlyRuns: 10 });
  assert.strictEqual(c.verdict, 'not-worth');
  assert.ok(c.why.includes('不适合自动化'));
});
t('释放抵不过服务费 → 判定"算得紧"', () => {
  // 10 次 × (20−5) 分钟 = 150 分钟 = 2.5h × 80 = 200 元，服务费 300
  const c = adopt.computeAdoption(ev, { perRunMinutes: 20, reviewMinutes: 5, monthlyRuns: 10, hourlyRate: 80, monthlyFee: 300 });
  assert.strictEqual(c.verdict, 'marginal');
  assert.ok(c.savedYuan < 0);
});
t('口径缺失 → unknown，不瞎算', () => {
  // 案例卡没填口径、也没有频次：不能凭空算
  const d = JSON.parse(JSON.stringify(data));
  d.projects[0].case = { client: 'X' };
  d.logs = [];
  const e2 = trust.collectEvidence(d, 'p1', {});
  const c = adopt.computeAdoption(e2, {});
  assert.strictEqual(c.verdict, 'unknown');
  assert.ok(c.why.includes('口径'));
});
t('正常情况 → worth', () => {
  const c = adopt.computeAdoption(ev, { perRunMinutes: 120, reviewMinutes: 5, monthlyRuns: 20, hourlyRate: 80, monthlyFee: 500 });
  assert.strictEqual(c.verdict, 'worth');
  assert.ok(c.savedYuan > 0);
});
t('年化 = 月释放 × 12', () => {
  const c = adopt.computeAdoption(ev, { perRunMinutes: 60, reviewMinutes: 0, monthlyRuns: 10 });
  assert.strictEqual(c.savedPerYear, 600 * 12);
});

console.log('renderBossBrief');
const calc = adopt.computeAdoption(ev, { perRunMinutes: 120, reviewMinutes: 5, monthlyRuns: 20, hourlyRate: 80, monthlyFee: 500 });
const boss = adopt.renderBossBrief(ev, { flowName: '亚马逊订单处理', operatorName: '老王' }, calc);
t('包含可转发的一句话', () => {
  assert.ok(boss.includes('直接转给'));
  assert.ok(boss.includes('亚马逊订单处理'));
});
t('三栏：现在/之后/净变化', () => {
  assert.ok(boss.includes('现在（每月）') && boss.includes('之后（每月）') && boss.includes('净变化（每月）'));
});
t('写清数字来源，不糊弄', () => {
  assert.ok(boss.includes('来源'));
  assert.ok(boss.includes('手工填写') || boss.includes('真实执行记录'));
});
t('给出三个选项，含"暂不做"及其代价', () => {
  assert.ok(boss.includes('A 先试两周'));
  assert.ok(boss.includes('C 暂不做'));
  assert.ok(/晚省/.test(boss));
});
t('不写"省几个人"，写释放工时', () => {
  assert.ok(boss.includes('释放'));
  assert.ok(!/省\s*\d+\s*个人/.test(boss));
});
t('算出不值得时不藏，直接写不建议做', () => {
  const c2 = adopt.computeAdoption(ev, { perRunMinutes: 10, reviewMinutes: 12, monthlyRuns: 10 });
  const d = adopt.renderBossBrief(ev, {}, c2);
  assert.ok(d.includes('不建议做自动化'));
});

console.log('renderOperatorBrief');
const op = adopt.renderOperatorBrief(ev, { flowName: 'X', operatorName: '老王' }, calc);
t('第一屏就是不减员声明', () => {
  assert.ok(op.includes('不减少岗位'));
  assert.ok(op.includes('不会提供任何裁员建议'));
});
t('给判断权、署名权、否决权', () => {
  assert.ok(op.includes('判断权'));
  assert.ok(op.includes('署名权'));
  assert.ok(op.includes('否决权'));
  assert.ok(op.includes('不需要理由'));
});
t('有投入时间表（不让对方觉得要加班）', () => {
  assert.ok(op.includes('每天约 30 分钟'));
});
t('步骤对照表能从 adoption.steps 生成', () => {
  const o2 = adopt.renderOperatorBrief(ev, {
    operatorName: '老王',
    steps: [{ step: '导单', before: '手工导', after: '程序导', you: '确认缺表' }]
  }, calc);
  assert.ok(o2.includes('确认缺表'));
});
t('判错责任不推给操作员', () => {
  assert.ok(op.includes('不由你承担'));
});

console.log('renderReviewerNote');
const rev = adopt.renderReviewerNote(ev, { reviewerName: '李会计', contact: '老王 138', sla: '' }, calc);
t('签字降级为"核对过 5 项"', () => {
  assert.ok(rev.includes('你签的是'));
  assert.ok(rev.includes('核对过'));
  assert.ok(rev.includes('不是"这套系统一定不出错"'));
});
t('数据范围列出真实路径', () => {
  assert.ok(rev.includes('C:/ctx/order.xlsx'));
  assert.ok(rev.includes('C:/ctx/reports'));
});
t('非数据类材料单独说明', () => {
  assert.ok(rev.includes('不涉及文件读写'));
});
t('"不能做什么"写死红线', () => {
  assert.ok(rev.includes('不代客户下单'));
  assert.ok(rev.includes('不向任何外部服务器发送数据'));
});
t('三种结论都提供（含有条件通过）', () => {
  assert.ok(rev.includes('核对通过'));
  assert.ok(rev.includes('有条件通过'));
  assert.ok(rev.includes('不通过'));
});
t('有保留意见填写栏', () => {
  assert.ok(rev.includes('保留意见 / 不通过原因'));
});
t('未登记程序时给出提示而不是空白', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.projects[0].items = [];
  const e2 = trust.collectEvidence(d, 'p1', {});
  const r2 = adopt.renderReviewerNote(e2, {}, adopt.computeAdoption(e2, {}));
  assert.ok(r2.includes('尚未登记程序清单'));
});

console.log('suggestNext / OBSTACLES');
t('抵触的操作员：写清不动编制 + 否决权在他', () => {
  const s = adopt.suggestNext('operator', 'resist');
  assert.ok(s.includes('编制'), s);
  assert.ok(s.includes('否决权'), s);
});
t('抵触的审核员：降级签字', () => {
  const s = adopt.suggestNext('reviewer', 'resist');
  assert.ok(s.includes('有条件通过') || s.includes('核对'));
});
t('抵触的决策人：先别推，给一页纸', () => {
  const s = adopt.suggestNext('boss', 'resist');
  assert.ok(s.includes('一页纸') || s.includes('可随时停'), s);
});
t('已支持的人：请他在关键场合讲一句他的判断', () => {
  assert.ok(adopt.suggestNext('boss', 'support').includes('他的判断'));
});
t('双方都可能卡住的地方：四条都给处理方式', () => {
  assert.ok(Array.isArray(adopt.MUTUAL) && adopt.MUTUAL.length >= 4);
  for (const m of adopt.MUTUAL) assert.ok(m.say && m.dont && m.do && m.basis, m.say);
});
t('每个角色都有默认担忧和动作', () => {
  for (const k of Object.keys(adopt.ROLE_DEFS)) {
    assert.ok(adopt.ROLE_DEFS[k].worry && adopt.ROLE_DEFS[k].action, k);
  }
});
t('话术库覆盖三类关键角色且都有"别这样接"', () => {
  const roles = new Set(adopt.OBSTACLES.map(o => o.role));
  assert.ok(roles.has('operator') && roles.has('reviewer') && roles.has('boss') && roles.has('mid'));
  for (const o of adopt.OBSTACLES) {
    assert.ok(o.say && o.dont && o.do && o.basis, o.say);
  }
});

console.log('\n' + pass + ' 项通过' + (process.exitCode ? '，有失败' : ''));
