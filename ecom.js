/**
 * 卖货台核心逻辑（纯函数，不依赖 Electron / DOM，可直接 node 跑）
 * 三件事：① 选品打分 ② 文案合规检查 ③ 发布复盘建议
 *
 * 设计前提：个人卖家拿不到平台的真实退货率/佣金数据，
 * 所以这里不假装能自动抓数，而是把"该看哪几个数"固定成表单，
 * 由人抄 6 个数、由规则判断，判断标准可复用、可解释、可追溯。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ECOM = api;
})(typeof self !== 'undefined' ? self : this, function () {

const VERSION = '1.0.0';

const CATS = [
  { id: 'safety', name: '居家安全 / 适老' },
  { id: 'ergo', name: '久坐改善' },
  { id: 'storage', name: '收纳整理' },
  { id: 'pet', name: '宠物功能' },
  { id: 'gift', name: '礼赠节庆' },
  { id: 'other', name: '其它' }
];

/** 六个维度，权重合计 100 */
const DIMS = [
  { k: 'season', name: '全年可卖', w: 20, hint: '强季节的品一年只能卖三个月，压货和节奏都难' },
  { k: 'comp', name: '竞争度低', w: 20, hint: '竞争决定广告成本，这是"推广便宜"的真正来源' },
  { k: 'ret', name: '退货风险低', w: 20, hint: '退货是个人卖家唯一扛不住的成本，权重必须高' },
  { k: 'price', name: '客单价合适', w: 15, hint: '79–299 元最好卖；太低没利润，太高要信任' },
  { k: 'cert', name: '无资质门槛', w: 15, hint: '要备案/3C/医疗资质的品，代发拿不到完整文件' },
  { k: 'shoot', name: '容易拍', w: 10, hint: '拍不出来的品，再好的利润也卖不动' }
];

const SEASON_OPTS = [
  { v: 'all', name: '全年', s: 5 },
  { v: 'weak', name: '弱季节（春夏 / 秋冬）', s: 3 },
  { v: 'strong', name: '强季节（只有冬天 / 只有夏天 / 节日）', s: 1 }
];
const COMP_OPTS = [
  { v: 'low', name: '低（搜出来没几个卖的）', s: 5 },
  { v: 'mid', name: '中（有几家，没品牌垄断）', s: 3 },
  { v: 'high', name: '高（全是品牌旗舰店 / 大量 9.9 包邮）', s: 1 }
];
const RET_OPTS = [
  { v: 'low', name: '低（装好就用，没有尺码 / 电子 / 易碎）', s: 5 },
  { v: 'mid', name: '中（有偏好或尺寸问题）', s: 3 },
  { v: 'high', name: '高（尺码 / 色差 / 易碎 / 电子故障）', s: 0 }
];
const CERT_OPTS = [
  { v: 'none', name: '无（普通家居 / 日用品）', s: 5 },
  { v: 'ccc', name: '需 3C（小家电 / 电池）', s: 2 },
  { v: 'reg', name: '需备案（化妆品 / 食品 / 母婴）', s: 1 },
  { v: 'med', name: '需医疗器械资质', s: 0 }
];

function optScore(opts, v, fallback) {
  const hit = opts.find(o => o.v === v);
  return hit ? hit.s : fallback;
}

function priceScore(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { s: 2, why: '还没填售价' };
  if (p >= 79 && p <= 129) return { s: 4, why: '79–129 元：决策轻，佣金够' };
  if (p > 129 && p <= 299) return { s: 5, why: '129–299 元：客单和转化最平衡' };
  if (p >= 40 && p < 79) return { s: 3, why: '40–79 元：利润薄，要靠量' };
  if (p > 299 && p <= 399) return { s: 4, why: '300–399 元：还能靠内容说服' };
  if (p > 399 && p <= 599) return { s: 3, why: '400 元以上：需要信任背书' };
  if (p > 599) return { s: 2, why: '600 元以上：个人号很难卖动' };
  return { s: 2, why: '低于 40 元：佣金不够覆盖时间' };
}

