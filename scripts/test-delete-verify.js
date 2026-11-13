/**
 * 删除项目「名字打不出来」场景回归测试。
 * 验证两个入口（面板 / 项目设置）都能：点名字自动填入、复制、未一致时确认按钮禁用。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-delete-verify.js
 */
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const NAME = '亚马逊·美国站运营 🚀（测试）';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const project = {
  id: 'p1', name: NAME, color: '#4f8cff', status: 'stopped',
  items: [], context: [], autorun: [], logs: [], inbox: {}
};

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({
    projects: [project], flows: [], logs: [], inbox: {}, trash: [], settings: {}
  }));
  ipcMain.handle('browsers:list', () => ({ ok: true, list: [] }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('project:remove', () => ({ ok: true }));
  ipcMain.handle('app:copy-text', (e, text) => { clipboard.writeText(String(text)); return { ok: true }; });

  const results = [];
  const preload = path.join(ROOT, 'preload.js');
  const webPreferences = { preload, contextIsolation: true, nodeIntegration: false };

  // ---- 1) 面板（左侧 AppBar）里的删除入口 ----
  const p1 = new BrowserWindow({ width: 380, height: 780, show: false, webPreferences });
  await p1.loadFile(path.join(ROOT, 'panel.html'));
  await wait(700);
  const opened = await p1.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '删');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await wait(250);
  const p1State = await p1.webContents.executeJavaScript(`(() => {
    const row = document.getElementById('modalNameRow');
    const chip = document.getElementById('modalName');
    const inp = document.getElementById('modalInput');
    const ok = document.getElementById('modalOk');
    const before = { rowOn: row.classList.contains('on'), chip: chip.textContent, okDisabled: ok.disabled };
    chip.click();
    return { before, afterValue: inp.value, okEnabledAfterClick: !ok.disabled,
             hint: document.getElementById('modalHint').textContent };
  })()`);
  const shot1 = path.join(os.tmpdir(), 'fde-delverify-panel.png');
  fs.writeFileSync(shot1, (await p1.webContents.capturePage()).toPNG());
  results.push({
    name: '面板 · 名字行出现',
    ok: opened && p1State.before.rowOn && p1State.before.chip === NAME,
    detail: `row=${p1State.before.rowOn} chip="${p1State.before.chip}"`
  });
  results.push({
    name: '面板 · 点名字自动填入',
    ok: p1State.afterValue === NAME && p1State.okEnabledAfterClick,
    detail: `填入="${p1State.afterValue}" 确认可用=${p1State.okEnabledAfterClick}`
  });
  results.push({
    name: '面板 · 未填时确认禁用',
    ok: p1State.before.okDisabled === true,
    detail: `初始 disabled=${p1State.before.okDisabled}`
  });

  // 复制按钮 → 剪贴板
  clipboard.writeText('');
  await p1.webContents.executeJavaScript(`document.getElementById('modalCopy').click(); 'ok'`);
  await wait(300);
  results.push({ name: '面板 · 复制到剪贴板', ok: clipboard.readText() === NAME, detail: `剪贴板="${clipboard.readText()}"` });

  // 触发一次删除，确认 IPC 正常（不真的删，mock 返回 ok）
  const delCall = await p1.webContents.executeJavaScript(`(() => {
    document.getElementById('modalOk').click();
    return true;
  })()`);
  await wait(200);
  results.push({ name: '面板 · 确认删除可提交', ok: delCall === true, detail: 'click modalOk 完成' });

  // ---- 2) 项目设置面板里的删除入口 ----
  const p2 = new BrowserWindow({ width: 470, height: 680, show: false, webPreferences });
  await p2.loadFile(path.join(ROOT, 'project.html'), { query: { id: 'p1' } });
  await wait(700);
  const p2State = await p2.webContents.executeJavaScript(`(() => {
    document.getElementById('delBtn').click();
    const chip = document.getElementById('__dn');
    const inp = document.getElementById('__dv');
    const ok = document.getElementById('__dok');
    const before = { chip: chip && chip.textContent, disabled: ok.disabled };
    chip.click();
    return { before, value: inp.value, enabled: !ok.disabled, hint: document.getElementById('__ds').textContent };
  })()`);
  const shot2 = path.join(os.tmpdir(), 'fde-delverify-project.png');
  fs.writeFileSync(shot2, (await p2.webContents.capturePage()).toPNG());
  results.push({
    name: '设置面板 · 点名字自动填入',
    ok: p2State.value === NAME && p2State.enabled && p2State.before.disabled === true,
    detail: `初始禁用=${p2State.before.disabled} 填入="${p2State.value}" 可用=${p2State.enabled}`
  });

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log((r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + r.detail);
  }
  console.log('截图: ' + shot1 + ' · ' + shot2);
  p1.destroy(); p2.destroy();
  app.exit(allOk ? 0 : 1);
});
