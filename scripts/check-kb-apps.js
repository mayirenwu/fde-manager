/**
 * 应用功能 · 知识库标签页检查（真实 Electron + 真 iframe + 真 store）
 * 覆盖：能力/知识库两档切换 → iframe 内 preload 可用 → 建基础库
 *      → 导入文件夹「按子文件夹各建一个库」→ 库数/文档数正确 → 重复导入去重
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const kb = require('../kb');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-apps-'));
app.setPath('userData', path.join(TMP, 'userdata'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' | ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 夹具：一个"现有文件夹知识库"，按用途分了子目录 */
const SRC = path.join(TMP, '我的知识库');
fs.mkdirSync(path.join(SRC, '浴室改造方案'), { recursive: true });
fs.mkdirSync(path.join(SRC, '客户档案'), { recursive: true });
fs.writeFileSync(path.join(SRC, '浴室改造方案', '防滑改造方案.md'),
  '# 浴室防滑改造方案\n\n## 报价\n基础包 1980 元：防滑垫 + 折叠洗澡椅 + 上门测量。\n', 'utf8');
fs.writeFileSync(path.join(SRC, '浴室改造方案', '施工清单.md'),
  '# 施工清单\n\n1. 量尺寸\n2. 装洗澡椅\n3. 贴防滑条\n', 'utf8');
fs.writeFileSync(path.join(SRC, '客户档案', '张阿姨.md'),
  '# 客户 张阿姨\n\n72 岁，独居，浴室无扶手，预算 2000，子女在杭州。\n', 'utf8');
