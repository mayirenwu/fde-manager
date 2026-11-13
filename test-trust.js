/**
 * trust.js 单元测试：文档里出现的每个数字都必须能从数据推回去。
 * 跑法：node test-trust.js
 */
const assert = require('assert');
const trust = require('./trust');

const now = Date.now();
const day = 86400000;

const data = {
  stats: { aiCalls: 12, cacheHits: 30, tokensSaved: 48000 },
  projects: [
    {
      id: 'p1', name: '亚马逊·美国站', desc: '主店日常运营', status: 'running', color: '#4f8cff',
      items: [
        { id: 'i1', name: '导订单报表', path: 'C:/work/export.ps1', lastRun: { at: now - day, code: 0, output: 'ok' } },
        { id: 'i2', name: '库存核对', path: 'C:/work/stock.py', lastRun: { at: now - 2 * day, code: 1, output: 'err' } }
      ],
      autorun: [{ name: '店小秘', path: 'C:/app/dxm.exe', delay: 3 }],
      windows: [{ match: '店小秘', title: '店小秘' }, { match: 'Chrome', title: '卖家后台' }],
      context: [{ kind: 'file', title: '订单模板', value: 'C:/ctx/order.xlsx' }],
      case: { client: '华东某跨境卖家', industry: '跨境电商', pain: '每天导表 2 小时', solution: '拆成 3 个脚本', quote: '现在点一下就行', allowPublish: true, manualMinutes: 120, hourlyRate: 80, since: now - 30 * day, owner: '张三', contact: '王经理' }
    },
    { id: 'p2', name: '空项目' }
  ],
  logs: [
    { time: now - 3 * day, projectId: 'p1', text: '脚本完成: 导订单报表' },
    { time: now - 2 * day, projectId: 'p1', text: '脚本失败(退出码 1): 库存核对 · 输出: timeout' },
    { time: now - day, projectId: 'p1', text: '脚本完成: 导订单报表' },
    { time: now - day, projectId: 'p1', text: '脚本完成: 库存核对' },
    { time: now - day, projectId: 'p2', text: '脚本完成: 别的项目的' }
  ],
  canvas: { nodes: [{ id: 'n1', type: 'project', title: '亚马逊', ref: { projectId: 'p1' } }, { id: 'n2', type: 'ai', title: '写文案' }], edges: [] }
};

let pass = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('collectEvidence');
const ev = trust.collectEvidence(data, 'p1', { from: 0, to: Date.now() + 1000 });

t('只统计本项目日志', () => {
  assert.ok(ev.runs.every(r => r.name !== '别的项目的'));
  assert.strictEqual(ev.counts.runs, 4, '实际 ' + ev.counts.runs);
});
t('成功/失败计数正确', () => {
  assert.strictEqual(ev.counts.okRuns, 3);
  assert.strictEqual(ev.counts.failRuns, 1);
});
t('成功率按实际计算', () => {
  assert.strictEqual(ev.counts.successRate, 75);
});
t('节省工时 = 成功次数 × 单次人工', () => {
  assert.strictEqual(ev.saved.minutes, 3 * 120);
});
t('金额按小时成本折算', () => {
  assert.strictEqual(ev.saved.yuan, Math.round(6 * 80));
});
t('脚本/窗口/上下文/画布节点计数', () => {
  assert.strictEqual(ev.counts.scripts, 2);
  assert.strictEqual(ev.counts.windows, 2);
  assert.strictEqual(ev.counts.context, 1);
  assert.strictEqual(ev.counts.canvasNodes, 1);
});
t('日志丢了也能用 lastRun 补（去重不重复计数）', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.logs = [{ time: now - day, projectId: 'p1', text: '脚本完成: 导订单报表' }];
  const e2 = trust.collectEvidence(d2, 'p1', {});
  assert.strictEqual(e2.counts.runs, 2, '实际 ' + e2.counts.runs);
});
t('不存在的项目返回 null', () => {
  assert.strictEqual(trust.collectEvidence(data, 'nope', {}), null);
});
t('没有 case 的项目不报错', () => {
  const e = trust.collectEvidence(data, 'p2', {});
  assert.strictEqual(e.case.manualMinutes, 0);
  assert.strictEqual(e.saved.minutes, 0);
});
t('时间范围能过滤', () => {
  const e = trust.collectEvidence(data, 'p1', { from: now - 1.5 * day, to: now });
  assert.strictEqual(e.counts.runs, 2, '实际 ' + e.counts.runs);
});

