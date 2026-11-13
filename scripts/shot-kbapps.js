const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const kb = require('../kb');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shot-'));
app.setPath('userData', path.join(TMP, 'ud'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SRC = path.join(TMP, 'FDE知识库');
fs.mkdirSync(path.join(SRC, '适老改造方案'), { recursive: true });
fs.mkdirSync(path.join(SRC, '客户档案'), { recursive: true });
fs.mkdirSync(path.join(SRC, '小红书笔记'), { recursive: true });
fs.writeFileSync(path.join(SRC, '适老改造方案', '浴室防滑改造方案.md'), '# 浴室防滑改造方案\n\n基础包 1980 元。\n');
fs.writeFileSync(path.join(SRC, '适老改造方案', '施工清单.md'), '# 施工清单\n\n1. 量尺寸\n');
fs.writeFileSync(path.join(SRC, '客户档案', '张阿姨.md'), '# 客户 张阿姨\n\n72 岁独居。\n');
fs.writeFileSync(path.join(SRC, '小红书笔记', '洗澡椅笔记.md'), '# 洗澡椅笔记\n\n标题：给爸妈洗澡这件事\n');
app.whenReady().then(async () => {
  const store = kb.createStore(path.join(app.getPath('userData'), 'kb'));
  ipcMain.handle('apps:get', () => ({ items: [], trash: [], stats: { total: 0 }, kinds: {} }));
  ipcMain.handle('ai:get', () => ({ ok: true, hasKey: false, model: '', baseUrl: '', models: [], status: { level: 'off', text: '' } }));
  ipcMain.handle('kb:load', () => { const st = store.load(); return { ok: true, libs: st.libs, docs: st.docs, kinds: kb.KINDS }; });
  ipcMain.handle('kb:save', (e, p) => { const st = store.load(); if (p.libs) st.libs = p.libs; store.save(st); return { ok: true }; });
  ipcMain.handle('kb:pick-dir', () => ({ ok: true, dir: SRC }));
  ipcMain.handle('kb:scan', (e, p) => Object.assign({ ok: true }, kb.scanDir(p.dir)));
  ipcMain.handle('kb:add-docs', (e, p) => store.addDocs(p.libId, p.files));
  ipcMain.handle('kb:search', (e, p) => ({ ok: true, hits: store.search(p.q, '', 10) }));
  ipcMain.handle('kb:doc-text', (e, id) => { const d = store.load().docs.find(x => x.id === id); return { ok: true, doc: d, text: store.textOf(d) }; });
  const win = new BrowserWindow({ width: 1280, height: 880, show: false, paintWhenInitiallyHidden: true, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegrationInSubFrames: true } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) console.log('PAGE', msg.slice(0, 200)); });
  win.webContents.mainFrame.frames; // noop
  await win.loadFile(path.join(__dirname, '..', 'apps.html'));
  win.webContents.on('frame-created', (e, d) => { try { d.frame.on('console-message', (x, lvl, msg) => { if (lvl >= 2) console.log('FRAME', msg.slice(0, 200)); }); } catch (err) {} });
  await wait(600);
  await win.webContents.executeJavaScript(`document.querySelector('#seg button[data-tab="kb"]').click(); 1`);
  await wait(1200);
  const f = win.webContents.mainFrame.frames.find(x => /kb\.html/.test(x.url || ''));
  await f.executeJavaScript(`document.querySelector('#seedLibsBtn').click(); 1`);
  await wait(700);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-kb-tab.png'), img.toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('#seg button[data-tab="apps"]').click(); 1`);
  await wait(600);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-apps-rail.png'), img.toPNG());
  await win.webContents.executeJavaScript(`document.getElementById('kbEntRow').click(); 1`);
  await wait(500);
  await f.executeJavaScript(`document.querySelector('#impDirBtn').click(); 1`);
  await wait(1200);
  const dbg = await f.executeJavaScript(`(() => ({
    mask: document.querySelector('#impMask').className,
    title: (document.querySelector('#impTitle') || {}).textContent,
    stat: (document.querySelector('#impStat') || {}).textContent.slice(0, 80),
    modeRow: getComputedStyle(document.querySelector('#impModeRow')).display
  }))()`);
  console.log('DBG', JSON.stringify(dbg));
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-kb-import.png'), img.toPNG());
  console.log('SHOT ok');
  app.exit(0);
});
