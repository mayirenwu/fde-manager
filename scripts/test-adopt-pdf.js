/**
 * 用真实 Electron 渲染三份角色说明，验证一页装得下、中文正常。
 * 跑法：electron scripts/test-adopt-pdf.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const trust = require('../trust');
const adopt = require('../adopt');

const now = Date.now();

const data = {
  stats: {}, canvas: { nodes: [], edges: [] },
  projects: [{
    id: 'pk7x2ab', name: '亚马逊·美国站订单处理',
    items: [
      { id: 'i1', name: '导出订单报表', path: 'C:/fde/scripts/export-orders.ps1', lastRun: { at: now - 3600000, code: 0 } },
      { id: 'i2', name: '库存核对', path: 'C:/fde/scripts/check-stock.py', lastRun: { at: now - 7200000, code: 0 } },
      { id: 'i3', name: '生成补货建议', path: 'C:/fde/scripts/restock.ps1', lastRun: { at: now - 86400000, code: 1 } }
    ],
    autorun: [], windows: [],
    context: [
      { kind: 'file', title: '订单导出模板', value: 'C:/ctx/order-template.xlsx' },
      { kind: 'dir', title: '每日报表目录', value: 'D:/运营/日结报表' },
      { kind: 'web', title: '卖家后台', value: 'https://sellercentral.amazon.com' },
      { kind: 'text', title: '备货规则', value: '安全库存 14 天' }
    ],
    case: { client: '华东某跨境卖家', manualMinutes: 120, hourlyRate: 80, allowPublish: true },
    stakeholders: [], adoption: {}
  }]
};
data.logs = [];
for (let i = 0; i < 20; i++) {
  data.logs.push({ time: now - i * 86400000, projectId: 'pk7x2ab', text: '脚本完成: 导出订单报表' });
}

const ev = trust.collectEvidence(data, 'pk7x2ab', {});
const adoption = {
  flowName: '亚马逊订单处理',
  perRunMinutes: 120, reviewMinutes: 5, monthlyRuns: 20, hourlyRate: 80, monthlyFee: 800,
  operatorName: '老王', reviewerName: '李会计', contact: '老王 138xxxx',
  steps: [
    { step: '导订单', before: '你逐个后台导出、另存', after: '程序自动导出', you: '确认有没有缺表' },
    { step: '核对库存', before: '你一行行对', after: '程序比对出差异清单', you: '判断差异要不要处理' },
    { step: '出补货建议', before: '你凭经验估', after: '程序按你定的规则算', you: '改规则、拍板' }
  ]
};
const calc = adopt.computeAdoption(ev, adoption);
const docs = {
  boss: adopt.renderBossBrief(ev, adoption, calc),
  operator: adopt.renderOperatorBrief(ev, adoption, calc),
  reviewer: adopt.renderReviewerNote(ev, adoption, calc)
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  });
  const out = [];
  for (const k of Object.keys(docs)) {
    const tmp = path.join(os.tmpdir(), 'adopt-' + k + '.html');
    fs.writeFileSync(tmp, docs[k], 'utf8');
    await win.loadFile(tmp);
    await new Promise(r => setTimeout(r, 280));
    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'adopt-' + k + '-p1.png'), png.toPNG());
    const buf = await win.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    fs.writeFileSync(path.join(os.tmpdir(), 'adopt-' + k + '.pdf'), buf);
    out.push({ k, size: buf.length, head: buf.slice(0, 5).toString() });
  }
  win.destroy();
  let ok = true;
  for (const o of out) {
    const good = o.head === '%PDF-' && o.size > 15000;
    if (!good) ok = false;
    console.log((good ? '✓' : '✗') + ' ' + o.k + '.pdf  ' + Math.round(o.size / 1024) + ' KB');
  }
  console.log('目录: ' + os.tmpdir());
  app.exit(ok ? 0 : 1);
});