function compScore(d) {
  const byPick = optScore(COMP_OPTS, d.comp, 3);
  const n = Number(d.compCount);
  let byCount = null;
  if (Number.isFinite(n) && n > 0) {
    if (n < 5000) byCount = 5;
    else if (n < 20000) byCount = 3;
    else if (n < 50000) byCount = 2;
    else byCount = 1;
  }
  const s = byCount === null ? byPick : Math.min(byPick, byCount);
  const why = byCount === null
    ? '按你的判断：' + (COMP_OPTS.find(o => o.v === d.comp) || {}).name
    : '搜索商品数 ' + n + ' 个，' + (byCount >= 4 ? '竞争小' : byCount >= 3 ? '还有空间' : '已经打起来了');
  return { s, why };
}

/** 单维度打分 */
function dimScores(d) {
  const item = d || {};
  const out = [];
  out.push({ k: 'season', s: optScore(SEASON_OPTS, item.season, 3) });
  out.push({ k: 'comp', s: compScore(item).s, why: compScore(item).why });
  out.push({ k: 'ret', s: optScore(RET_OPTS, item.ret, 3) });
  const ps = priceScore(item.price);
  out.push({ k: 'price', s: ps.s, why: ps.why });
  out.push({ k: 'cert', s: optScore(CERT_OPTS, item.cert, 3) });
  const sh = Number(item.shoot);
  out.push({ k: 'shoot', s: Number.isFinite(sh) ? Math.max(1, Math.min(5, sh)) : 3 });
  return out;
}

/**
 * 总分 + 结论
 * 硬否决优先于分数：需医疗资质、高退货，分数再高也不能做。
 */
function score(d) {
  const item = d || {};
  const parts = dimScores(item).map(p => {
    const meta = DIMS.find(x => x.k === p.k);
    const got = Math.round((p.s / 5) * meta.w);
    return { k: p.k, name: meta.name, hint: meta.hint, score: p.s, w: meta.w, got, why: p.why || whyOf(p.k, p.s) };
  });
  const total = parts.reduce((a, b) => a + b.got, 0);

  const blocks = [];
  const warns = [];
  if (item.cert === 'med') blocks.push('需要医疗器械资质，个人代发拿不到完整资质文件，直接放弃');
  if (item.ret === 'high') blocks.push('退货风险高（尺码 / 色差 / 易碎 / 电子故障），个人卖家扛不住');
  if (item.season === 'strong') warns.push('强季节品：一年只有几个月能卖，其余时间没有现金流');
  if (item.cert === 'ccc') warns.push('需 3C：确认供应商能提供证书编号，否则被抽检就下架');
  if (item.cert === 'reg') warns.push('需备案：代发基本拿不到备案主体，别碰');
  if (Number(item.price) > 399) warns.push('客单偏高：靠内容很难建立信任，考虑先用低价关联品带首单');

  let verdict = '淘汰';
  let tone = 'bad';
  if (!blocks.length) {
    if (total >= 75) { verdict = '推荐'; tone = 'good'; }
    else if (total >= 60) { verdict = '可试'; tone = 'mid'; }
  } else {
    tone = 'bad';
  }

  const best = parts.slice().sort((a, b) => (b.got / b.w) - (a.got / a.w))[0];
  const worst = parts.slice().sort((a, b) => (a.got / a.w) - (b.got / b.w))[0];
  return { total, parts, blocks, warns, verdict, tone, best, worst };
}

function whyOf(k, s) {
  const map = {
    season: { 5: '全年都有需求', 3: '有淡旺季，但不断档', 1: '只有一季能卖' },
    ret: { 5: '装好就用，几乎不会退', 3: '有一定偏好差异', 0: '退货重灾区' },
    cert: { 5: '普通家居类目，无需任何资质', 2: '需要 3C 证书', 1: '需要备案', 0: '需要医疗资质' },
    shoot: { 5: '三秒能演示清楚', 4: '容易拍', 3: '要设计镜头', 2: '不好表现', 1: '拍不出来' },
    comp: { 5: '几乎没人做', 3: '有人在卖但没垄断', 1: '红海' }
  };
  return (map[k] && map[k][s]) || '';
}

/* ============================ 文案合规 ============================ */

