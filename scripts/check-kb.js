/**
 * 知识库界面检查（真实 Electron + 真实 store + 真实文件夹扫描）
 * 覆盖：空状态 → 建 6 个基础库 → 导入文件夹（含 docx/不支持类型）→ 文档列表
 *      → 检索高亮 → 问答引用 → 详情 → 移除文档
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const kb = require('../kb');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-check-'));
app.setPath('userData', path.join(TMP, 'userdata'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' | ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小 zip，用来造 docx 夹具 */
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const lhBuf = Buffer.concat([lh, nameBuf, comp]);
    locals.push(lhBuf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += lhBuf.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

/* ---------- 造一个"现有文件夹"：层级 + 各种格式 + 干扰项 ---------- */
const DIR = path.join(TMP, '资料');
fs.mkdirSync(path.join(DIR, '浴室改造'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(DIR, '浴室改造', '方案.md'),
  '# 浴室防滑改造方案\n\n针对 70 岁以上老人：防滑垫 45 元、折叠洗澡椅 139 元、马桶扶手 129 元。\n\n施工顺序：先做防滑，再装扶手，最后加夜灯。', 'utf8');
fs.writeFileSync(path.join(DIR, '浴室改造', '客户访谈.md'),
  '# 客户张阿姨访谈\n\n72 岁独居，夜里起夜摸黑摔倒过一次。预算 500 元以内，最在意不破坏瓷砖。', 'utf8');
fs.writeFileSync(path.join(DIR, '报价.csv'),
  '品名,售价,拿货价\n洗澡椅,139,33\n马桶扶手,129,19\n', 'utf8');
fs.writeFileSync(path.join(DIR, '旧文档.docx'),
  makeZip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>适老改造交付清单：防滑垫、扶手、夜灯</w:t></w:r></w:p></w:body></w:document>' }]));
fs.writeFileSync(path.join(DIR, 'node_modules', 'skip.md'), '# 不该被导入\n\n依赖目录里的文件');
fs.writeFileSync(path.join(DIR, '扫描件.pdf'), Buffer.from('%PDF-1.4 fake'));
fs.writeFileSync(path.join(DIR, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const store = kb.createStore(path.join(TMP, 'kbroot'));
const opened = [];

app.whenReady().then(async () => {
  /* ---------- 用真实 store 实现 IPC（界面走完整链路） ---------- */
  ipcMain.handle('kb:load', () => {
    const st = store.load();
    return { ok: true, libs: st.libs, docs: st.docs, kinds: kb.KINDS, dir: store.root, stats: store.stats() };
  });
  ipcMain.handle('kb:save', (e, patch) => {
    const st = store.load();
    if (patch && Array.isArray(patch.libs)) st.libs = patch.libs;
    if (patch && Array.isArray(patch.docs)) st.docs = patch.docs;
    // 兼容主进程语义：库的 count 按实际文档数校准
    st.libs.forEach((l) => { l.count = st.docs.filter((d) => d.libId === l.id).length; });
    store.save(st);
    return { ok: true };
  });
  ipcMain.handle('kb:pick-dir', () => ({ ok: true, dir: DIR }));
  ipcMain.handle('kb:pick-files', () => ({ ok: false, canceled: true }));
  ipcMain.handle('kb:scan', (e, payload) => {
    const r = kb.scanDir(payload.dir);
    const st = store.load();
    const seen = new Set(st.docs.map((d) => d.path + '|' + d.size));
    r.files = r.files.map((f) => Object.assign(f, { exist: seen.has(f.path + '|' + f.size) }));
    return Object.assign({ ok: true }, r);
  });
  ipcMain.handle('kb:add-docs', (e, payload) => store.addDocs(payload.libId, payload.files));
  ipcMain.handle('kb:search', (e, payload) => {
    const hits = store.search(payload.q, payload.libId || '', 20);
    return { ok: true, hits, total: hits.length };
  });
  ipcMain.handle('kb:ask', (e, payload) => {
    const hits = store.search(payload.q, payload.libId || '', 6);
    if (!hits.length) return { ok: true, answer: '知识库里没找到相关内容。', cites: [], hits: [] };
    return {
      ok: true,
      answer: '先做防滑，再装扶手 [资料 1]；客户预算 500 元以内 [资料 2]。',
      model: 'mock-model',
      cites: [{ n: 1, docId: hits[0].docId, title: hits[0].title }],
      hits: hits.map((h) => ({ title: h.title, snippet: h.snippet, score: h.score, docId: h.docId }))
    };
  });
  ipcMain.handle('kb:doc-text', (e, id) => {
    const d = store.load().docs.find((x) => x.id === id);
    if (!d) return { ok: false, error: '没有这篇' };
    return { ok: true, doc: d, text: store.textOf(d) };
  });
  ipcMain.handle('kb:doc-remove', (e, p) => store.removeDocs(p.ids));
  ipcMain.handle('kb:reveal', (e, p) => { opened.push(p); return { ok: true }; });

  const win = new BrowserWindow({
    width: 1240, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 3 && !/Security Warning|Electron Security/.test(msg)) errors.push(msg);
  });
  win.webContents.on('render-process-gone', () => errors.push('renderer gone'));
  await win.loadFile(path.join(__dirname, '..', 'kb.html'));
  await wait(600);

  const ev = (js) => win.webContents.executeJavaScript(js);

  /* 1. 空状态 */
  const empty = await ev(`(() => ({
    libs: document.querySelectorAll('#libList .lib').length,
    hint: (document.querySelector('#docList') || {}).textContent || '',
    body: (document.querySelector('#detailBody') || {}).textContent || ''
  }))()`);
  ok(empty.libs === 1 && /全部文档/.test((await ev(`document.querySelector('#libList').textContent`))), '左栏初始只有「全部文档」');
  ok(/导入文件夹/.test(empty.body) || /现有文件夹/.test(empty.body), '详情区引导用户导入现有文件夹');

  /* 2. 建 6 个基础库 */
  await ev(`document.querySelector('#seedLibsBtn').click(); 1`);
  await wait(500);
  const libs = await ev(`(() => ({
    n: window.__fdeKb().libs.length,
    names: window.__fdeKb().libs.map(l => l.name).join('/'),
    items: document.querySelectorAll('#libList .lib').length
  }))()`);
  ok(libs.n === 6, '一键建 6 个基础库（实际 ' + libs.n + '）', libs.names);
  ok(/方案库/.test(libs.names) && /客户库/.test(libs.names) && /合规库/.test(libs.names), '库按用途命名', libs.names);

  /* 3. 导入文件夹 */
  await ev(`document.querySelector('#impDirBtn').click(); 1`);
  await wait(600);
  const dlg = await ev(`(() => ({
    open: document.querySelector('#impMask').classList.contains('on'),
    stat: (document.querySelector('#impStat') || {}).textContent || '',
    libOpts: document.querySelectorAll('#impLib option').length,
    title: (document.querySelector('#impTitle') || {}).textContent || ''
  }))()`);
  ok(dlg.open, '「导入文件夹」弹出确认框');
  ok(/找到\s*4\s*个可导入文档/.test(dlg.stat), '扫描到 4 个可导入文档（跳过 node_modules / png / pdf）', dlg.stat.replace(/\s+/g, ' ').slice(0, 80));
  ok(dlg.libOpts >= 6, '导入时能选目标库（' + dlg.libOpts + ' 个）');

  await ev(`(() => { document.querySelector('#impLib').value = window.__fdeKb().libs.find(l => /方案/.test(l.name)).id; document.querySelector('#impOk').click(); return 1; })()`);
  await wait(1800);
  const after = await ev(`(() => ({
    n: window.__fdeKb().docs.length,
    titles: window.__fdeKb().docs.map(d => d.title).join(' | '),
    names: window.__fdeKb().docs.map(d => d.name).join(' | '),
    list: document.querySelectorAll('#docList .doc').length,
    chars: window.__fdeKb().docs.reduce((a, d) => a + d.chars, 0)
  }))()`);
  ok(after.n === 4, '导入 4 篇进库（实际 ' + after.n + '）', after.names);
  ok(/防滑改造方案/.test(after.titles), 'md 标题被抽成文档标题', after.titles);
  const dx = store.load().docs.find((d) => /旧文档/.test(d.name)) || {};
  ok(/交付清单/.test(store.textOf(dx)), 'docx 正文被抽出（含"交付清单"）', String(store.textOf(dx)).slice(0, 30));
  ok(after.chars > 150, '正文字数合理（合计 ' + after.chars + '）');
  ok(after.list === 4, '中栏列出 4 篇');

  /* 4. 重新扫描应识别"已在库" */
  await ev(`document.querySelector('#impMask').classList.remove('on'); document.querySelector('#impDirBtn').click(); 1`);
  await wait(600);
  const again = await ev(`(document.querySelector('#impStat') || {}).textContent || ''`);
  ok(/新增\s*0/.test(again), '再扫同一目录：新增 0（已在库的都标出来了）', again.replace(/\s+/g, ' ').slice(0, 60));
  await ev(`document.querySelector('#impMask').classList.remove('on'); 1`);

  /* 5. 检索 */
  await ev(`(() => { document.querySelector('[data-view="search"]').click(); const i = document.querySelector('#qInput'); i.value = '防滑'; document.querySelector('#qBtn').click(); return 1; })()`);
  await wait(700);
  const sr = await ev(`(() => ({
    hits: document.querySelectorAll('#qResults .hit').length,
    first: (document.querySelector('#qResults .hit b') || {}).textContent || '',
    marks: document.querySelectorAll('#qResults mark').length,
    text: (document.querySelector('#qResults') || {}).textContent || ''
  }))()`);
  ok(sr.hits >= 1, '搜索「防滑」命中 ' + sr.hits + ' 篇');
  ok(/防滑/.test(sr.first), '最相关的是改造方案', sr.first);
  ok(sr.marks >= 1, '命中词高亮（' + sr.marks + ' 处）');

  /* 6. 问答 */
  await ev(`(() => { document.querySelector('[data-view="ask"]').click(); document.querySelector('#aInput').value = '浴室改造怎么排顺序'; document.querySelector('#aBtn').click(); return 1; })()`);
  await wait(900);
  const ask = await ev(`(() => ({
    ans: (document.querySelector('#aOut .ans') || {}).textContent || '',
    cites: document.querySelectorAll('#aOut .cite').length,
    srcs: document.querySelectorAll('#aOut .srclist .s').length
  }))()`);
  ok(/先做防滑/.test(ask.ans), '问答返回答案', ask.ans.slice(0, 40));
  ok(ask.cites >= 1, '答案里 [资料 n] 变成可点引用（' + ask.cites + ' 个）');
  ok(ask.srcs >= 1, '列出依据来源（' + ask.srcs + ' 条）');

  /* 7. 点开详情 */
  await ev(`(() => { document.querySelector('[data-view="docs"]').click(); const el = [...document.querySelectorAll('#docList .doc')].find(e => /浴室防滑改造方案/.test(e.textContent)); (el || document.querySelector('#docList .doc')).click(); return 1; })()`);
  await wait(500);
  const detail = await ev(`(() => ({
    title: (document.querySelector('#detailTitle') || {}).textContent || '',
    text: (document.querySelector('#dtext') || {}).textContent || '',
    summary: (document.querySelector('.summary') || {}).textContent || '',
    reveal: !!document.querySelector('#revealBtn')
  }))()`);
  ok(detail.title && detail.title.length > 2, '详情标题：' + detail.title);
  ok(detail.text.length > 40, '正文预览可读（' + detail.text.length + ' 字）');
  ok(detail.summary.length > 3, '有自动摘要');
  ok(detail.reveal, '有「在文件夹中显示」按钮');

  /* 8. 移除一篇 */
  await ev(`document.querySelector('#delDocBtn').click(); 1`);
  await wait(300);
  await ev(`document.querySelector('#askYes').click(); 1`);
  await wait(600);
  const removed = await ev(`window.__fdeKb().docs.length`);
  ok(removed === 3, '从库里移除一篇后剩 3 篇（实际 ' + removed + '）');

  /* 9. 持久化：重启（重新 load）后还在 */
  const st = store.load();
  ok(st.docs.length === 3 && st.libs.length === 6, '数据落盘：重新读取仍有 6 库 / 3 篇');
  ok(fs.existsSync(path.join(store.root, 'kb-data.json')), '元数据文件存在 kb-data.json');
  const textFiles = fs.readdirSync(path.join(store.root, 'text')).filter((f) => f.endsWith('.txt'));
  ok(textFiles.length === 3, '正文一篇一个 txt（' + textFiles.length + ' 个）');

  ok(errors.length === 0, '无渲染进程报错' + (errors.length ? '：' + errors.slice(0, 2).join(' / ') : ''));

  const shot = path.join(os.tmpdir(), 'fde-kb.png');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(shot, img.toPNG());
  console.log('SHOT ' + shot);
  console.log('\n' + (fails.length ? 'FAIL  ' + fails.length + ' 项失败 / ' : 'PASS  ') + pass + ' 通过');
  if (fails.length) fails.forEach((f) => console.log('   - ' + f));
  app.exit(fails.length ? 1 : 0);
});
