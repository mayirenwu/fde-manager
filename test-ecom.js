const E = require('./ecom.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

console.log('== 选品打分 ==');

// 1. 典型合格品：免打孔洗澡椅
const chair = {
  name: '免打孔浴室折叠洗澡椅', cat: 'safety', price: 159, comm: 25,
  comp: 'low', compCount: 3200, season: 'all', ret: 'low', cert: 'none', shoot: 5,
  note: '老人坐着洗澡，免打孔夹装，承重 150kg'
};
const s1 = E.score(chair);
ok(s1.total >= 75, '洗澡椅应高分，实际 ' + s1.total);
eq(s1.verdict, '推荐', '洗澡椅结论');
eq(s1.blocks.length, 0, '洗澡椅无硬否决');
ok(s1.parts.length === 6, '六个维度齐全');
ok(s1.best && s1.worst, '给出最强/最弱点');

// 2. 高退货 = 硬否决，分数再高也不能做
const dress = Object.assign({}, chair, { name: '女装', price: 139, ret: 'high', shoot: 5, comp: 'low' });
const s2 = E.score(dress);
eq(s2.verdict, '淘汰', '高退货直接淘汰');
ok(s2.blocks.length > 0, '高退货给出否决理由');

// 3. 需医疗资质 = 硬否决
const med = Object.assign({}, chair, { name: '理疗仪', cert: 'med' });
const s3 = E.score(med);
eq(s3.verdict, '淘汰', '医疗资质直接淘汰');

// 4. 强季节 = 警告但不否决
const knee = Object.assign({}, chair, { name: '护膝', season: 'strong', price: 99 });
const s4 = E.score(knee);
ok(s4.warns.some(w => w.indexOf('季节') >= 0), '强季节给出警告');
ok(s4.total < s1.total, '强季节分数低于全年品（' + s4.total + ' < ' + s1.total + '）');

// 5. 竞争商品数覆盖人工判断：说"低"但实际 8 万个，要按数据降分
const lie = Object.assign({}, chair, { comp: 'low', compCount: 80000 });
const s5 = E.score(lie);
const compPart = s5.parts.find(p => p.k === 'comp');
ok(compPart.score <= 1, '商品数 8 万时竞争分应降到 1，实际 ' + compPart.score);

// 6. 价格分档
ok(E.priceScore(159).s === 5, '159 元最高档');
ok(E.priceScore(99).s === 4, '99 元次高档');
ok(E.priceScore(19).s === 2, '19 元低分');
ok(E.priceScore(899).s === 2, '899 元低分');
ok(E.priceScore('').s === 2, '没填价格给低分');

// 7. 空品名也能算，不崩
const s7 = E.score({});
ok(s7.total >= 0 && s7.total <= 100, '空数据不崩，总分在 0-100');

console.log('== 合规检查 ==');

const c1 = E.compliance('这款是最好的洗澡椅，绝对安全');
ok(!c1.ok, '极限词应判不通过');
ok(c1.hits[0].words.indexOf('最好') >= 0, '命中"最好"');

const c2 = E.compliance('可以帮助康复，预防疾病');
ok(!c2.ok, '医疗宣称应判不通过');

const c3 = E.compliance('想要的加我微信');
ok(!c3.ok, '站外导流应判不通过');

const c4 = E.compliance('月入三千不是梦');
ok(!c4.ok, '收益承诺应判不通过');

const c5 = E.compliance('我妈今年七十二，浴室地滑，装了个折叠椅，承重 150 公斤，夹装不用打孔');
ok(c5.ok, '正常文案应通过');
eq(c5.hits.length, 0, '正常文案无命中');

const c6 = E.compliance('最近给爸妈买的，最后选了这款');
ok(c6.ok, '"最近/最后"不应误判为极限词');

const c7 = E.compliance('装完第一晚，我妈说早该买了');
ok(c7.ok, '"第一晚"不是极限词，不能误伤日常表述');

const c8 = E.compliance('销量第一的洗澡椅');
ok(!c8.ok, '"销量第一"仍要拦住');
ok(E.compliance('').ok, '空文本通过');
ok(E.compliance(null).ok, 'null 不崩');

console.log('== AI 输出解析 ==');

const wrapped = '好的，这是文案：\n```json\n{"titles":["A","B"],"body":"正文","tags":["#适老","居家"],"cover":"首图"}\n```\n希望有用';
const p1 = E.parseJSON(wrapped);
ok(p1 && p1.body === '正文', '能从代码块里抠出 JSON');

const n1 = E.normalizeNotes(p1);
eq(n1.tags, ['适老', '居家'], '标签去掉井号');
eq(n1.titles.length, 2, '标题保留');
ok(!n1.empty, '非空');

const n2 = E.normalizeNotes({ titles: 'not-array', body: '' });
ok(n2.empty, '结构错误判为空');
ok(E.parseJSON('完全不是 JSON') === null, '非法 JSON 返回 null 不抛错');

const n3 = E.normalizeNotes({ titles: ['a'], tags: Array.from({ length: 30 }, (_, i) => 't' + i), images: ['x'] });
ok(n3.tags.length <= 12, '标签最多 12 个');

console.log('== 复盘诊断 ==');

const a1 = E.advice({ imp: 200, like: 5, fav: 3, cmt: 1 });
eq(a1.level, 'flow', '曝光低于 500 判流量问题');

const a2 = E.advice({ imp: 3000, like: 10, fav: 5, cmt: 2 });
eq(a2.level, 'content', '有曝光低互动判内容问题');

const a3 = E.advice({ imp: 3000, like: 200, fav: 150, cmt: 30, dm: 8, ord: 0 });
eq(a3.level, 'trust', '有人问没成交判信任问题');

const a4 = E.advice({ imp: 3000, like: 200, fav: 150, cmt: 30, dm: 40, ord: 3 });
eq(a4.level, 'info', '问得多买得少判信息缺项');

const a5 = E.advice({ imp: 3000, like: 200, fav: 150, cmt: 30, dm: 5, ord: 4 });
eq(a5.level, 'win', '有成交判有效');

const a6 = E.advice({});
eq(a6.level, 'pending', '没数据判待观察');

console.log('== 汇总 ==');

const rows = [
  { product: '洗澡椅', imp: 5000, like: 300, fav: 200, cmt: 40, dm: 10, ord: 6, amount: 950 },
  { product: '洗澡椅', imp: 4000, like: 200, fav: 120, cmt: 20, dm: 6, ord: 4, amount: 640 },
  { product: '防滑垫', imp: 6000, like: 20, fav: 5, cmt: 1, dm: 0, ord: 0, amount: 0 },
  { product: '扶手', imp: 2000, like: 80, fav: 40, cmt: 8, dm: 5, ord: 0, amount: 0 }
];
const sum = E.summarize(rows);
eq(sum[0].product, '洗澡椅', '有成交的排第一');
ok(sum[0].call.indexOf('加量') >= 0, '成交多判加量');
const slip = sum.find(x => x.product === '防滑垫');
ok(slip.call.indexOf('换') >= 0, '高曝光零互动判换品/换内容：' + slip.call);
const rail = sum.find(x => x.product === '扶手');
ok(rail.call.indexOf('补信任') >= 0, '有问无单判补信任');
ok(sum.length === 3, '按品聚合，3 个品');
ok(Math.abs(sum[0].rate - (5000 + 4000 > 0 ? ((300 + 200 + 40 + 200 + 120 + 20) / 9000 * 100) : 0)) < 0.01, '互动率计算正确');

console.log('== 提示词 ==');
const pr = E.notesPrompt(chair);
ok(pr.indexOf('洗澡椅') >= 0, '提示词含品名');
ok(pr.indexOf('JSON') >= 0, '要求结构化输出');
ok(pr.indexOf('300–45') < 0 && pr.indexOf('280') >= 0, '给了字数约束');

console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
