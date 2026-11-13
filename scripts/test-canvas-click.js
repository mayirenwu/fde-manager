/**
 * 画布按钮点击回归测试（真实鼠标事件，不是 element.click()）。
 * 验证：
 *   1) 节点上的「▶ 运行」在指针捕获场景下仍然可点，且执行记录/收起画布正常
 *   2) 节点上的「⚙ 设置」打开的是「这个节点自己的设置」（右侧面板），
 *      不再一律弹出项目设置窗口（之前项目/脚本/窗口节点全弹同一个窗口）
 *   3) 点节点、拖节点这些基础交互没被改坏
 * 跑法：npx electron scripts/test-canvas-click.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let runCalls = 0;
let panelCalls = 0;
let closeCalls = 0;
let builderCalls = 0;
let lastBuilderImages = [];
let bw = null;

const canvas = {
  view: { x: 0, y: 0, z: 1 },
  nodes: [
    {
      id: 'n1', type: 'project', title: '演示项目', note: '点运行应该切到本项目桌面',
      x: 120, y: 120, w: 240, h: 0, color: '', z: 0,
      collapsed: false, locked: false, tags: [],
      ref: { projectId: 'p1', autoRun: false }
    },
    {
      id: 'n2', type: 'script', title: '开户脚本', note: '应该是脚本自己的设置',
      x: 520, y: 120, w: 240, h: 0, color: '', z: 0,
      collapsed: false, locked: false, tags: [],
      ref: { projectId: 'p1', path: 'D:\\work\\open.ps1' }
    },
    {
      id: 'n3', type: 'note', title: '随便记一笔', note: '没有绑项目，也应该能开设置',
      x: 520, y: 380, w: 240, h: 0, color: '', z: 0,
      collapsed: false, locked: false, tags: [],
      ref: {}
    },
    {
      id: 'n4', type: 'ai', title: 'AI 汇总', note: '上下文汇总，直接用模型跑',
      x: 120, y: 380, w: 240, h: 0, color: '', z: 0,
      collapsed: false, locked: false, tags: [],
      ref: {}
    }
  ],
  edges: []
};

function registerMockIpc() {
  ipcMain.handle('data:get', () => ({
    projects: [{ id: 'p1', name: '演示项目', color: '#4f8cff', status: 'stopped', items: [], context: [], autorun: [] }],
    flows: [], logs: [], inbox: {}, stats: {}
  }));
  ipcMain.handle('canvas:get', () => ({
    ok: true,
    canvas,
    windows: [],
    projects: [{ id: 'p1', name: '演示项目', color: '#4f8cff', status: 'stopped', windowsCount: 0, autorun: 0, context: 0, items: [] }],
    activeId: 'p1'
  }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('browsers:list', () => ({ ok: true, list: [] }));
  ipcMain.handle('canvas:run-node', () => {
    runCalls++;
    return { ok: true, msg: '已切到「演示项目」桌面' };
  });
  ipcMain.handle('project:open-panel', () => {
    panelCalls++;
    return { ok: true };
  });
  ipcMain.handle('overview:close', () => { closeCalls++; return { ok: true }; });
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('screen:capture', async () => ({
    ok: true,
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    bytes: 100
  }));
  ipcMain.handle('builder:chat', async (e, payload) => {
    lastBuilderImages = (payload && payload.images) || [];
    builderCalls++;
    canvas.nodes.push({ id: 'n9', type: 'script', title: '搭台脚本', note: '自动搭出来的', x: 800, y: 120, w: 240, h: 0, color: '', ref: { path: 'D:////auto////run.ps1' }, collapsed: false, locked: false, tags: ['搭台'], z: 0 });
    if (bw && !bw.isDestroyed()) bw.webContents.send('fde:canvas', { ok: true, canvas, windows: [], projects: [{ id: 'p1', name: '演示项目', color: '#4f8cff', status: 'stopped', windowsCount: 0, autorun: 0, context: 0, items: [] }], activeId: 'p1' });
    return { ok: true, summary: '搭好了：1 个脚本节点', created: { projects: [], nodes: ['搭台脚本'], edges: [], scripts: [{ project: '演示项目', name: '整理订单' }] }, errors: [], aiNote: '这是一个演示方案' };
  });
  ipcMain.handle('ai:get', () => ({
    ok: true, baseUrl: 'https://ai.my10086.cn/v1', hasKey: true, keyMask: 'sk-te…6789',
    model: 'deepseek-chat', protocol: 'openai',
    models: [{ id: 'deepseek-chat', name: '深度求索 · deepseek-chat' }, { id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
    status: { level: 'on', text: '已接上 deepseek-chat' }
  }));
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

app.whenReady().then(async () => {
 try {
  registerMockIpc();
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  bw = win;
  await win.loadFile(path.join(ROOT, 'overview.html'));
  await wait(500);
  await win.webContents.executeJavaScript("setView('canvas'); fitView(); 'ok'");
  await wait(500);

  async function centerOf(sel) {
    return win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
  }
  async function js(code) { return win.webContents.executeJavaScript(code); }
  async function realClick(pt) {
    if (!pt) return;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await wait(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }

  const results = [];

  // ---------- 0) 每个节点都有「设置」按钮 ----------
  const foot = await js(`(() => {
    const out = {};
    for (const id of ['n1','n2','n3']) {
      const b = document.querySelector('[data-id="' + id + '"] .nfoot [data-act="settings"]');
      out[id] = !!b;
    }
    return out;
  })()`);
  results.push({
    name: '每种节点都有设置按钮',
    ok: foot.n1 && foot.n2 && foot.n3,
    detail: JSON.stringify(foot)
  });

  // ---------- 1) 运行按钮 ----------
  const runPt = await centerOf('[data-id="n1"] .nfoot [data-act="run"]');
  if (!runPt) { console.log('✗ 找不到运行按钮（画布可能没渲染）'); app.exit(1); return; }
  await realClick(runPt);
  await wait(700);
  const runlog = await js("document.querySelectorAll('#runlog .rl').length");
  await wait(1000); // 等"单点运行成功后自动收起画布"
  results.push({
    name: '▶ 运行',
    ok: runCalls === 1 && closeCalls >= 1 && runlog >= 1,
    detail: `IPC ${runCalls} 次 · 收起画布 ${closeCalls} 次 · 执行记录 ${runlog} 条`
  });

  // ---------- 2) 脚本节点点「设置」：开的是脚本自己的设置 ----------
  await js("selectOnly(null); 'ok'");
  await wait(120);
  const sPt = await centerOf('[data-id="n2"] .nfoot [data-act="settings"]');
  await realClick(sPt);
  await wait(320);
  const sState = await js(`(() => {
    const insp = document.getElementById('inspector');
    return {
      on: insp.classList.contains('on'),
      flash: insp.classList.contains('flash2'),
      title: (insp.querySelector('h4 .htl') || {}).textContent || '',
      type: (insp.querySelector('h4 .hty') || {}).textContent || '',
      ownbar: !!(insp.querySelector('.ownbar')),
      hasPath: !!insp.querySelector('input[data-f="path"]'),
      hasBinding: !!insp.querySelector('select[data-f="projectId"]'),
      hasProjBtn: !!insp.querySelector('[data-act="open-proj"]'),
      sel: document.querySelectorAll('.node.sel').length,
      selId: (document.querySelector('.node.sel') || {}).dataset ? document.querySelector('.node.sel').dataset.id : ''
    };
  })()`);
  results.push({
    name: '脚本节点设置 → 脚本自己的面板',
    ok: sState.on && sState.flash && sState.title === '开户脚本' && sState.hasPath && !sState.hasProjBtn
        && sState.selId === 'n2' && panelCalls === 0,
    detail: `标题「${sState.title}」· 类型「${sState.type}」· 闪=${sState.flash} · 脚本路径框=${sState.hasPath} · 弹项目窗口 ${panelCalls} 次`
  });

  // ---------- 3) 项目节点点「设置」：开的也是节点设置，并给一个进项目面板的按钮 ----------
  await wait(1400); // 等上一次闪烁结束
  const pPt = await centerOf('[data-id="n1"] .nfoot [data-act="settings"]');
  await realClick(pPt);
  await wait(320);
  const pState = await js(`(() => {
    const insp = document.getElementById('inspector');
    return {
      flash: insp.classList.contains('flash2'),
      title: (insp.querySelector('h4 .htl') || {}).textContent || '',
      hasProjBtn: !!insp.querySelector('[data-act="open-proj"]'),
      hasAutoRun: !!insp.querySelector('input[data-f="autoRun"]'),
      toast: (document.getElementById('toast') || {}).textContent || ''
    };
  })()`);
  results.push({
    name: '项目节点设置 → 节点设置 + 项目面板入口',
    ok: pState.flash && pState.title === '演示项目' && pState.hasProjBtn && pState.hasAutoRun && panelCalls === 0,
    detail: `闪=${pState.flash} · 标题「${pState.title}」· 项目面板按钮=${pState.hasProjBtn} · 弹项目窗口 ${panelCalls} 次`
  });

  // 3b) 只有显式点「🖥 项目面板」才真的打开项目设置窗口
  const projBtnPt = await centerOf('#inspector [data-act="open-proj"]');
  await realClick(projBtnPt);
  await wait(500);
  results.push({
    name: '显式点「项目面板」才开项目窗口',
    ok: panelCalls === 1,
    detail: `project:open-panel 调用 ${panelCalls} 次`
  });

  // ---------- 4) 没绑项目的笔记节点也能开设置 ----------
  const nPt = await centerOf('[data-id="n3"] .nfoot [data-act="settings"]');
  await realClick(nPt);
  await wait(300);
  const nState = await js(`(() => {
    const insp = document.getElementById('inspector');
    return {
      flash: insp.classList.contains('flash2'),
      title: (insp.querySelector('h4 .htl') || {}).textContent || '',
      hasNote: !!insp.querySelector('textarea[data-f="note"]')
    };
  })()`);
  results.push({
    name: '未绑项目的节点也能开设置',
    ok: nState.flash && nState.title === '随便记一笔' && nState.hasNote,
    detail: `闪=${nState.flash} · 标题「${nState.title}」`
  });

  // ---------- 5) 点节点空白处仍然能选中 ----------
  const nodePt = await centerOf('[data-id="n1"] .nttl');
  await js("selectOnly(null); 'ok'");
  await realClick(nodePt);
  await wait(220);
  const selected = await js("document.querySelectorAll('.node.sel').length");
  results.push({ name: '点节点选中', ok: selected === 1, detail: `选中 ${selected} 个` });

  // ---------- 6) 拖动节点仍然生效 ----------
  const drag = await js(`(() => {
    const n = document.querySelector('[data-id="n1"]');
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: nodePt.x, y: nodePt.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: nodePt.x, y: nodePt.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: nodePt.x + i * 12, y: nodePt.y + i * 4, button: 'left' });
    await wait(16);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: nodePt.x + 72, y: nodePt.y + 24, button: 'left', clickCount: 1 });
  await wait(320);
  const moved = await js(`(() => {
    const n = document.querySelector('[data-id="n1"]');
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  })()`);
  results.push({ name: '拖动节点', ok: Math.abs(moved.x - drag.x) > 20, detail: `x ${drag.x} → ${moved.x}` });

  // ---------- 7) AI 节点：本节点模型 + 多模型对比 ----------
  await js("selectOnly(null); 'ok'");
  await wait(120);
  const aPt = await centerOf('[data-id="n4"] .nfoot [data-act="settings"]');
  await realClick(aPt);
  await wait(320);
  const aState = await js(`(() => {
    const insp = document.getElementById('inspector');
    const sel = insp.querySelector('select[data-f="model"]');
    return {
      title: (insp.querySelector('h4 .htl') || {}).textContent || '',
      hasSelect: !!sel,
      optCount: sel ? sel.options.length : 0,
      chips: [...insp.querySelectorAll('[data-mm]')].map(c => c.dataset.mm)
    };
  })()`);
  results.push({
    name: 'AI 节点有本节点模型下拉与多模型点选',
    ok: aState.title === 'AI 汇总' && aState.hasSelect && aState.optCount >= 3 && aState.chips.length === 2,
    detail: JSON.stringify(aState)
  });

  await js(`(() => { const s = document.querySelector('#inspector select[data-f="model"]'); s.value = 'gpt-4o-mini'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await wait(240);
  const modelMeta = await js(`(() => { const el = document.querySelector('[data-id="n4"] .nmeta'); return el ? el.textContent : ''; })()`);
  results.push({ name: '选本节点模型后卡片显示模型名', ok: /gpt-4o-mini/.test(modelMeta), detail: modelMeta });

  const chip1Pt = await centerOf('#inspector [data-mm="deepseek-chat"]');
  await realClick(chip1Pt);
  await wait(200);
  const chip2Pt = await centerOf('#inspector [data-mm="gpt-4o-mini"]');
  await realClick(chip2Pt);
  await wait(260);
  const mmState = await js(`(() => {
    const on = [...document.querySelectorAll('#inspector [data-mm].on')].map(c => c.dataset.mm);
    const meta = (document.querySelector('[data-id="n4"] .nmeta') || {}).textContent || '';
    const sel = document.querySelector('#inspector select[data-f="model"]');
    return { on, meta, selVal: sel ? sel.value : '' };
  })()`);
  results.push({
    name: '点选多个模型进入对比模式（互斥单选模型）',
    ok: mmState.on.length === 2 && /多模型对比/.test(mmState.meta) && mmState.selVal === '',
    detail: JSON.stringify(mmState)
  });

  // ---------- 8) 搭台助手：说一句 → 自动落节点 → 开跑 ----------
  await js("selectOnly(null); document.getElementById('inspector').classList.remove('on'); 'ok'");
  const bdPt = await centerOf('#bdBtn');
  await realClick(bdPt);
  await wait(260);
  const drawerOn = await js("document.getElementById('bdrawer').classList.contains('on')");
  await js(`(() => { const i = document.getElementById('bdInput'); i.value = '搭一个亚马逊美国站的流程'; return 1; })()`);
  const sendPt = await centerOf('#bdSend');
  await realClick(sendPt);
  await wait(900);
  const bdState = await js(`(() => ({
    msgs: [...document.querySelectorAll('#bdMsgs .m')].map(m => m.textContent.trim()),
    nodeCount: document.querySelectorAll('.node').length,
    hasBd9: !!document.querySelector('[data-id="n9"]'),
    runBtn: (document.querySelector('#bdMsgs [data-bdrun]') || {}).textContent || ''
  }))()`);
  results.push({
    name: '搭台抽屉：说一句自动落节点并给开跑按钮',
    ok: drawerOn && bdState.msgs.some(m => m.includes('搭好了')) && bdState.hasBd9 && bdState.runBtn.includes('开跑'),
    detail: JSON.stringify({ drawerOn, msgs: bdState.msgs.length, hasBd9: bdState.hasBd9, runBtn: bdState.runBtn })
  });

  const run9Pt = await centerOf('#bdMsgs [data-bdrun]');
  await realClick(run9Pt);
  await wait(700);
  results.push({ name: '搭台结果一键开跑', ok: runCalls >= 2, detail: `canvas:run-node 已调用 ${runCalls} 次` });
  // ---------- 7.5) 搭台截图：📷 → 预览 → 发送带图 ----------
  const shotPt = await centerOf('#bdShot');
  await realClick(shotPt);
  await wait(500);
  const imgState = await js(`(() => ({
    chips: document.querySelectorAll('#bdImgs .im').length,
    shown: document.getElementById('bdImgs').style.display !== 'none'
  }))()`);
  await js(`(() => { const i = document.getElementById('bdInput'); i.value = '照这个截图搭'; return 1; })()`);
  const sendPt2 = await centerOf('#bdSend');
  await realClick(sendPt2);
  await wait(900);
  results.push({
    name: '搭台截图：📷 截屏出预览且发送带图',
    ok: imgState.chips === 1 && imgState.shown && lastBuilderImages.length === 1 && /^data:image\//.test(lastBuilderImages[0]),
    detail: JSON.stringify({ chips: imgState.chips, imgs: lastBuilderImages.length })
  });


  // 截图（顺便把设置面板闪的那一帧抓住）
  await js("openNodeSettings('n2'); 'ok'");
  await wait(180);
  const png = await win.webContents.capturePage();
  const shot = path.join(os.tmpdir(), 'fde-canvas-settings.png');
  require('fs').writeFileSync(shot, png.toPNG());

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log((r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + r.detail);
  }
  console.log('截图: ' + shot);
  win.destroy();
  app.exit(allOk ? 0 : 1);
 } catch (e) {
  console.log('✗ 测试脚本异常: ' + (e && e.message));
  console.log(e && e.stack ? String(e.stack).slice(0, 800) : '');
  app.exit(1);
 }
});
