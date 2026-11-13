/**
 * 「有窗口没显示」的提示与修复面板测试。
 * 验证：角标数量、点开列出原因、点"修复"调用主进程并更新角标。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-missing-ui.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const projects = [
  { id: 'p1', name: '亚马逊·美国站运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口', windowsCount: 3, items: [], autorun: [], windows: [] }
];

let repairCalls = 0;

app.whenReady().then(async () => {
 try {
  ipcMain.handle('data:get', () => ({
    projects, flows: [], logs: [], inbox: {}, trash: [],
    activeId: 'p1', originalCount: 0, uncontrolled: 0, isAdmin: true,
    settings: { wallpaper: true }
  }));
  ipcMain.handle('desktop:diag', () => ({
    ok: true, activeId: 'p1', total: 3,
    rows: [
      { hwnd: 1, proc: 'chrome', title: '店铺后台 - Amazon Seller Central', reason: 'parked', vis: true, iconic: false },
      { hwnd: 2, proc: 'WeChat', title: '微信', reason: 'hidden', vis: false, iconic: false }
    ],
    missing: [
      { hwnd: 1, proc: 'chrome', title: '店铺后台 - Amazon Seller Central', reason: 'parked' },
      { hwnd: 2, proc: 'WeChat', title: '微信', reason: 'hidden' }
    ]
  }));
  ipcMain.handle('desktop:repair', () => {
    repairCalls++;
    return { ok: true, moved: 1, shown: 1, missing: 0 };
  });
  ipcMain.handle('desktop:switch', () => ({ ok: true, activeId: 'p1' }));
  ipcMain.handle('panel:state', () => ({}));

  const win = new BrowserWindow({
    width: 380, height: 820, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(path.join(ROOT, 'panel.html'));
  await wait(700);

  // 主进程广播"有 2 个窗口没显示"
  const probe = await win.webContents.executeJavaScript(`(() => {
    try {
      const has = typeof state;
      const row = !!document.getElementById('missRow');
      const btn = !!document.getElementById('missBtn');
      if (has === 'object') { state.missing = 2; renderNowDesk(); }
      return { has, row, btn, count: document.getElementById('missN') && document.getElementById('missN').textContent };
    } catch (e) { return { error: String(e && e.message) }; }
  })()`);
  console.log('probe=' + JSON.stringify(probe));
  await wait(150);

  const a = await win.webContents.executeJavaScript(`(() => {
    const row = document.getElementById('missRow');
    return {
      display: getComputedStyle(row).display,
      count: document.getElementById('missN').textContent,
      text: row.textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);

  const shot1 = path.join(os.tmpdir(), 'fde-panel-missing.png');
  fs.writeFileSync(shot1, (await win.webContents.capturePage()).toPNG());

  const safe = async (label, code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log('  · 步骤失败[' + label + ']: ' + (e && e.message)); return null; }
  };

  // 先直连 IPC 看通不通
  const direct = await safe('direct-diag', `(async () => { try { const r = await window.fde.desktopDiag(); return JSON.stringify({ ok: r && r.ok, missing: r && r.missing && r.missing.length }); } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('  · 直接调用 desktopDiag: ' + direct);

  // 打开诊断弹窗（捕获 openDiag 内部异常）
  const opened = await safe('open-diag', `(async () => { try { await openDiag(); return 'opened'; } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('  · openDiag: ' + opened);
  await wait(400);
  const b = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('missModal');
    if (!box) return { open: false };
    return {
      open: true,
      text: box.textContent.replace(/\\s+/g, ' ').trim(),
      items: box.textContent.split('曾经被搬到屏幕外').length - 1
    };
  })()`);
  const shot2 = path.join(os.tmpdir(), 'fde-panel-missing-diag.png');
  fs.writeFileSync(shot2, (await win.webContents.capturePage()).toPNG());

  // 点修复
  await safe('click-repair', `(document.querySelector('#missModal #__dr').click(), 'ok')`);
  await wait(600);
  const c = await win.webContents.executeJavaScript(`(() => {
    const row = document.getElementById('missRow');
    return {
      display: getComputedStyle(row).display,
      modalGone: !document.getElementById('missModal')
    };
  })()`);

  const results = [
    { name: '有窗口没显示时出现提示行', ok: a.display === 'flex' && a.count === '2', detail: a.text },
    { name: '提示文案说清是什么问题', ok: /个窗口没显示/.test(a.text) && /看原因/.test(a.text), detail: a.text },
    { name: '点开能看到逐条原因', ok: b.open && /曾经被搬到屏幕外/.test(b.text) && /窗口被藏起来了/.test(b.text), detail: (b.text || '').slice(0, 120) },
    { name: '列出属于本桌面的窗口总数', ok: b.open && /共 3 个窗口/.test(b.text), detail: (b.text || '').slice(0, 80) },
    { name: '点修复会调用主进程', ok: repairCalls === 1, detail: 'calls=' + repairCalls },
    { name: '修好后提示行消失', ok: c.display === 'none' && c.modalGone, detail: JSON.stringify(c) }
  ];

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log((r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + r.detail);
  }
  console.log('截图: ' + shot1 + ' · ' + shot2);
  win.destroy();
  app.exit(allOk ? 0 : 1);
 } catch (e) {
  console.log('✗ 测试脚本异常: ' + (e && e.message));
  console.log(e && e.stack ? String(e.stack).slice(0, 600) : '');
  app.exit(1);
 }
});
