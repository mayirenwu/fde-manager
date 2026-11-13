/**
 * 项目设置里「网页项换浏览器」回归测试。
 * 以前只能在新增时选定浏览器，要换就得删掉重加；现在每条网页项都能直接换。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-url-browser.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const BROWSERS = [
  { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: '360安全浏览器', path: 'C:\\Users\\u\\AppData\\Roaming\\secoresdk\\360se6\\Application\\360se.exe' }
];

const project = {
  id: 'p1', name: '演示项目', color: '#4f8cff', status: 'stopped',
  items: [], context: [], logs: [], inbox: {},
  autorun: [
    { id: 'a1', type: 'url', url: 'https://sellercentral.amazon.com', delay: 0, browserPath: '', browserName: '' },
    { id: 'a2', type: 'exe', path: 'C:\\app\\trade.exe', args: '', delay: 3 }
  ]
};

const calls = { setBrowser: [], remove: 0 };

app.whenReady().then(async () => {
 try {
  ipcMain.handle('data:get', () => ({
    projects: [JSON.parse(JSON.stringify(project))], flows: [], logs: [], inbox: {}, trash: [], settings: {}
  }));
  ipcMain.handle('browsers:list', () => ({ ok: true, list: BROWSERS }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('autorun:remove', () => { calls.remove++; return { ok: true }; });
  ipcMain.handle('autorun:setbrowser', (e, payload) => {
    calls.setBrowser.push(payload);
    const a = project.autorun.find(x => x.id === payload.itemId);
    if (a) { a.browserPath = payload.browserPath; a.browserName = payload.browserName; }
    return { ok: true, browserPath: payload.browserPath, browserName: payload.browserName };
  });

  const win = new BrowserWindow({
    width: 480, height: 780, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'project.html'), { query: { id: 'p1' } });
  await wait(900);
  // 切到「设置」页签（自动打开列表在那）
  await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('[data-pane="set"]');
    if (t) t.click();
    return 'ok';
  })()`);
  await wait(500);
  // 浏览器清单是异步拿的，等下拉里出现选项
  for (let i = 0; i < 30; i++) {
    const n = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#autorunList select').length");
    if (n > 0) break;
    await wait(200);
  }

  const results = [];

  const before = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#autorunList .witem')];
    const sel = document.querySelector('#autorunList select');
    return {
      rows: rows.length,
      selects: document.querySelectorAll('#autorunList select').length,
      opts: sel ? [...sel.options].map(o => o.textContent) : [],
      value: sel ? sel.value : null,
      t2: rows.length ? rows[0].querySelector('.t2').textContent : ''
    };
  })()`);

  results.push({
    name: '网页项出现「换浏览器」下拉',
    ok: before.selects === 1 && before.opts.length === BROWSERS.length + 1 && before.value === '',
    detail: `下拉 ${before.selects} 个 · 选项 ${JSON.stringify(before.opts)} · 当前值「${before.value}」`
  });
  results.push({
    name: '程序项没有浏览器下拉',
    ok: before.rows === 2 && before.selects === 1,
    detail: `条目 ${before.rows} 个 · 下拉 ${before.selects} 个`
  });
  results.push({
    name: '网址行不再写死「默认浏览器」',
    ok: before.t2 === 'https://sellercentral.amazon.com',
    detail: `第二行「${before.t2}」`
  });

  // 换成 Chrome
  const changed = await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('#autorunList select');
    sel.value = ${JSON.stringify(BROWSERS[0].path)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await wait(700);
  const c1 = calls.setBrowser[calls.setBrowser.length - 1] || {};
  results.push({
    name: '换浏览器 → 存进这个项目',
    ok: changed === 'ok' && calls.setBrowser.length === 1 &&
        c1.projectId === 'p1' && c1.itemId === 'a1' &&
        c1.browserPath === BROWSERS[0].path && c1.browserName === 'Google Chrome',
    detail: `IPC ${calls.setBrowser.length} 次 · ${JSON.stringify(c1)}`
  });

  const after = await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('#autorunList select');
    const val = sel ? sel.value : null;
    const rows = [...document.querySelectorAll('#autorunList .witem')];
    return { val, t2: rows.length ? rows[0].querySelector('.t2').textContent : '' };
  })()`);
  results.push({
    name: '刷新后仍显示新浏览器',
    ok: after.val === BROWSERS[0].path,
    detail: `下拉当前值「${after.val}」`
  });
  results.push({
    name: '没有删掉重加',
    ok: calls.remove === 0,
    detail: `删除调用 ${calls.remove} 次`
  });

  // 换回默认
  await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('#autorunList select');
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await wait(600);
  const back = calls.setBrowser[calls.setBrowser.length - 1] || {};
  results.push({
    name: '可以换回「默认浏览器」',
    ok: calls.setBrowser.length === 2 && back.browserPath === '' && back.browserName === '',
    detail: `${JSON.stringify(back)}`
  });

  // 截图
  await win.webContents.invalidate();
  await wait(250);
  const shot = path.join(os.tmpdir(), 'fde-url-browser.png');
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());

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
