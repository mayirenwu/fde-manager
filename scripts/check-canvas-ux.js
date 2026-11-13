/**
 * 画布交互三件修复：
 *  1) 空画布 8 张工具卡：每张卡点出来的节点都带「说明笔记」（不能是"（无说明）"）
 *  2) 右侧面板正开着模型下拉 / 在输入时，2.5 秒轮询不得整体重绘（否则下拉被收走）
 *  3) 点胶囊选项立即高亮，不用等 2.5 秒轮询才显示选中
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-canvas-ux.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const modelsLib = require(path.join(ROOT, 'models.js'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const params = modelsLib.normalizeParams([
  { name: 'prompt', label: '提示词', type: 'textarea', required: true },
  { name: 'aspect_ratio', label: '图片比例', type: 'select', required: false, options: [{ value: 'auto', label: '自适应' }, { value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }] },
  { name: 'quality', label: '画质', type: 'select', required: false, options: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }] }
]);
const mk = (name) => ({ name, displayName: name, type: 'image', tags: [], params, fields: modelsLib.fieldsOf(params), available: true });
const catalog = {
  ok: true,
  counts: { chat: 0, image: 2, video: 0, audio: 0, total: 2 },
  models: [mk('img-a'), mk('img-b')],
  groups: { chat: [], image: [mk('img-a'), mk('img-b')], video: [], audio: [] }
};

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }, projects: [], windows: [], activeId: null }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => catalog);
  ipcMain.handle('models:detail', (e, name) => {
    const mm = (catalog.models || []).find(x => x.name === name);
    return mm ? { ok: true, name, params: mm.params, fields: mm.fields, defaults: modelsLib.defaultsFor(mm.params), caps: modelsLib.capabilities(mm.fields) } : { ok: false, error: 'x' };
  });
  ipcMain.handle('ai:get', () => ({ ok: true, status: { level: 'on', text: '已接上' }, model: 'gem', models: [] }));
  ipcMain.handle('canvas:run-node', () => ({ ok: true, msg: 'ok' }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('app:open-url', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'overview.html'), { query: { view: 'canvas' } });
  await wait(1200);

  let fail = 0;
  const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { fail++; console.log('  ✗ ' + msg); } };

  // 1) 每张工具卡出来的节点都要有笔记
  console.log('\n== 工具卡笔记 ==');
  const toolNotes = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    for (const kind of ['t2i','i2i','article','compare','t2v','a2v','i2v','director']) {
      C.nodes = []; C.edges = [];
      await spawnTool(kind);
      await new Promise(r => setTimeout(r, 30));
      out[kind] = C.nodes.filter(n => n.type !== 'group').every(n => (n.note || '').trim().length > 3);
    }
    C.nodes = []; C.edges = []; renderAll();
    return out;
  })()`);
  for (const k of Object.keys(toolNotes)) ok(toolNotes[k], '工具卡 ' + k + ' 出来的每个节点都带说明');

  // 1b) 从卡片页点卡：必须真的切进画布并把节点摆出来（模型用默认那档）
  console.log('\n== 点卡片切进画布 ==');
  const cardClick = await win.webContents.executeJavaScript(`(async () => {
    setView('cards');
    await new Promise(r => setTimeout(r, 300));
    const card = document.querySelector('#toolGrid .toolcard[data-tool="t2i"]');
    if (!card) return { found: false };
    card.click();
    await new Promise(r => setTimeout(r, 1100));
    const n = C.nodes[0];
    return {
      found: true, view, nodes: C.nodes.length,
      model: n && n.ref.model, defModel: (pickModel('image') || {}).name,
      note: n && n.note
    };
  })()`);
  ok(cardClick.found, '卡片页有「文字生图片」卡');
  ok(cardClick.view === 'canvas' && cardClick.nodes > 0, '点卡片后切进了画布并摆好节点（不再"没反应"）');
  ok(cardClick.model === cardClick.defModel, '模型用的是默认挑选那档（' + cardClick.model + '）');
  ok((cardClick.note || '').length > 3, '节点带说明笔记');
  await win.webContents.executeJavaScript(`C.nodes = []; C.edges = []; renderAll(); 'ok'`);

  // 摆一个生成节点做后面的交互测试
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.cbar [data-add="gen"]')].find(b => b.dataset.modal === 'image').click(); 'ok'`);
  await wait(700);

  // 2) 面板正在操作（下拉聚焦）时，refreshLive 不许重建面板
  console.log('\n== 下拉不被收走 ==');
  const guard = await win.webContents.executeJavaScript(`(async () => {
    const sel = document.querySelector('#inspector select[data-f="genmodel"]');
    if (!sel) return { hasSel: false };
    sel.__sentinel = true;
    sel.focus();
    await refreshLive();
    const still = document.activeElement === sel && sel.__sentinel === true && sel.isConnected;
    return { hasSel: true, still };
  })()`);
  ok(guard.hasSel, '面板里有模型下拉');
  ok(guard.still === true, '下拉聚焦时 refreshLive 没有重建面板（下拉不会被收走）');
  const unguard = await win.webContents.executeJavaScript(`(async () => {
    document.activeElement.blur();
    document.body.focus();
    await refreshLive();
    const sel2 = document.querySelector('#inspector select[data-f="genmodel"]');
    return { rebuilt: !sel2 || sel2.__sentinel !== true };
  })()`);
  ok(unguard.rebuilt === true, '失去焦点后轮询恢复正常重建');

  // 3) 点胶囊立即高亮（不等 2.5 秒）
  console.log('\n== 胶囊立即选中 ==');
  const chip = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('#inspector .chip[data-gparam="aspect_ratio"][data-gval="16:9"]');
    if (!el) return { found: false };
    el.click();
    const wrap = el.closest('.chips');
    const on = wrap ? wrap.querySelector('.chip.on') : null;
    return { found: true, immediate: !!(on && on.dataset.gval === '16:9'),
      saved: C.nodes[0].ref.params.aspect_ratio === '16:9' };
  })()`);
  ok(chip.found, '有比例胶囊');
  ok(chip.immediate, '点击后同步就高亮了（不用等轮询）');
  ok(chip.saved, '参数也写进了节点');

  console.log(fail ? '\nFAIL ' + fail : '\nALL PASS');
  app.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