fs.writeFileSync(path.join(SRC, '说明.md'), '# 总说明\n\n这个库放适老改造的资料。\n', 'utf8');
fs.mkdirSync(path.join(SRC, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(SRC, 'node_modules', 'x.js'), 'console.log(1)', 'utf8');

app.whenReady().then(async () => {
  const store = kb.createStore(path.join(app.getPath('userData'), 'kb'));

  /* ---- 主进程能力：和应用功能窗口里的真实实现同构 ---- */
  ipcMain.handle('apps:get', () => ({
    items: [], trash: [], stats: { total: 0 }, kinds: {}
  }));
  ipcMain.handle('ai:get', () => ({ ok: true, hasKey: false, model: '', baseUrl: '', models: [], status: { level: 'off', text: '' } }));
  ipcMain.handle('apps:close', () => ({ ok: true }));
  ipcMain.handle('kb:load', () => {
    const st = store.load();
    return { ok: true, libs: st.libs, docs: st.docs, kinds: kb.KINDS, version: kb.VERSION, stats: store.stats() };
  });
  ipcMain.handle('kb:save', (e, patch) => {
    const p = patch || {};
    const st = store.load();
    if (Array.isArray(p.libs)) st.libs = p.libs;
    if (Array.isArray(p.docs)) st.docs = p.docs;
    store.save(st);
    return { ok: true };
  });
  ipcMain.handle('kb:pick-dir', () => ({ ok: true, dir: SRC }));
  ipcMain.handle('kb:pick-files', () => ({ ok: true, files: [], root: SRC }));
  ipcMain.handle('kb:scan', (e, payload) => {
    const r = kb.scanDir(String((payload && payload.dir) || SRC));
    const st = store.load();
    const seen = new Set(st.docs.map((d) => d.path + '|' + d.size));
    r.files = r.files.map((f) => Object.assign(f, { exist: seen.has(f.path + '|' + f.size) }));
    return Object.assign({ ok: true }, r);
  });
  ipcMain.handle('kb:paths', (e, payload) => {
    const list = (payload && payload.paths) || [];
    const dirs = [];
    const files = [];
    for (const fp of list) {
      const st = fs.statSync(fp);
      if (st.isDirectory()) dirs.push(fp);
      else files.push({ path: fp, rel: path.basename(fp), name: path.basename(fp), ext: path.extname(fp).toLowerCase(), size: st.size });
    }
    return { ok: true, dirs, files, bad: [] };
  });
  ipcMain.handle('kb:add-docs', (e, payload) => store.addDocs(payload.libId, payload.files));
  ipcMain.handle('kb:search', (e, payload) => ({ ok: true, hits: store.search(payload.q, payload.libId || '', 10) }));
  ipcMain.handle('kb:doc-text', (e, id) => {
    const d = store.load().docs.find((x) => x.id === id);
    return d ? { ok: true, doc: d, text: store.textOf(d) } : { ok: false };
  });
  ipcMain.handle('kb:doc-remove', (e, payload) => store.removeDocs((payload && payload.ids) || []));
  ipcMain.handle('kb:reveal', () => ({ ok: true }));
  const opened = [];
  ipcMain.handle('kb:open', () => { opened.push('kb'); return { ok: true }; });

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true
    }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2 && !/Security Warning|Electron Security/.test(msg)) errs.push(msg);
  });

  await win.loadFile(path.join(__dirname, '..', 'apps.html'));
  await wait(700);

  const ev = (js) => win.webContents.executeJavaScript(js);
  const frame = () => win.webContents.mainFrame.frames.find((f) => /kb\.html/.test(f.url || ''));

  /* ---- 1. 标签页：能力排第一、默认就是它 ---- */
  const tabs = await ev(`[...document.querySelectorAll('#seg button')].map(b => b.textContent.trim())`);
  ok(tabs.length === 2 && /能力/.test(tabs[0]) && /知识库/.test(tabs[1]), '顶部两档里「能力」排在最前面', String(tabs));
  ok(await ev(`!document.body.classList.contains('kbOn') && !document.getElementById('kbPane').classList.contains('on')`), '打开应用功能默认停在「能力」，不直接进知识库');
  ok(await ev(`document.getElementById('appsBody').style.display === 'flex'`), '默认显示能力列表');
  ok(await ev(`!document.getElementById('kbFrame').getAttribute('src')`), '默认不加载知识库（点进去才加载，省一次开销）');

  await ev(`document.querySelector('#seg button[data-tab="kb"]').click(); 1`);
  await wait(900);
  ok(await ev(`document.body.classList.contains('kbOn') && document.getElementById('kbPane').classList.contains('on')`), '点「知识库」切到知识库视图');
  ok(await ev(`document.getElementById('appsBody').style.display === 'none'`), '能力列表让位（不叠在一起）');
  ok(await ev(`document.getElementById('kbFrame').getAttribute('src') === 'kb.html?embed=1'`), 'iframe 加载 kb.html（embed 模式，不显示关闭键）');

  /* ---- 2. iframe 里 preload 生效 ---- */
  const f = frame();
  ok(!!f, '找到内嵌的知识库框架');
  const hasFde = f ? await f.executeJavaScript('typeof window.fde === "object" && typeof window.fde.kbLoad === "function"') : false;
  ok(hasFde, '子框架拿到了 preload（能直连主进程）');
  const noClose = f ? await f.executeJavaScript(`getComputedStyle(document.querySelector('#closeBtn')).display === 'none'`) : false;
  ok(noClose, '内嵌时不显示「关闭」键');

  /* ---- 3. 建库：一键 6 个基础库 ---- */
  await f.executeJavaScript(`document.querySelector('#seedLibsBtn').click(); 1`);
  await wait(900);
  let st = await f.executeJavaScript('window.__fdeKb()');
  ok(st.libs.length === 6, '一键建好 6 个基础库（实际 ' + st.libs.length + '）', st.libs.map((l) => l.name).join('/'));

  /* ---- 4. 导入整个文件夹：按子文件夹各建一个库 ---- */
  await f.executeJavaScript(`document.querySelector('#impDirBtn').click(); 1`);
  await wait(1200);
  const dlg = await f.executeJavaScript(`(() => ({
    on: document.querySelector('#impMask').classList.contains('on'),
    stat: (document.querySelector('#impStat') || {}).textContent || '',
    modeRow: getComputedStyle(document.querySelector('#impModeRow')).display,
    mode: (document.querySelector('#impMode') || {}).value || '',
    groups: (document.querySelector('#impGroups') || {}).textContent || ''
  }))()`);
  ok(dlg.on, '导入弹窗打开');
  ok(/找到\s*4\s*个可导入文档/.test(dlg.stat), '扫描到 4 篇（跳过 node_modules）', dlg.stat.slice(0, 60));
  ok(dlg.modeRow !== 'none' && dlg.mode === 'sub', '识别到子文件夹，默认「按子文件夹各建一个库」');
  ok(/浴室改造方案/.test(dlg.groups) && /客户档案/.test(dlg.groups), '弹窗里列出分组：浴室改造方案 / 客户档案', dlg.groups.slice(0, 60));

  await f.executeJavaScript(`document.querySelector('#impOk').click(); 1`);
  await wait(2600);
  st = await f.executeJavaScript('window.__fdeKb()');
  const names = st.libs.map((l) => l.name);
  ok(names.includes('浴室改造方案') && names.includes('客户档案'), '子文件夹自动建成了同名库', names.join('/'));
  ok(st.libs.length === 8, '6 个基础库 + 2 个新建库 = 8（实际 ' + st.libs.length + '）');
  ok(st.docs.length === 4, '4 篇文档全部进来（实际 ' + st.docs.length + '）');

  const bkLib = st.libs.find((l) => l.name === '浴室改造方案');
  const inLib = st.docs.filter((d) => d.libId === (bkLib && bkLib.id));
  ok(inLib.length === 2, '「浴室改造方案」库里 2 篇（实际 ' + inLib.length + '）');
  const cust = st.libs.find((l) => l.name === '客户档案');
  ok(st.docs.some((d) => d.libId === (cust && cust.id) && /张阿姨/.test(d.name)), '「客户档案」库里是张阿姨那篇');

  /* ---- 5. 检索在真实文件夹内容上可用 ---- */
  const hits = await f.executeJavaScript(`window.fde.kbSearch({ q: '防滑 洗澡椅' })`);
  ok(hits.ok && hits.hits.length >= 1 && /防滑|洗澡椅/.test(hits.hits[0].snippet || hits.hits[0].title || ''), '内嵌知识库能检索到刚导入的方案', (hits.hits[0] || {}).title);

  /* ---- 6. 再导一次：去重不重复 ---- */
  await f.executeJavaScript(`document.querySelector('#impDirBtn').click(); 1`);
  await wait(1000);
  const again = await f.executeJavaScript(`(document.querySelector('#impStat') || {}).textContent || ''`);
  ok(/新增\s*0/.test(again), '同一个文件夹再导一次：新增 0（按路径+大小去重）', again.slice(0, 50));
  await f.executeJavaScript(`document.querySelector('#impCancel').click(); 1`);

  /* ---- 7. 数据真的落盘 ---- */
  const onDisk = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'kb', 'kb-data.json'), 'utf8'));
  ok(onDisk.libs.length === 8 && onDisk.docs.length === 4, '落盘文件里也是 8 库 / 4 篇');
  ok(fs.readdirSync(path.join(app.getPath('userData'), 'kb', 'text')).length === 4, '正文一篇一个 txt');

  /* ---- 8. 左栏那个「知识库」入口 = 同一处，不是另一套东西 ---- */
  await ev(`document.querySelector('#seg button[data-tab="apps"]').click(); 1`);
  await wait(400);
  ok(await ev(`!document.body.classList.contains('kbOn') && document.getElementById('appsBody').style.display === 'flex'`), '能切到「能力」档，布局恢复');
  const rail = await ev(`(() => {
    const ent = document.querySelector('#kbEntRow');
    const rows = [...document.querySelectorAll('#rail .rrow')].map(e => e.textContent.trim());
    return { ent: !!ent, first: (rows[0] || ''), rows, hasLib: rows.some(t => /资料库条目/.test(t)), hasLibOld: rows.some(t => /^📚资料库\d+$/.test(t)) };
  })()`);
  ok(rail.ent, '左栏最前面有「📚 知识库」入口');
  ok(/模型设置/.test(rail.first) && /知识库/.test(rail.rows[1] || ''), '知识库在左栏第 2 行（第 1 行是模型设置：' + rail.first.slice(0, 12) + '）');
  ok(rail.hasLib, '原来的资料库类目改名成「资料库条目」，和知识库区分开');
  ok(!rail.hasLibOld, '左栏不再有和历史重名的「资料库」类目');

  await ev(`document.getElementById('kbEntRow').click(); 1`);
  await wait(300);
  ok(await ev(`document.body.classList.contains('kbOn')`), '点左栏这个入口，进的就是同一个知识库');

  /* ---- 9. 入口统一走应用功能（openKb 只是转调，不再单开窗口） ---- */
  const api = await ev(`({ tabs: typeof window.fde.appsOpenTab === 'function', on: typeof window.fde.onAppsTab === 'function', kb: typeof window.fde.openKb === 'function' })`);
  ok(api.tabs && api.on, '主进程支持"打开应用功能并直接停在知识库"');
  ok(api.kb, '旧的 openKb 入口仍在（内部转调应用功能，不再另开窗口）');

  ok(errs.length === 0, '页面无脚本报错', errs.slice(0, 2).join(' | '));

  console.log('\n' + (fails.length ? 'FAIL' : 'ALL PASS') + '  ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) console.log(fails.map((x) => ' - ' + x).join('\n'));
  app.exit(fails.length ? 1 : 0);
}).catch((e) => {
  console.error('ERROR', e && e.stack || e);
  app.exit(2);
});
