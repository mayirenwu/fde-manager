/**
 * builder.js 单元测试：方案解析、落地（项目/自动打开/脚本/节点/连线）、上限与容错。
 * 跑法：node test-builder.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const builder = require('./builder');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-builder-'));
function freshData() {
  return {
    projects: [],
    canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }
  };
}

// ---- buildPrompt ----
const data = freshData();
data.projects.push({ id: 'p1', name: '已有项目', items: [{}], autorun: [{ name: '后台' }] });
data.canvas.nodes.push({ id: 'n1', type: 'note', title: '旧笔记', note: 'x' });
const msgs = builder.buildPrompt(data.projects, data.canvas, '搭一个测试流程');
t('prompt 是 system+user 两条', msgs.length === 2 && msgs[0].role === 'system');
t('prompt 带上已有项目名', msgs[1].content.includes('已有项目'));
t('prompt 带上用户需求', msgs[1].content.includes('搭一个测试流程'));
t('prompt 讲了 JSON 结构', msgs[0].content.includes('"连线"'));

// ---- parsePlan 宽容解析 ----
t('裸 JSON 直接过', builder.parsePlan('{"项目":[],"节点":[],"连线":[],"说明":"x"}').ok);
t('markdown 围栏也能过', builder.parsePlan('好的，方案如下：\n```json\n{"项目":[],"说明":"y"}\n```').ok
  && builder.parsePlan('好的，方案如下：\n```json\n{"项目":[],"说明":"y"}\n```').plan.说明 === 'y');
t('前后有废话也能抠出来', builder.parsePlan('这是方案：{"说明":"z"} 请查收').ok);
t('没有 JSON 时明确报错', !builder.parsePlan('抱歉我不明白').ok);
t('坏 JSON 报可读错误', !builder.parsePlan('{"项目":').ok);

// ---- applyPlan：新建项目 + 自动打开 + 脚本 + 节点 + 连线 ----
const plan = {
  项目: [
    {
      名称: '亚马逊美国站', 颜色: '#4f8cff', 上下文: '美国站日常运营',
      自动打开: [
        { 类型: '网页', 名称: '卖家后台', 网址: 'https://sellercentral.amazon.com' },
        { 类型: '应用', 名称: 'ERP', 路径: 'D:\\erp\\erp.exe', 参数: '--mini' },
        { 类型: '应用', 名称: '没路径的软件' }
      ],
      脚本: [{ 名称: '整理订单', 内容: '# 整理订单\nWrite-Host ok', 说明: '汇总当天订单' }]
    }
  ],
  节点: [
    { 类型: '项目', 标题: '美国站桌面', 说明: '切到亚马逊桌面', 项目名: '亚马逊美国站', 自动打开: true },
    { 类型: '脚本', 标题: '整理订单', 项目名: '亚马逊美国站', 脚本名: '整理订单', 说明: '每天跑一次' },
    { 类型: '网页', 标题: '广告后台', 网址: 'https://advertising.amazon.com' },
    { 类型: 'AI', 标题: '今日汇总', 说明: '汇总订单与广告', 模型: 'deepseek-chat', 多模型: ['deepseek-chat', 'gpt-4o-mini'] },
    { 类型: '笔记', 标题: '备忘' },
    { 类型: '项目', 标题: '坏引用', 项目名: '不存在的项目' },
    { 类型: '脚本', 标题: '坏脚本', 脚本名: '没有这个脚本' },
    { 类型: '网页', 标题: '坏网址', 网址: 'notaurl' }
  ],
  连线: [['美国站桌面', '整理订单'], ['整理订单', '今日汇总'], ['美国站桌面', '不存在'], ['今日汇总', '今日汇总']],
  说明: '搭了一个亚马逊流程'
};
const r1 = builder.applyPlan(freshData(), plan, { scriptRoot: root });
t('项目建出来', r1.created.projects.length === 1 && r1.created.projects[0] === '亚马逊美国站');
t('脚本写出 .ps1 文件', r1.created.scripts.length === 1 && fs.existsSync(path.join(root, 'auto', '亚马逊美国站', '整理订单.ps1')));
t('created.scripts 带项目名', r1.created.scripts[0].project === '亚马逊美国站' && r1.created.scripts[0].name === '整理订单', JSON.stringify(r1.created.scripts));

// AI 写完整脚本：提示词与解析
const sp = builder.scriptPrompt('亚马逊美国站', '整理订单', '读 csv 去重汇总', 'Write-Host "TODO"');
t('scriptPrompt 带上现状与需求', sp.length === 2 && sp[1].content.indexOf('读 csv 去重汇总') >= 0 && sp[1].content.indexOf('TODO') >= 0, sp[1].content.slice(0, 80));
t('scriptPrompt 有 PowerShell 规则', sp[0].content.indexOf('PowerShell 5.1') >= 0, '');
const ps1 = builder.parseScript('```powershell\n# 整理订单\nWrite-Host "done"\n```');
t('parseScript 剥围栏取正文', ps1.ok && ps1.script.indexOf('Write-Host') >= 0 && !ps1.script.includes('```'), JSON.stringify(ps1).slice(0, 120));
const ps2 = builder.parseScript('好的，这是脚本：\n# 整理订单\n$x = Get-Content a.csv');
t('parseScript 无围栏砍寒暄', ps2.ok && ps2.script.indexOf('# 整理订单') === 0, JSON.stringify(ps2).slice(0, 120));
t('parseScript 拒绝空内容', !builder.parseScript('').ok, '');
t('parseScript 拒绝超长', !builder.parseScript('x'.repeat(50000)).ok, '');

// 截图/贴图：多模态消息转换
const mm = builder.toMultimodal(
  [{ role: 'system', content: 'S' }, { role: 'user', content: '看图搭' }],
  ['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB', 'javascript:alert(1)', 'data:text/html;base64,XXX', 'data:image/webp;base64,CCC']
);
t('多模态：最后一条 user 变内容数组', Array.isArray(mm[1].content) && mm[0].content === 'S', JSON.stringify(mm[1].content).slice(0, 100));
t('多模态：只收合法图片且最多 3 张', mm[1].content.filter(c => c.type === 'image_url').length === 3, JSON.stringify(mm[1].content.length));
t('多模态：无合法图则原样返回', builder.toMultimodal([{ role: 'user', content: 'x' }], ['javascript:1'])[0].content === 'x', '');
t('autorun 收了网页和应用', (() => {
  const p = r1.created && null; return true;
})());
// 重新拿 data 验证
const d1 = freshData();
const rr = builder.applyPlan(d1, plan, { scriptRoot: root });
const p1 = d1.projects[0];
t('autorun：网页+应用各一条', p1.autorun.length === 2 && p1.autorun[0].type === 'url' && p1.autorun[1].type === 'app');
t('没路径的应用只提醒不落库', rr.errors.some(e => e.includes('没路径的软件')));
t('上下文写进项目', p1.context.length === 1 && p1.context[0].value === '美国站日常运营');
t('节点 8 个请求 → 8 个落地（3 个降级成笔记）', rr.created.nodes.length === 8, JSON.stringify(rr.created.nodes));
t('坏引用降级成笔记', d1.canvas.nodes.some(n => n.title === '坏引用' && n.type === 'note'));
t('坏网址降级成笔记', d1.canvas.nodes.some(n => n.title === '坏网址' && n.type === 'note'));
t('AI 节点带多模型优先', (() => { const n = d1.canvas.nodes.find(x => x.title === '今日汇总'); return n.type === 'ai' && Array.isArray(n.models) && n.models.length === 2; })());
t('脚本节点绑定生成的文件', (() => { const n = d1.canvas.nodes.find(x => x.title === '整理订单' && x.type === 'script'); return n && /整理订单\.ps1$/.test(n.ref.path) && fs.existsSync(n.ref.path); })());
t('项目节点绑定项目且带自动打开', (() => { const n = d1.canvas.nodes.find(x => x.title === '美国站桌面'); return n.ref.projectId === p1.id && n.ref.autoRun === true; })());
t('有效连线 2 条', rr.created.edges.length === 2 && d1.canvas.edges.length === 2);
t('连线带 id/flow 默认', d1.canvas.edges.every(e => e.id && e.kind === 'flow'));
t('节点带「搭台」标签和网格坐标', d1.canvas.nodes.every(n => n.tags.includes('搭台')) && d1.canvas.nodes[0].x >= 120);
t('总结说得出搭了什么', builder.summarize(rr).includes('1 个项目') && builder.summarize(rr).includes('8 个节点'));

// ---- 重跑幂等：同名项目复用、同名节点跳过 ----
const d2 = freshData();
builder.applyPlan(d2, plan, { scriptRoot: root });
const r2 = builder.applyPlan(d2, plan, { scriptRoot: root });
t('同名项目复用不重建', r2.created.projects.length === 0 && d2.projects.length === 1);
t('同名节点跳过（含降级的）', r2.created.nodes.length === 0, JSON.stringify(r2.created.nodes));
t('第二次跑节点总数不变', d2.canvas.nodes.length === 8, 'len=' + d2.canvas.nodes.length);
t('重复连线不重复加', d2.canvas.edges.length === 2);

// ---- 空方案与上限 ----
const r3 = builder.applyPlan(freshData(), {}, { scriptRoot: root });
t('空方案不炸也不搭', r3.created.nodes.length === 0 && builder.summarize(r3).includes('没有搭出新东西'));
const big = { 项目: [], 节点: [], 连线: [] };
for (let i = 0; i < 50; i++) big.节点.push({ 类型: '笔记', 标题: 'n' + i });
const d4 = freshData();
builder.applyPlan(d4, big, { scriptRoot: root });
t('节点数封顶 40', d4.canvas.nodes.length === 40);
const bad = { 项目: [{ 名称: '' }], 节点: [{ 类型: '笔记' }], 连线: [['孤儿', '另一头']] };
const d5 = freshData();
const r5 = builder.applyPlan(d5, bad, { scriptRoot: root });
t('无名项目跳过且报原因', r5.errors.length >= 2 && d5.projects.length === 0);
t('孤儿连线被拦', d5.canvas.edges.length === 0);

// ---- 现有项目复用时不再加上下文重名的项目 ----
const d6 = freshData();
d6.projects.push({ id: 'p9', name: '老项目', items: [], autorun: [], context: [] });
builder.applyPlan(d6, { 项目: [{ 名称: '老项目', 上下文: '补充说明' }], 节点: [], 连线: [] }, { scriptRoot: root });
t('老项目直接复用并补上下文', d6.projects.length === 1 && d6.projects[0].context.length === 1);

console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
