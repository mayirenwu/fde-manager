const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const FAKE = {
  titles: [
    '给爸妈洗澡这件事，我拖了三年才解决',
    '装完第一晚，我妈说早该买了',
    '不是所有老人都愿意让人扶',
    '家里有老人的，浴室这一步别省',
    '花一百多改掉一个隐患'
  ],
  body: '我妈今年七十二，浴室地滑这件事我提醒了很多次，她总说扶着墙就行。\n\n后来装了免打孔折叠洗澡椅，夹上去拧紧就行，十分钟装完。\n\n用了几个真实变化：她愿意用了、收起来不占地、底部防滑不晃。\n\n这类东西不用买贵的，但一定要装得稳。买之前量一下尺寸。',
  tags: ['适老化改造', '居家安全', '老人洗澡', '适老好物', '给爸妈买什么', '浴室安全', '防滑', '居家改造'],
  cover: '爸妈的浴室\n这一步别省',
  images: ['浴室实拍：老人坐着洗澡的侧面', '细节图：防滑脚垫与卡扣特写', '收纳状态：折叠后靠墙'],
  risks: ['不要写防摔功效承诺', '不要用摔倒的惊悚画面']
};

app.whenReady().then(async () => {
  const opened = [];
  const searched = [];
  ipcMain.handle('app:open-url', (e, url) => { opened.push(String(url || '')); return { ok: true }; });
  ipcMain.handle('search:open', (e, p) => { searched.push(p || {}); return { ok: true }; });
  ipcMain.handle('ai:chat', () => ({ ok: true, model: 'mock', text: '```json\n' + JSON.stringify(FAKE) + '\n```' }));
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  // 全自动流水线需要的通道
  const exported = [];
  ipcMain.handle('ecom:export', (e, payload) => {
    exported.push(payload || {});
    return { ok: true, dir: path.join(os.tmpdir(), 'fde-pack-test'), files: (payload.files || []).map(f => f.name), failed: [] };
  });
  ipcMain.handle('ecom:show', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => ({ ok: true, groups: { chat: [], image: [{ id: 'img-mock-1', name: 'img-mock-1' }], video: [], audio: [] } }));
  ipcMain.handle('media:generate', () => ({ ok: true, taskId: 12345 }));
  ipcMain.handle('media:status', () => ({ ok: true, status: { done: true, ok: true, urls: ['https://img.example.com/1.png'], statusText: '完成' } }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1220, height: 880, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, lvl, msg) => {
    if (lvl >= 2 && !/Security Warning/.test(String(msg))) errs.push(msg);
  });

  await win.loadFile(path.join(ROOT, 'ecom.html'));
  await wait(400);
  await win.webContents.executeJavaScript('try { localStorage.clear(); } catch (e) {}');
  await win.webContents.reload();
  await wait(700);

  const base = await win.webContents.executeJavaScript(`(() => ({
    tabs: document.querySelectorAll('header .pipeline i').length,
    cats: document.querySelectorAll('#f-cat option').length,
    emptyTip: (document.querySelector('#plist') || {}).textContent || '',
    hasECOM: typeof window.ECOM === 'object',
    hasAi: typeof window.fde.aiChat,
    hasCopy: typeof window.fde.copyText
  }))()`);
  ok(base.tabs === 4, '四个步骤：选品/文案/发布/复盘');
  ok(base.cats >= 5, '类目下拉有选项');
  ok(base.hasECOM, 'ecom.js 加载成功（ECOM 可用）');
  ok(base.hasAi === 'function', 'AI 通道可用');
  ok(base.hasCopy === 'function', '复制通道可用');
  ok(/还没有品/.test(base.emptyTip), '空品池给引导文案');

  // 填一个真实品 → 保存
  const filled = await win.webContents.executeJavaScript(`(() => {
    const set = (id, v) => { const el = document.querySelector(id); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
    set('#f-name', '免打孔浴室折叠洗澡椅');
    set('#f-price', '159');
    set('#f-comm', '25');
    set('#f-comp', 'low');
    set('#f-compCount', '3200');
    set('#f-season', 'all');
    set('#f-ret', 'low');
    set('#f-cert', 'none');
    set('#f-shoot', '5');
    set('#f-note', '老人坐着洗澡，免打孔夹装，承重 150kg');
    return (document.querySelector('#scoreCard') || {}).textContent || '';
  })()`);
  ok(/推荐/.test(filled), '填完实时给出「推荐」结论');
  ok(/159/.test('159') && /\d+/.test(filled), '评分区渲染出分数');

  await win.webContents.executeJavaScript(`document.querySelector('#saveBtn').click()`);
  await wait(300);
  const saved = await win.webContents.executeJavaScript(`(() => ({
    items: document.querySelectorAll('.pitem').length,
    name: (document.querySelector('.pitem .nm') || {}).textContent || '',
    badge: (document.querySelector('.pitem .badge') || {}).textContent || ''
  }))()`);
  ok(saved.items === 1, '保存后品池出现 1 条');
  ok(/洗澡椅/.test(saved.name), '品名正确');
  ok(/推荐/.test(saved.badge), '列表显示结论徽章');

  // 生成文案
  await win.webContents.executeJavaScript(`document.querySelector('[data-step="note"]').click()`);
  await wait(200);
  await win.webContents.executeJavaScript(`document.querySelector('#genBtn').click()`);
  await wait(900);
  const note = await win.webContents.executeJavaScript(`(() => {
    const t = (document.querySelector('#noteOut') || {}).textContent || '';
    return { t: t, ok: /合规检查通过/.test(t), titles: document.querySelectorAll('#noteOut .ttl').length, body: (document.querySelector('#nBody')||{}).value || '' };
  })()`);
  ok(note.titles >= 5, '渲染出 5 条标题/素材块，实际 ' + note.titles);
  ok(/拖了三年/.test(note.t), '标题内容正确');
  ok(note.body.length > 100, '正文区有内容');
  ok(note.ok, '合规检查通过提示出现');

  // 合规拦截
  const comp = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#nBody').value = '这款是最好的，能预防疾病，加我微信';
    document.querySelector('#recheck').click();
    return new Promise(r => setTimeout(() => r((document.querySelector('#noteOut')||{}).textContent||''), 200));
  })()`);
  ok(/极限词|医疗宣称|站外导流/.test(comp), '违规文案被拦下来');
  ok(/✕/.test(comp), '违规项有醒目标记');

  // 复盘：记一条 → 出诊断
  await win.webContents.executeJavaScript(`document.querySelector('[data-step="review"]').click()`);
  await wait(200);
  const rev = await win.webContents.executeJavaScript(`(() => {
    const set = (id, v) => { document.querySelector(id).value = v; };
    set('#r-title', '给爸妈洗澡这件事');
    set('#r-imp', '3000'); set('#r-like', '200'); set('#r-fav', '150'); set('#r-cmt', '30');
    set('#r-dm', '8'); set('#r-ord', '0'); set('#r-amount', '0');
    document.querySelector('#rAdd').click();
    return new Promise(r => setTimeout(() => r((document.querySelector('#rList')||{}).textContent||''), 300));
  })()`);
  ok(/有人问没人买/.test(rev), '复盘给出「有人问没人买」诊断');
  ok(/洗澡椅/.test(rev), '记录归属到对应品');

  // 发布检查页
  await win.webContents.executeJavaScript(`document.querySelector('[data-step="post"]').click()`);
  await wait(200);
  const post = await win.webContents.executeJavaScript(`(document.querySelector('#postChk')||{}).textContent||''`);
  ok(/✓/.test(post), '发布检查有勾选项');
  ok(/站外链接|合规/.test(post) || /微信/.test(post), '发布检查包含导流检查');

  // 适老精选：一键载入 10 个已筛过的品（清空后独立测，别影响上面的用数）
  await win.webContents.executeJavaScript('try{localStorage.clear()}catch(e){}; location.reload(); 1');
  await wait(800);
  await win.webContents.executeJavaScript(`document.querySelector('#agedBtn').click(); 1`);
  await wait(400);
  const aged = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#plist .pitem')];
    return {
      n: items.length,
      names: items.map(i => (i.querySelector('.nm') || {}).textContent || ''),
      scores: items.map(i => Number((i.querySelector('.sc') || {}).textContent)),
      card: (document.querySelector('#scoreCard') || {}).textContent || ''
    };
  })()`);
  ok(aged.n === 10, '「适老精选」一键载入 10 个品（实际 ' + aged.n + '）');
  ok(aged.names.every(x => x.length > 4), '每个品都有完整品名');
  ok(aged.scores.every(s => s > 0), '每个品都有评分（' + aged.scores.join(',') + '）');
  ok(aged.scores.filter(s => s >= 85).length >= 8, '至少 8 个是高分品（≥85）');
  ok(/推荐|可试/.test(aged.card), '评分卡给出结论');
  await win.webContents.executeJavaScript(`document.querySelector('#agedBtn').click(); 1`);
  await wait(300);
  const agedAgain = await win.webContents.executeJavaScript(`document.querySelectorAll('#plist .pitem').length`);
  ok(agedAgain === 10, '重复载入不会重复加（按品名去重）');

  // 货源环节：拿货价 / 货源链接 / 找货源按钮 / 毛利展示
  const src = await win.webContents.executeJavaScript(`(() => ({
    cost: !!document.querySelector('#f-cost'),
    src: !!document.querySelector('#f-src'),
    btn: !!document.querySelector('#findSrc'),
    listText: (document.querySelector('#plist') || {}).textContent || '',
    costVal: (document.querySelector('#f-cost') || {}).value || ''
  }))()`);
  ok(src.cost && src.src && src.btn, '选品页有「拿货价 / 货源链接 / 找货源」');
  ok(Number(src.costVal) > 0, '精选品自带拿货价（' + src.costVal + '）');
  ok(/毛利¥\d+\/\d+%/.test(src.listText), '品池显示毛利与毛利率');

  await win.webContents.executeJavaScript(`document.querySelector('#findSrc').click(); 1`);
  await wait(400);
  ok(searched.length > 0 && searched[0].platform === '1688' && /马桶/.test(searched[0].keyword || ''),
    '找货源走 search:open（1688 + 中文关键词，交主进程做 GBK 编码）');
  await win.webContents.executeJavaScript(`document.querySelector('#findTaobao').click(); 1`);
  await wait(300);
  ok(searched.some(x => x.platform === 'taobao' && /马桶/.test(x.keyword || '')), '淘宝比价走 search:open（UTF-8）');

  // 导入货源表：选品工具/1688 导出 → 一次进一批
  await win.webContents.executeJavaScript(`document.querySelector('#importBtn').click(); 1`);
  await wait(200);
  const impOpen = await win.webContents.executeJavaScript(`document.querySelector('#impMask').classList.contains('on')`);
  ok(impOpen, '「导入货源」打开粘贴弹窗');
  await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('#impText');
    t.value = '品名\\t售价\\t拿货价\\t链接\\n硅胶防滑浴凳\\t128\\t45\\thttps://detail.1688.com/offer/1.html\\n床边护栏\\t168\\t60\\thttps://detail.1688.com/offer/2.html';
    document.querySelector('#impOk').click();
  })()`);
  await wait(500);
  const imp = await win.webContents.executeJavaScript(`(() => ({
    n: document.querySelectorAll('#plist .pitem').length,
    names: [...document.querySelectorAll('#plist .pitem .nm')].map(e => e.textContent),
    cost: (document.querySelector('#f-cost') || {}).value || ''
  }))()`);
  ok(imp.n === 12, '导入 2 个货源后品池 12 条（实际 ' + imp.n + '）');
  ok(imp.names.some(x => /硅胶防滑浴凳/.test(x)), '导入的品名正确进池');
  ok(imp.names.some(x => /床边护栏/.test(x)), '表头识别正确（跳过了表头行）');

  // 决策层：直接给出"先做这个"，并说明为什么是它
  const dec = await win.webContents.executeJavaScript(`(() => {
    const dc = document.querySelector('#decision .dc');
    return {
      tag: (document.querySelector('#decision .dc-tag') || {}).textContent || '',
      name: (document.querySelector('#decision .dc-name') || {}).textContent || '',
      why: document.querySelectorAll('#decision .dc-why li').length,
      grade: parseInt(((document.querySelector('#decision .dc-grade') || {}).textContent || '0'), 10) || 0,
      goBest: !!document.querySelector('#goBest'),
      star: document.querySelectorAll('#plist .pitem .star').length
    };
  })()`);
  ok(/先做这个/.test(dec.tag), '选品页顶部直接给出「先做这个」');
  ok(/落地式马桶起身扶手架/.test(dec.name), '首选是分数＋毛利综合最高的品（' + dec.name + '）');
  ok(dec.why >= 3, '给出 3 条以上"为什么是它"的理由（实际 ' + dec.why + '）');
  ok(dec.grade > 0 && dec.grade <= 100, '综合分在合理区间（' + dec.grade + '）');
  ok(dec.goBest, '有「就做它」按钮（一键定品并出文案）');
  ok(dec.star === 1, '品池里给首选打了「首选」标（' + dec.star + ' 个）');

  // 比价：同一个品导入 3 家供应商 → 自动排序并标出毛利最高
  await win.webContents.executeJavaScript(`document.querySelector('#importBtn').click(); 1`);
  await wait(200);
  await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('#impText');
    t.value = '品名\\t售价\\t拿货价\\t链接\\t供应商\\n' +
      '夹装式马桶扶手（不打孔）\\t129\\t38\\thttps://detail.1688.com/offer/a.html\\tA厂\\n' +
      '夹装式马桶扶手（不打孔）\\t129\\t42\\thttps://detail.1688.com/offer/b.html\\tB厂\\n' +
      '夹装式马桶扶手（不打孔）\\t129\\t55\\thttps://detail.1688.com/offer/c.html\\tC厂';
    document.querySelector('#impOk').click();
  })()`);
  await wait(600);
  await win.webContents.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('#plist .pitem')].find(e => /夹装式马桶扶手/.test(e.textContent));
    if (el) el.click(); return 1;
  })()`);
  await wait(400);
  const cmp = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#srcCard .srctb tbody tr')];
    return {
      shown: document.querySelector('#srcCard').style.display !== 'none',
      n: rows.length,
      rows: rows.map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
      bestFirst: rows.length ? /毛利最高/.test(rows[0].textContent) : false
    };
  })()`);
  ok(cmp.shown, '选品页出现「货源比价」卡片');
  ok(cmp.n >= 3, '同一品的 3 家货源都进比价表（实际 ' + cmp.n + ' 行）');
  ok(cmp.bestFirst, '毛利最高的一家排第一并打标（' + (cmp.rows[0] || '').slice(0, 40) + '）');
  ok(/A厂/.test(cmp.rows[0] || '') && /38/.test(cmp.rows[0] || ''), '最便宜的一家（A厂 ¥38）被识别为首选');

  const before = await win.webContents.executeJavaScript(`(document.querySelector('#f-cost')||{}).value||''`);
  await win.webContents.executeJavaScript(`document.querySelector('#srcCard [data-use="0"]').click(); 1`);
  await wait(400);
  const after = await win.webContents.executeJavaScript(`(() => ({
    cost: (document.querySelector('#f-cost')||{}).value||'',
    src: (document.querySelector('#f-src')||{}).value||'',
    used: (document.querySelector('#srcCard')||{}).textContent||''
  }))()`);
  ok(before !== '38' && after.cost === '38', '点「用这家」把拿货价改成 ¥38（' + before + ' → ' + after.cost + '）');
  ok(/offer\/a\.html/.test(after.src), '顺带把这家链接填进货源字段');
  ok(/已采用/.test(after.used), '比价表标出"已采用"');

  // 下一步：底部条永远告诉你现在该点哪
  const nb0 = await win.webContents.executeJavaScript(`(() => ({
    dots: document.querySelectorAll('#nextDots .d').length,
    btn: (document.querySelector('#nextBtn')||{}).textContent||'',
    tx: (document.querySelector('#nextTx')||{}).textContent||''
  }))()`);
  ok(nb0.dots === 5, '底部「下一步」条有 5 个步骤（选品/拿货/文案/发布/复盘）');
  ok(nb0.btn.length > 0 && nb0.tx.length > 8, '步骤条给出具体指令（' + nb0.btn + '：' + nb0.tx.slice(0, 24) + '）');

  await win.webContents.executeJavaScript(`document.querySelector('[data-step="pick"]').click(); 1`);
  await wait(200);
  await win.webContents.executeJavaScript(`document.querySelector('#goBest').click(); 1`);
  await wait(1000);
  const nb1 = await win.webContents.executeJavaScript(`(() => ({
    noteOn: document.querySelector('#v-note').classList.contains('on'),
    hasNote: /合规检查|标题/.test((document.querySelector('#noteOut')||{}).textContent||''),
    btn: (document.querySelector('#nextBtn')||{}).textContent||'',
    tx: (document.querySelector('#nextTx')||{}).textContent||'',
    done: document.querySelectorAll('#nextDots .d.done').length
  }))()`);
  ok(nb1.noteOn, '点「就做它」直接跳到文案页');
  ok(nb1.hasNote, '点「就做它」直接把文案生成出来（不用再点一次）');
  ok(nb1.done >= 1, '步骤条把「选品」标成已完成（' + nb1.done + ' 步完成）');
  ok(nb1.btn !== '就做它', '下一步自动推进到「' + nb1.btn + '」');

  // 全自动：一次跑完 选品→拿货校验→文案→合规→首图→配图→发布包
  await win.webContents.executeJavaScript(`document.querySelector('#autoBtn').click(); 1`);
  await wait(4000);
  const auto = await win.webContents.executeJavaScript(`(() => ({
    open: document.querySelector('#autoMask').classList.contains('on'),
    steps: [...document.querySelectorAll('#autoSteps .astep')].map(e => e.className.replace('astep ', '') + '｜' + e.textContent.replace(/\s+/g, ' ').trim()),
    out: (document.querySelector('#autoOut') || {}).textContent || '',
    foot: (document.querySelector('#autoFoot') || {}).textContent || '',
    coverStep: [...document.querySelectorAll('#autoSteps .astep')].map(e => e.textContent).find(t => /首图/.test(t)) || ''
  }))()`);
  ok(auto.open, '「全自动跑一轮」打开流水线面板');
  ok(auto.steps.length === 7, '流水线 7 个步骤全列出来（实际 ' + auto.steps.length + '）');
  ok(auto.steps.filter(x => /^ok/.test(x)).length >= 5, '至少 5 步自动完成（' + auto.steps.filter(x => /^ok/.test(x)).length + '）');
  ok(/1080×1440/.test(auto.coverStep), '首图自动生成（本地绘制，不耗算力）');
  ok(/打开发布页/.test(auto.foot) && /打开文件夹/.test(auto.foot), '跑完给「打开发布页 / 打开文件夹」按钮');
  ok(/跑完了|还要你动手/.test(auto.out), '收尾给出结论与剩余人工项');

  const autoPack = exported[exported.length - 1] || { files: [] };
  const packNames = (autoPack.files || []).map(f => f.name);
  ok(packNames.includes('01-标题.txt') && packNames.includes('02-正文.txt'), '发布包含标题与正文');
  ok(packNames.includes('03-首图.png'), '发布包含首图 PNG');
  ok(packNames.includes('05-发布清单.txt'), '发布包含检查清单');
  const coverFile = (autoPack.files || []).find(f => f.name === '03-首图.png') || {};
  ok(/^data:image\/png;base64,[A-Za-z0-9+/=]{1000,}/.test(coverFile.dataUrl || ''), '首图是真实 PNG（' + Math.round(((coverFile.dataUrl || '').length) / 1024) + 'KB base64）');
  const listFile = (autoPack.files || []).find(f => f.name === '05-发布清单.txt') || {};
  ok(/发布前检查/.test(listFile.text || '') && /creator\.xiaohongshu\.com/.test(listFile.text || ''), '清单里写清检查项和发布入口');

  // 文案环节：一键发布包
  await win.webContents.executeJavaScript(`document.querySelector('#plist .pitem').click(); document.querySelector('[data-step="note"]').click(); 1`);
  await wait(300);
  await win.webContents.executeJavaScript(`document.querySelector('#genBtn').click(); 1`);
  await wait(900);
  const pack = await win.webContents.executeJavaScript(`(() => ({
    btn: !!document.querySelector('#copyPack'),
    post: (document.querySelector('#postChk') || {}).textContent || ''
  }))()`);
  ok(pack.btn, '文案页有「复制发布包（标题+正文+标签）」');
  await win.webContents.executeJavaScript(`document.querySelector('#copyPack').click(); 1`);
  await wait(300);
  await win.webContents.executeJavaScript(`document.querySelector('[data-step="post"]').click(); 1`);
  await wait(200);
  const postTxt = await win.webContents.executeJavaScript(`(document.querySelector('#postChk') || {}).textContent || ''`);
  ok(/货源已落实/.test(postTxt), '发布检查包含货源与毛利校验');

  // 1688 优选货源：一键导入 → 同名品进比价 → 自动换成更优货源
  await win.webContents.executeJavaScript(`document.querySelector('#srcBtn').click(); 1`);
  await wait(500);
  const srcInfo = await win.webContents.executeJavaScript(`(() => {
    const st = window.__fdeEcom();
    const p = st.products.find(x => /落地式马桶起身扶手架/.test(x.name));
    const b = st.products.find(x => /床边起身扶手/.test(x.name));
    return {
      cost: p ? p.cost : 0,
      srcs: p ? (p.srcs || []).length : 0,
      vendors: p ? (p.srcs || []).map(s => s.vendor).join('|') : '',
      bedCost: b ? b.cost : 0,
      bestVendor: p ? p.vendor : ''
    };
  })()`);
  ok(srcInfo.srcs >= 2, '扶手架进 ' + srcInfo.srcs + ' 家 1688 货源比价');
  ok(/衡水宏仁|温州尤亮/.test(srcInfo.vendors), '调研到的真实供应商在比价表里');
  ok(srcInfo.cost === 62 && (srcInfo.bestVendor || '').indexOf('衡水宏仁') >= 0, '自动换成更优货源（拿货 88→62，毛利 60%→72%）');
  ok(srcInfo.bedCost === 25, '床边扶手自动换到华恩医疗（拿货 58→25）');

  const shot = path.join(os.tmpdir(), 'fde-ecom.png');
  await win.webContents.executeJavaScript(`document.querySelector('[data-step="pick"]').click()`);
  await wait(300);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(shot, img.toPNG());
  console.log('SHOT ' + shot);

  ok(errs.length === 0, '无渲染进程报错' + (errs.length ? '：' + errs[0] : ''));

  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' 通过 / ' + fail + ' 失败');
  app.exit(fail ? 1 : 0);
});