const RULES = [
  {
    kind: '极限词', level: 'bad', tip: '平台会判虚假宣传，个人号轻则限流、重则处罚',
    words: ['最好', '最强', '顶级', '极致', '唯一', '100%', '百分百', '全网最低', '史上', '国家级', '绝对',
      '全网第一', '销量第一', '排名第一', '行业第一', '第一品牌', '第一名']
  },
  {
    kind: '医疗宣称', level: 'bad', tip: '适老品最容易踩：不能出现治疗、疗效类表述，改成使用场景描述',
    words: ['治疗', '治愈', '疗效', '康复', '根治', '药用', '代替药物', '消炎', '止痛', '缓解疾病', '预防疾病']
  },
  {
    kind: '站外导流', level: 'bad', tip: '小红书对导流私域处罚很重，会直接封号，成交留在站内',
    words: ['微信', 'vx', 'VX', '加V', '加我', '私信我买', '扫码', '公众号', '淘宝搜', '链接在评论']
  },
  {
    kind: '收益承诺', level: 'bad', tip: '承诺收入是最容易被投诉的一类表述',
    words: ['月入', '躺赚', '稳赚', '包赚', '保证赚钱']
  },
  {
    kind: '夸大功效', level: 'mid', tip: '改成可验证的具体描述（承重多少、几秒装好）',
    words: ['神器', '秒变', '立刻见效', '一劳永逸', '永久性', '永不松动', '永不褪色']
  }
];

/** 扫文案，返回命中的规则（同一词只报一次） */
function compliance(text) {
  const s = String(text == null ? '' : text);
  const hits = [];
  for (const r of RULES) {
    const found = [];
    for (const w of r.words) {
      if (!w) continue;
      if (s.indexOf(w) >= 0 && found.indexOf(w) < 0) found.push(w);
    }
    if (found.length) hits.push({ kind: r.kind, level: r.level, tip: r.tip, words: found });
  }
  return { ok: hits.filter(h => h.level === 'bad').length === 0, hits };
}

/* ============================ AI 输出解析 ============================ */

/** 从模型回复里抠出 JSON（可能被 ```json 包裹、可能前后带解释） */
function parseJSON(text) {
  const raw = String(text == null ? '' : text);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let body = fenced ? fenced[1] : raw;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  body = body.slice(a, b + 1);
  try { return JSON.parse(body); } catch (e) { return null; }
}

