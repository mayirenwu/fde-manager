const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const FAKE = {
  titles: ['给爸妈洗澡这件事，我拖了三年才解决','装完第一晚，我妈说早该买了','不是所有老人都愿意让人扶','家里有老人的，浴室这一步别省','花一百多改掉一个隐患'],
  body: '我妈今年七十二，浴室地滑这件事我提醒了很多次，她总说扶着墙就行。\n\n后来装了免打孔折叠洗澡椅，夹上去拧紧就行，十分钟装完。\n\n用了几个真实变化：她愿意用了、收起来不占地、底部防滑不晃。\n\n这类东西不用买贵的，但一定要装得稳。买之前量一下尺寸。',
  tags: ['适老化改造','居家安全','老人洗澡','适老好物','给爸妈买什么','浴室安全','防滑','居家改造'],
  cover: '爸妈的浴室\n这一步别省',
  images: ['浴室实拍：老人坐着洗澡的侧面','细节图：防滑脚垫与卡扣特写','收纳状态：折叠后靠墙'],
  risks: ['不要写防摔功效承诺']
};
app.whenReady().then(async () => {
  ipcMain.handle('app:open-url', () => ({ ok: true }));
  ipcMain.handle('search:open', () => ({ ok: true }));
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));
  ipcMain.handle('ai:chat', () => ({ ok: true, model: 'mock', text: '```json\n' + JSON.stringify(FAKE) + '\n```' }));
  ipcMain.handle('models:catalog', () => ({ ok: true, groups: { chat: [], image: [{ id: 'img-1' }], video: [], audio: [] } }));
  ipcMain.handle('media:generate', () => ({ ok: true, taskId: 1 }));
  ipcMain.handle('media:status', () => ({ ok: true, status: { done: true, ok: true, urls: ['https://example.com/a.png'], statusText: '完成' } }));
  ipcMain.handle('ecom:export', (e, p) => {
    const cover = (p.files || []).find(f => f.name === '03-首图.png') || {};
    const m = String(cover.dataUrl || '').match(/^data:image\/png;base64,([\s\S]*)$/);
    if (m) require('fs').writeFileSync(path.join(os.tmpdir(), 'fde-cover.png'), Buffer.from(m[1], 'base64'));
    const list = (p.files || []).find(f => f.name === '05-发布清单.txt') || {};
    if (list.text) require('fs').writeFileSync(path.join(os.tmpdir(), 'fde-list.txt'), list.text, 'utf8');
    return { ok: true, dir: path.join(os.tmpdir(), 'fde-pack-demo'), files: (p.files || []).map(f => f.name), failed: [] };
  });
  ipcMain.handle('ecom:show', () => ({ ok: true }));
  const win = new BrowserWindow({ width: 1220, height: 880, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', 'ecom.html'));
  await wait(500);
  await win.webContents.executeJavaScript(`document.querySelector('#agedBtn').click(); document.querySelector('#autoBtn').click(); 1`);
  await wait(4200);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(os.tmpdir(), 'fde-auto.png'), img.toPNG());
  // 顺手导出全自动生成的首图，看看长什么样
  console.log('SHOT ok');
  app.exit(0);
});