console.log('renderReportHtml');
const ackList = [
  { title: '数据范围与存放位置', state: 'ok', by: '张伟（IT）', at: Date.now() - 86400000, remark: '' },
  { title: '执行记录与成功率', state: 'object', by: '李会计', at: Date.now() - 3600000, remark: '成功率没扣掉重试' },
  { title: '本期验收结论', state: 'pending', by: '', at: 0, remark: '' }
];
const report = trust.renderReportHtml(ev, {
  operator: '张三', isAdmin: false,
  acks: ackList, ackStats: { total: 3, ok: 1, object: 1 }
});
const reportNoAck = trust.renderReportHtml(ev, { operator: '张三', isAdmin: false });
t('包含项目名与客户名', () => {
  assert.ok(report.includes('亚马逊·美国站'));
  assert.ok(report.includes('华东某跨境卖家'));
});
t('包含真实执行次数与成功率', () => {
  assert.ok(report.includes('75%'));
  assert.ok(report.includes('3 成功 / 1 失败'));
});
t('多方确认记录进报告：署名、异议原因都在', () => {
  assert.ok(report.includes('各方确认记录'));
  assert.ok(report.includes('张伟（IT）'));
  assert.ok(report.includes('成功率没扣掉重试'));
  assert.ok(report.includes('不作为验收依据'));
});
t('没有确认台账时不出现空章节', () => {
  assert.ok(!reportNoAck.includes('各方确认记录'));
});
t('失败记录也在表里（不能只挑好听的）', () => {
  assert.ok(report.includes('库存核对'));
  assert.ok(report.includes('失败'));
});
t('效果一节写明口径，不做绝对承诺', () => {
  assert.ok(/口径说明|口径声明/.test(report));
  assert.ok(report.includes('不构成对结果的承诺'));
});
t('带编号与签署栏', () => {
  assert.ok(/FDE-[A-Z0-9]{4}-\d{8}/.test(report));
  assert.ok(report.includes('客户方（签字 / 日期）'));
});
t('是完整 HTML 文档（能直接打印）', () => {
  assert.ok(report.startsWith('<!DOCTYPE html>'));
  assert.ok(report.includes('@page'));
});
t('HTML 转义：项目名里的尖括号不会破坏文档', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.projects[0].name = 'A<script>alert(1)</script>B';
  const e = trust.collectEvidence(d, 'p1', {});
  const h = trust.renderReportHtml(e, {});
  assert.ok(!h.includes('<script>alert(1)</script>'));
  assert.ok(h.includes('&lt;script&gt;'));
});

console.log('renderCaseHtml');
const cs = trust.renderCaseHtml(ev, {});
t('有客户评价时正常展示', () => {
  assert.ok(cs.includes('现在点一下就行'));
});
t('无授权时给出提示', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.projects[0].case.allowPublish = false;
  const e = trust.collectEvidence(d, 'p1', {});
  assert.ok(trust.renderCaseHtml(e, {}).includes('需取得客户授权'));
});
t('无评价时不编造，给出获取建议', () => {
  const d = JSON.parse(JSON.stringify(data));
  d.projects[0].case.quote = '';
  const e = trust.collectEvidence(d, 'p1', {});
  assert.ok(trust.renderCaseHtml(e, {}).includes('还没有客户评价'));
});

console.log('renderSecurityHtml');
const facts = trust.securityFacts(data, {
  dataRoot: 'C:/data', dataFile: 'C:/data/fde-data.json', dataSize: 20480,
  mode: 'portable', source: 'portable.json', appDir: 'C:/app', version: '2.1.0', isAdmin: true
});
const sec = trust.renderSecurityHtml(facts, data);
t('写出数据实际路径', () => {
  assert.ok(sec.includes('C:/data/fde-data.json'));
});
t('零外发是主结论', () => {
  assert.ok(sec.includes('不向任何外部服务器发送数据'));
  assert.ok(sec.includes('0 个外发请求'));
});
t('列出 AI 数据流向说明', () => {
  assert.ok(sec.includes('复制到剪贴板'));
});
t('写明删除与退出方式', () => {
  assert.ok(sec.includes('fde-data.json 即可'));
});
t('项目表列出所有项目', () => {
  assert.ok(sec.includes('亚马逊·美国站') && sec.includes('空项目'));
});

console.log('BIZ_TEMPLATES');
t('模板齐全且都有正文', () => {
  assert.ok(trust.BIZ_TEMPLATES.length >= 6);
  for (const t0 of trust.BIZ_TEMPLATES) {
    assert.ok(t0.id && t0.name && t0.body.length > 200, t0.id);
  }
});
t('合同包含三条护城河条款', () => {
  const c = trust.BIZ_TEMPLATES.find(x => x.id === 'contract').body;
  assert.ok(/责任限制/.test(c), '缺责任上限');
  assert.ok(/数据与保密/.test(c), '缺数据条款');
  assert.ok(/退出与交接/.test(c), '缺退出机制');
  assert.ok(/不得以任何技术手段/.test(c), '缺反锁定条款');
});
t('SLA 明确不承诺经营结果', () => {
  const s = trust.BIZ_TEMPLATES.find(x => x.id === 'sla').body;
  assert.ok(/不承诺甲方业务收入/.test(s));
});
t('POC 有"不通过怎么办"', () => {
  const p = trust.BIZ_TEMPLATES.find(x => x.id === 'poc').body;
  assert.ok(/试点不通过/.test(p));
});

console.log('\n' + pass + ' 项通过' + (process.exitCode ? '，有失败' : ''));