function normalizeNotes(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const arr = (v, n) => (Array.isArray(v) ? v : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, n);
  const body = String(o.body || '').trim();
  return {
    titles: arr(o.titles, 5),
    body,
    tags: arr(o.tags, 12).map(t => t.replace(/^#+/, '')),
    cover: String(o.cover || '').trim(),
    images: arr(o.images, 5),
    risks: arr(o.risks, 5),
    empty: !body && !arr(o.titles, 5).length
  };
}

/* ============================ 复盘建议 ============================ */

/**
 * 单条笔记的诊断。指标口径：
 * 曝光(impressions) → 点赞+收藏+评论 视为互动；私信(dm) 视为高意向；成交(orders)。
 */
function advice(row) {
  const r = row || {};
  const imp = Number(r.imp) || 0;
  const like = Number(r.like) || 0;
  const fav = Number(r.fav) || 0;
  const cmt = Number(r.cmt) || 0;
  const dm = Number(r.dm) || 0;
  const ord = Number(r.ord) || 0;
  const inter = like + fav + cmt;
  const rate = imp > 0 ? (inter / imp) * 100 : 0;

  if (imp > 0 && imp < 500) {
    return { level: 'flow', text: '曝光不足（' + imp + '）：封面或选题没进流量池。换首图重发，不要改正文。' };
  }
  if (imp >= 500 && rate < 2) {
    return { level: 'content', text: '点进来不看（互动率 ' + rate.toFixed(1) + '%）：前两句没抓住人。把第一句改成具体场景，别写卖点。' };
  }
  if (dm > 0 && ord === 0) {
    return { level: 'trust', text: '有人问没人买（私信 ' + dm + ' 成交 0）：价格或信任问题。补真实使用细节、承重/尺寸/安装方式。' };
  }
  if (ord > 0 && dm / Math.max(1, ord) > 5) {
    return { level: 'info', text: '问得多买得少（' + dm + ' 问 ' + ord + ' 单）：详情信息缺项。把高频问题一次写进正文和首图。' };
  }
  if (ord > 0) {
    return { level: 'win', text: '有效（' + ord + ' 单）：同一角度再拍 2 条，换人群不换品。' };
  }
  if (imp === 0) {
    return { level: 'pending', text: '还没填数据。发布 24 小时后再记，前 2 小时的数据不作数。' };
  }
  return { level: 'content', text: '有曝光没互动：换选题角度，别加投流。' };
}

/** 汇总：哪个品值得继续，哪个该停 */
function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bySku = {};
  for (const r of list) {
    const k = String(r.product || '未命名');
    if (!bySku[k]) bySku[k] = { product: k, posts: 0, imp: 0, inter: 0, dm: 0, ord: 0, amount: 0 };
    const g = bySku[k];
    g.posts += 1;
    g.imp += Number(r.imp) || 0;
    g.inter += (Number(r.like) || 0) + (Number(r.fav) || 0) + (Number(r.cmt) || 0);
    g.dm += Number(r.dm) || 0;
    g.ord += Number(r.ord) || 0;
    g.amount += Number(r.amount) || 0;
  }
  const out = Object.keys(bySku).map(k => {
    const g = bySku[k];
    const rate = g.imp > 0 ? (g.inter / g.imp) * 100 : 0;
    const cvr = g.imp > 0 ? (g.ord / g.imp) * 100 : 0;
    let call = '继续观察';
    if (g.ord >= 3) call = '加量：同品换角度，扩大人群';
    else if (g.dm > 0 && g.ord === 0) call = '补信任：加真实细节与对比，别急着换品';
    else if (g.imp >= 1500 && g.inter > 0 && rate < 2) call = '换内容：选题不对，品可能没问题';
    else if (g.imp >= 1500 && g.inter === 0) call = '换品：给了曝光也没人点';
    return Object.assign({}, g, { rate, cvr, call });
  });
  out.sort((a, b) => b.ord - a.ord || b.rate - a.rate);
  return out;
}

/* ============================ 决策层：选哪个品 / 用哪家货 / 下一步做什么 ============================ */

/** 毛利：拿货价 > 0 且低于售价才算数 */
function margin(p) {
  const x = p || {};
  const price = Number(x.price) || 0;
  const cost = Number(x.cost) || 0;
  if (!(price > 0) || !(cost > 0) || cost >= price) return { price, cost, profit: 0, rate: 0, ok: false };
  const profit = price - cost;
  return { price, cost, profit, rate: profit / price, ok: true };
}

/** 一个品所有的货源候选：当前采用的 + 导入进来的比价表（同价视为同一家，避免表格噪音） */
function sourcesOf(p) {
  const x = p || {};
  const price0 = Number(x.price) || 0;
  const list = [];
  if (Number(x.cost) > 0) {
    list.push({ vendor: x.vendor || '当前采用', price: price0, cost: Number(x.cost), src: x.src || '', current: true });
  }
  for (const s of (Array.isArray(x.srcs) ? x.srcs : [])) {
    if (!s || !(Number(s.cost) > 0)) continue;
    const one = {
      vendor: String(s.vendor || '未命名供应商'),
      price: Number(s.price) > 0 ? Number(s.price) : price0,
      cost: Number(s.cost),
      src: String(s.src || '')
    };
    if (list.some(l => l.cost === one.cost)) continue;
    list.push(one);
  }
  return list;
}

/** 同一个品的多家货源按毛利率排序，给出该用哪家 */
function compareSources(p) {
  const x = p || {};
  const price0 = Number(x.price) || 0;
  const list = sourcesOf(x).map(s => {
    const usePrice = s.price > 0 ? s.price : price0;
    const profit = usePrice - s.cost;
    return Object.assign({}, s, {
      usePrice,
      profit,
      rate: usePrice > 0 ? profit / usePrice : 0
    });
  }).sort((a, b) => b.rate - a.rate || a.cost - b.cost);
  const best = list[0] || null;
  return { list, best, delta: list.length > 1 ? Math.round((list[0].rate - list[list.length - 1].rate) * 100) : 0 };
}

/**
 * 在一池品里挑"现在最该做的那一个"。
 * 逻辑：可做(不被硬否决) → 总分 80% + 毛利 20% → 取第一。
 * 毛利没填的品会被压到后面（数据不全不该排第一），并在理由里直说。
 */
function pickBest(products) {
  const list = Array.isArray(products) ? products.filter(p => p && String(p.name || '').trim()) : [];
  if (!list.length) return { best: null, ranked: [], skip: [] };

  const ranked = list.map(p => {
    const s = score(p);
    const m = margin(p);
    const marginPts = m.ok ? Math.min(100, (m.rate / 0.6) * 100) : 0;
    const grade = s.blocks.length ? 0 : Math.round(s.total * 0.8 + marginPts * 0.2);
    const why = [];
    if (!s.blocks.length) {
      const top = s.parts.slice().sort((a, b) => (b.got / b.w) - (a.got / a.w))[0];
      why.push('总分 ' + s.total + '（' + s.verdict + '），最强的是' + top.name);
      const c = s.parts.find(x => x.k === 'comp');
      if (c && c.score >= 5) why.push('竞争小：搜同款只有 ' + (p.compCount || '很少') + ' 个在卖，广告不用抢');
      if (m.ok) why.push('毛利 ¥' + m.profit + '／' + Math.round(m.rate * 100) + '%（拿货 ¥' + m.cost + ' → 卖 ¥' + m.price + '）');
      else why.push('还没填拿货价——第一步就是去 1688 拿一家，填回来才知道赚不赚');
      if (p.note) why.push('卖点已经能写成场景，今天就能出笔记');
    }
    return { p, s, m, grade, why };
  }).sort((a, b) => b.grade - a.grade);

  const okList = ranked.filter(r => !r.s.blocks.length);
  const skip = ranked.filter(r => r.s.blocks.length).slice(0, 3).map(r => ({ name: r.p.name, reason: r.s.blocks[0] }))
    .concat(ranked.filter(r => !r.s.blocks.length && r.s.total < 60).slice(0, 2)
      .map(r => ({ name: r.p.name, reason: '分数只有 ' + r.s.total + '（' + r.s.verdict + '），先不动' })));

  const best = okList[0] || null;
  return { best: best ? best.p : null, bestRow: best, ranked, skip, top: okList.slice(0, 3) };
}

/** 发布前检查项（界面和"下一步"共用一套判定，避免两处口径不一致） */
function checks(p, note) {
  const x = p || {};
  const n = note || null;
  const m = margin(x);
  const cc = n ? compliance((n.body || '') + '\n' + (n.titles || []).join('\n') + '\n' + (n.cover || '')) : { ok: false };
  return [
    { t: '标题 12–20 字，前 6 个字带场景', ok: !!(n && (n.titles || []).length > 0) },
    { t: '首图有字，一屏能读清（不超过 18 字）', ok: !!(n && n.cover) },
    { t: '正文第一句是具体场景，不是卖点罗列', ok: !!(n && n.body) },
    { t: '正文里有 3 个可验证细节（尺寸 / 承重 / 安装）', ok: !!(n && n.body && n.body.length > 200) },
    { t: '没有留微信 / 二维码 / 站外链接', ok: !!cc.ok },
    { t: '标签 8–10 个，混合大词与长尾', ok: !!(n && (n.tags || []).length >= 8) },
    { t: '货源已落实：填了拿货价，毛利 ≥ 40%', ok: !!(m.ok && m.rate >= 0.4 && (x.src || (Array.isArray(x.srcs) && x.srcs.length))) },
    { t: '发布时段：早 7–9 点或晚 20–22 点', ok: true }
  ];
}

/** 五步流水线的定义（选品和拿货都在「选品」页，所以 tab 会重复） */
const STEPS = [
  { key: 'pick', label: '选品', tab: 'pick' },
  { key: 'source', label: '拿货', tab: 'pick' },
  { key: 'note', label: '文案', tab: 'note' },
  { key: 'post', label: '发布', tab: 'post' },
  { key: 'review', label: '复盘', tab: 'review' }
];

/**
 * 现在该做哪一步。返回每步是否完成 + 第一个未完步 + 一句人话指令 + 按钮文案。
 * 这是"下几步"的唯一事实来源：界面只负责把结果画出来。
 */
function nextStep(opts) {
  const o = opts || {};
  const p = o.product || null;
  const n = o.note || null;
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const m = margin(p);
  const cks = p ? checks(p, n) : [];
  const failed = cks.filter(c => !c.ok);
  const hasSrc = !!(p && (p.src || (Array.isArray(p.srcs) && p.srcs.length)));

  const done = {
    pick: !!(p && o.picked && String(o.picked) === String(p.id)),
    source: !!(p && m.ok && m.rate >= 0.4 && hasSrc),
    note: !!(n && String(n.body || '').length >= 30),
    post: !!(n && cks.length && failed.length === 0),
    review: !!(p && rows.some(r => String(r.product || '') === String(p.name || '')))
  };
  // 还没正式选定品之前，后面的步骤一律算未完成：这时候该做的只有"先定做哪个"
  if (!done.pick) { done.source = false; done.note = false; done.post = false; done.review = false; }

  let todo = '';
  if (!done.pick) todo = '还没定做哪个。上面已经按分数＋毛利排好了「先做这个」，点一下就定';
  else if (!m.ok) todo = '「' + p.name + '」还没有拿货价：去 1688 挑一家，把拿货价和链接填回来';
  else if (!hasSrc) todo = '拿货价有了但没留货源链接：填上链接，以后补货不用重新找';
  else if (m.rate < 0.4) todo = '毛利只有 ' + Math.round(m.rate * 100) + '%，低于 40%：换一家供应商，或者提价再算一次';
  else if (!done.note) todo = '点「生成文案」，出 5 条标题＋正文＋首图＋标签（本地合规检查同步跑）';
  else if (!done.post) todo = '发布检查还有 ' + failed.length + ' 项没过：' + failed[0].t;
  else if (!done.review) todo = '可以发了。发完 24 小时回来记一条数据，系统判断继续还是换品';
  else todo = '这一轮走完了。看第 4 步的结论：加量 / 换内容 / 换品，然后回到第 1 步挑下一个';

  const steps = STEPS.map(s => Object.assign({}, s, { done: !!done[s.key] }));
  const firstUndone = steps.findIndex(s => !s.done);
  const idx = firstUndone < 0 ? steps.length - 1 : firstUndone;
  const cta = firstUndone < 0 ? '看复盘结论' : (['就做它', '填拿货价', '生成文案', '过发布检查', '记一条数据'][idx] || '下一步');
  return { steps, done, idx, step: steps[idx], todo, cta, allDone: firstUndone < 0, failed };
}

/* ============================ 生成提示词 ============================ */

/** 给模型的指令：只出 JSON，方便直接渲染 */
function notesPrompt(p) {
  const x = p || {};
  return [
    '你是小红书「居家 / 适老」类目的内容操盘手，写过很多真实成交的笔记。',
    '现在要为一个品写 1 篇笔记。要求：第一人称、口语、具体到场景，不夸张、不喊口号。',
    '',
    '产品：' + (x.name || ''),
    '类目：' + (CATS.find(c => c.id === x.cat) || {}).name || '',
    '售价：' + (x.price || '') + ' 元',
    '已确认的卖点 / 使用场景：' + (x.note || '（没填，按类目常识写）'),
    '目标读者：' + (x.audience || '家里有老人的 30–45 岁子女'),
    '',
    '只输出 JSON，不要任何解释，不要 markdown 代码块以外的文字：',
    JSON.stringify({
      titles: ['5 条标题，每条 12–20 字，靠具体场景制造好奇，禁止极限词'],
      body: '正文 280–450 字。开头第一句必须是具体场景（时间/地点/动作），中间写 3 个真实使用细节（尺寸、安装、承重这类可验证的信息），结尾一句轻 CTA，不催单、不提价格倒计时。',
      tags: ['8–10 个标签，不带井号，混合大词和长尾词'],
      cover: '首图文案，18 字以内，可用 \\n 分成两行',
      images: ['3 条配图拍摄提示词，中文，写清画面和构图'],
      risks: ['2–3 条这个品在小红书容易引起争议或限流的点']
    }, null, 2)
  ].join('\n');
}

return {
  VERSION, CATS, DIMS,
  SEASON_OPTS, COMP_OPTS, RET_OPTS, CERT_OPTS,
  priceScore, compScore, dimScores, score,
  compliance, parseJSON, normalizeNotes,
  advice, summarize, notesPrompt,
  margin, sourcesOf, compareSources, pickBest, checks, nextStep, STEPS
};
});
