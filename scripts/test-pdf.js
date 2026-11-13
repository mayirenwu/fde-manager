/**
 * 用真实 Electron 验证 PDF 导出链路：printToPDF + 中文字体 + 分页。
 * 跑法：electron . scripts/test-pdf.js（不是 node！）
 * 产物：临时目录下 test-report.pdf + test-report.png（报告首页截图）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const trust = require('../trust');

app.whenReady().then(async () => {
  const now = Date.now(), day = 86400000;
  const data = {
    stats: { aiCalls: 12, cacheHits: 30, tokensSaved: 48000 },
    projects: [{
      id: 'pk7x2ab', name: '亚马逊·美国站运营', desc: '主店日常运营', status: 'running',
      items: [
        { id: 'i1', name: '导订单报表', path: 'C:/fde/scripts/export-orders.ps1', lastRun: { at: now - 3600000, code: 0, output: 'ok' } },
        { id: 'i2', name: '库存核对', path: 'C:/fde/scripts/check-stock.py', lastRun: { at: now - 7200000, code: 0, output: 'ok' } },
        { id: 'i3', name: '生成补货建议', path: 'C:/fde/scripts/restock.ps1', lastRun: { at: now - day, code: 1, output: 'timeout' } }
      ],
      autorun: [{ name: '店小秘', path: 'C:/app/dxm.exe', delay: 2 }],
      windows: [{ match: '店小秘' }, { match: '卖家后台' }],
      context: [
        { kind: 'file', title: '订单模板', value: 'C:/ctx/order.xlsx' },
        { kind: 'web', title: '卖家后台', value: 'https://sellercentral.amazon.com' },
        { kind: 'text', title: '备货规则', value: '安全库存 14 天，断货优先级高于滞销' }
      ],
      case: {
        client: '华东某跨境卖家（示例）', industry: '跨境电商 · 亚马逊美国站',
        pain: '每天上午 3 个人工后台导报表、手工核对库存，一次约 2 小时，出错难排查',
        solution: '拆成导表、核对、补货建议 3 个脚本，异常行由人工复核',
        quote: '以前每天上午都在忙这个，现在点一下，回来看异常清单就行。',
        allowPublish: true, manualMinutes: 120, hourlyRate: 80,
        since: now - 30 * day, owner: '（示例）张三', contact: '王经理 · 运营负责人'
      }
    }],
    logs: [], canvas: { nodes: [], edges: [] }
  };
  // 给足执行历史，看长表格分页效果
  const p = data.projects[0];
  for (let i = 0; i < 55; i++) {
    data.logs.push({
      time: now - i * 3600000 * 5, projectId: p.id,
      text: (i % 11 === 7 ? '脚本失败(退出码 1): 生成补货建议 · 输出: timeout' : '脚本完成: ' + p.items[i % 3].name)
    });
  }

  const ev = trust.collectEvidence(data, 'pk7x2ab', {});
  const reportHtml = trust.renderReportHtml(ev, { operator: '（示例）张三 · FDE', isAdmin: false });
  const caseHtml = trust.renderCaseHtml(ev, {});
  const facts = trust.securityFacts(data, {
    dataRoot: os.tmpdir(), dataFile: path.join(os.tmpdir(), 'fde-data.json'),
    dataSize: 34816, mode: 'standard', source: '', appDir: __dirname, version: '2.1.0', isAdmin: false
  });
  const secHtml = trust.renderSecurityHtml(facts, data);

  const out = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  });

  async function produce(name, html) {
    const tmp = path.join(os.tmpdir(), 'trust-' + name + '.html');
    fs.writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    await new Promise(r => setTimeout(r, 260));
    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'trust-' + name + '-p1.png'), png.toPNG());
    const buf = await win.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    const fp = path.join(os.tmpdir(), 'trust-' + name + '.pdf');
    fs.writeFileSync(fp, buf);
    out.push({ name, pdf: fp, pages: Math.max(1, Math.round(buf.length / 45000)), size: buf.length });
  }

  try {
    await produce('report', reportHtml);
    await produce('case', caseHtml);
    await produce('security', secHtml);
  } catch (e) {
    console.log('FAIL: ' + e.message);
    app.exit(1);
    return;
  }
  win.destroy();

  let ok = true;
  for (const o of out) {
    const head = fs.readFileSync(o.pdf).slice(0, 5).toString();
    const good = head === '%PDF-' && o.size > 20000;
    if (!good) ok = false;
    console.log((good ? '✓' : '✗') + ' ' + o.name + '.pdf  ' + Math.round(o.size / 1024) + ' KB  首字节: ' + head.trim());
  }
  console.log('产物目录: ' + os.tmpdir());
  app.exit(ok ? 0 : 1);
});
