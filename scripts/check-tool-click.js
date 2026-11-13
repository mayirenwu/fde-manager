/**
 * 真实环境重放：用平台真实模型目录（192 个）+ 真实鼠标事件点工具卡，
 * 捕获未处理异常 —— 复现用户"点了没反应"。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-tool-click.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const modelsLib = require(path.join(ROOT, 'models.js'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 与 main.js models:catalog 完全一致的归一化
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'cat-raw.json'), 'utf8'));
const list = modelsLib.normalizeCatalog(raw);
const catalog = {
  ok: true,
  models: list,
  groups: modelsLib.group(list),
  counts: modelsLib.counts(list),
  types: modelsLib.TYPE_META,
  source: 'real',
  base: 'https://api.lk888.ai/v1'
};
console.log('目录：', list.length, '个模型，', Object.keys(catalog.groups).map(k => k + ':' + catalog.groups[k].length).join(' '));

app.whenReady().then(async () => {
  const diagLines = [];   // 飞行记录仪收集
  ipcMain.handle('diag:log', (e, text) => { diagLines.push(String(text || '')); return { ok: true }; });
  ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }, projects: [], windows: [], activeId: null }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('models:catalog', async () => { await wait(50); return catalog; });
  ipcMain.handle('models:detail', async (e, name) => {
    await wait(80);
    const mm = list.find(x => x.name === name);
    return mm ? { ok: true, name, params: mm.params, fields: modelsLib.fieldsOf(mm.params), defaults: modelsLib.defaultsFor(mm.params), caps: modelsLib.capabilities(mm.fields) } : { ok: false, error: 'no model' };
  });
  ipcMain.handle('ai:get', () => ({ ok: true, status: { level: 'on', text: '已接上' }, model: 'gem', models: [] }));
  ipcMain.handle('canvas:run-node', () => ({ ok: true, msg: 'ok' }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('app:open-url', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning|Autofill/.test(msg)) errs.push(String(msg).slice(0, 300)); });
  // 注意：不带 view=cards —— 模拟真实打开（默认 cards，用户切到画布）
  await win.loadFile(path.join(ROOT, 'overview.html'));
  await wait(1000);

  let fail = 0;
  const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { fail++; console.log('  ✗ ' + msg); } };

  // 捕获渲染进程未处理异常
  await win.webContents.executeJavaScript(`(window.__errs = []);
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
    window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message + ' @' + (e.filename||'') + ':' + e.lineno));
    'ok'`);

  // 用户路径：切到画布页 → 空画布上点「文字生图片」卡（真实鼠标事件）
  console.log('\n== 用户路径重放 ==');
  await win.webContents.executeJavaScript(`setView('canvas'); 'ok'`);
  await wait(900);

  const hit = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#toolGrid .toolcard[data-tool="t2i"]');
    if (!card) return { found: false, hintShown: false };
    const r = card.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true,
      hintShown: getComputedStyle(document.querySelector('#emptyHint')).display !== 'none',
      rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      topEl: top ? (top.className || top.id || top.tagName) : '(none)',
      topIsCard: !!(top && top.closest('.toolcard'))
    };
  })()`);
  ok(hit.found && hit.hintShown, '空画布提示与工具卡都在');
  ok(hit.topIsCard, '卡片中心命中检测 = 卡片本身（顶层: ' + hit.topEl + '）');
  // 回归防护：emptyhint 必须带 data-no-drag —— 否则 stage 的 pointerdown 会
  // setPointerCapture 抢占指针，真实鼠标的 click 被重定向到 stage，工具卡点不着
  // （合成 sendInputEvent 与真实鼠标在捕获行为上有差异，之前没拦住）。
  ok(await win.webContents.executeJavaScript(
    `!!document.querySelector('#emptyHint[data-no-drag]')`), 'emptyHint 带 data-no-drag（stage 不抢占工具卡指针）');

  // 真实鼠标点击（sendInputEvent，会走完整命中测试）
  await win.webContents.sendInputEvent({ type: 'mouseDown', x: hit.rect.x, y: hit.rect.y, button: 'left', clickCount: 1 });
  await win.webContents.sendInputEvent({ type: 'mouseUp', x: hit.rect.x, y: hit.rect.y, button: 'left', clickCount: 1 });
  await wait(1200);

  const after = await win.webContents.executeJavaScript(`({
    view,
    nodes: C.nodes.map(n => ({ type: n.type, title: n.title, model: n.ref && n.ref.model, note: (n.note || '').slice(0, 30) })),
    hintGone: getComputedStyle(document.querySelector('#emptyHint')).display === 'none',
    inspectorOn: document.querySelector('#inspector').classList.contains('on'),
    errs: window.__errs
  })`);
  ok(after.view === 'canvas', '还在画布视图');
  ok(after.nodes.length > 0, '真实点击后节点被创建（' + after.nodes.length + ' 个）');
  ok(after.hintGone, '空画布提示消失');
  ok(after.nodes.every(n => !!(n.model)), '每个生成节点都有模型（' + after.nodes.map(n => n.model).join(',') + '）');
  ok(after.nodes.every(n => (n.note || '').length > 3), '每个节点都有说明');
  ok(!(after.errs || []).length, '没有未处理异常' + ((after.errs || []).length ? '：' + after.errs.join(' | ') : ''));
  ok(after.inspectorOn, '右侧面板已打开');

  // 飞行记录仪链路：哨兵/就绪打点/点击/完成，四类日志都要落盘
  console.log('\n== 飞行记录仪 ==');
  ok(diagLines.some(l => l.includes('sentinel-ok')), '哨兵启动打点已记录');
  ok(diagLines.some(l => l.includes('overview-js-ready')), '主脚本就绪打点已记录');
  ok(diagLines.some(l => l.includes('toolcard-click kind=t2i')), '真实点击事件已记录');
  ok(diagLines.some(l => l.includes('spawn-ok kind=t2i')), '节点创建成功打点已记录');
  if (diagLines.length) console.log('  [日志]', diagLines.slice(0, 6).join(' / ').slice(0, 300));

  if (errs.length) console.log('  [控制台]', errs.slice(0, 5).join('\n           '));
  console.log(fail ? '\nFAIL ' + fail : '\nALL PASS');
  await win.webContents.executeJavaScript(`try{localStorage.clear()}catch(e){}; 'ok'`).catch(() => {});
  app.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
