/**
 * 信任中心：把「过程数据」变成客户能看懂、能签字、能带走的文件。
 *
 * 设计原则（很重要，改代码时别破坏）：
 *  1. 所有数字必须有出处。测算类数字必须标注口径，不写"提升 300%"这种无法验证的话。
 *  2. 安全声明必须是程序里真实成立的事实（例如"零外发"），不能是文案。
 *  3. 输出的都是可打印的浅色文档（给客户/纸/PDF），不是深色界面。
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const fmtDate = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const fmtDur = (ms) => {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分' + (s % 60 ? ' ' + (s % 60) + ' 秒' : '');
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
};

/** 从日志里还原脚本执行历史（日志是追加式的，比 item.lastRun 只有最后一次更可信） */
function parseRuns(logs, projectId) {
  const out = [];
  for (const l of logs || []) {
    if (projectId && l.projectId !== projectId) continue;
    const t = String(l.text || '');
    let m = t.match(/^脚本完成:\s*([^·]+?)(?:\s*·.*)?$/);
    if (m) { out.push({ at: l.time, name: m[1].trim(), ok: true, code: 0 }); continue; }
    m = t.match(/^脚本失败\(退出码\s*(-?\d+)\):\s*([^·]+?)(?:\s*·.*)?$/);
    if (m) { out.push({ at: l.time, name: m[2].trim(), ok: false, code: Number(m[1]) }); continue; }
    m = t.match(/^脚本运行出错:\s*([^-]+?)\s*-/);
    if (m) { out.push({ at: l.time, name: m[1].trim(), ok: false, code: -1 }); }
  }
  return out.reverse();
}

/** 收集一个项目的全部可证明材料 */
function collectEvidence(data, projectId, opts) {
  const o = opts || {};
  const p = (data.projects || []).find(x => x.id === projectId);
  if (!p) return null;
  const cs = p.case || {};
  const from = o.from || 0;
  const to = o.to || Date.now();

  let runs = parseRuns(data.logs, p.id).filter(r => r.at >= from && r.at <= to);
  // 日志只留最近 200 条，早期运行会丢。用脚本项自带的最后一次运行补足，避免"数字偏小"
  for (const it of p.items || []) {
    if (!it.lastRun || !it.lastRun.at) continue;
    if (it.lastRun.at < from || it.lastRun.at > to) continue;
    if (runs.some(r => r.at === it.lastRun.at && r.name === it.name)) continue;
    runs.push({ at: it.lastRun.at, name: it.name, ok: it.lastRun.code === 0, code: it.lastRun.code, fromItem: true });
  }
  runs.sort((a, b) => a.at - b.at);

  const scripts = (p.items || []).filter(i => i.path);
  const autorun = p.autorun || [];
  const wins = p.windows || [];
  const ctx = p.context || [];
  const canvasNodes = ((data.canvas || {}).nodes || []).filter(n => n.ref && n.ref.projectId === p.id);

  const okRuns = runs.filter(r => r.ok).length;
  const manualMinutes = Number(cs.manualMinutes || 0);
  const hourlyRate = Number(cs.hourlyRate || 0);
  const savedMinutes = Math.round(okRuns * manualMinutes);
  const savedYuan = Math.round((savedMinutes / 60) * hourlyRate);

  const allTimes = runs.map(r => r.at);
  const since = cs.since || (allTimes.length ? Math.min(...allTimes) : 0);

  return {
    project: {
      id: p.id, name: p.name, desc: p.desc || '',
      status: p.status, exclusive: p.exclusive !== false,
      color: p.color || '#4f8cff'
    },
    case: {
      client: cs.client || '', industry: cs.industry || '',
      pain: cs.pain || '', solution: cs.solution || '',
      quote: cs.quote || '', allowPublish: !!cs.allowPublish,
      manualMinutes, hourlyRate, since, owner: cs.owner || '',
      contact: cs.contact || ''
    },
    counts: {
      scripts: scripts.length, autorun: autorun.length,
      windows: wins.length, context: ctx.length, canvasNodes: canvasNodes.length,
      runs: runs.length, okRuns, failRuns: runs.length - okRuns,
      successRate: runs.length ? Math.round(okRuns / runs.length * 100) : null,
      firstRun: allTimes.length ? Math.min(...allTimes) : 0,
      lastRun: allTimes.length ? Math.max(...allTimes) : 0
    },
    saved: { minutes: savedMinutes, yuan: savedYuan, perRun: manualMinutes, rate: hourlyRate },
    runs,
    scripts: scripts.map(i => ({
      name: i.name, path: i.path,
      lastAt: i.lastRun ? i.lastRun.at : 0,
      lastCode: i.lastRun ? i.lastRun.code : null,
      launch: i.launch || ''
    })),
    autorun: autorun.map(a => ({ name: a.name || '', path: a.path || a.cmd || '', delay: a.delay || 0, optional: !!a.optional })),
    windows: wins.map(w => ({ match: w.match || w.title || '', title: w.title || '' })),
    context: ctx.map(c => ({ kind: c.kind, title: c.title || c.value || '', value: c.value || '', note: c.note || '' })),
    canvasNodes: canvasNodes.map(n => ({ title: n.title, type: n.type })),
    range: { from, to }
  };
}

/** 安全事实：全部由运行时真实状态推导，不写死文案 */
function securityFacts(data, rt) {
  const r = rt || {};
  const scriptsWithNet = [];
  return {
    dataRoot: r.dataRoot || '',
    dataFile: r.dataFile || '',
    dataSize: r.dataSize || 0,
    mode: r.mode || 'standard',
    source: r.source || '',
    appDir: r.appDir || '',
    version: r.version || '',
    isAdmin: !!r.isAdmin,
    outbound: [],           // FDE 本体没有对外请求，这里为空就是最好的证明
    aiMode: 'local-only',   // 提示词走剪贴板 / 本机应用，不进任何第三方接口
    aiStats: data.stats || { aiCalls: 0, cacheHits: 0, tokensSaved: 0 },
    projects: (data.projects || []).length,
    scriptsWithNet
  };
}

// ---------- 文档骨架 ----------
const PRINT_CSS = `
  @page { size: A4; margin: 15mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #14181f; background: #fff;
    font: 12px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1 { font-size: 21px; margin: 0 0 4px; letter-spacing: .3px; }
  h2 { font-size: 13.5px; margin: 22px 0 8px; padding-bottom: 5px; border-bottom: 1.5px solid #14181f; }
  h2 .no { color: #8a93a3; font-weight: 500; margin-right: 6px; }
  .sub { color: #6b7385; font-size: 11.5px; }
  .cover { border: 2px solid #14181f; border-radius: 4px; padding: 22px 24px; margin-bottom: 6px; }
  .cover .kicker { font-size: 10.5px; letter-spacing: 2px; color: #6b7385; text-transform: uppercase; }
  .cover .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-top: 16px; font-size: 11.5px; }
  .cover .meta b { display: inline-block; width: 62px; color: #6b7385; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
  th, td { border: 1px solid #cfd5df; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f4f8; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 4px; }
  .kpi { border: 1px solid #cfd5df; border-radius: 4px; padding: 9px 10px; }
  .kpi .v { font-size: 19px; font-weight: 700; letter-spacing: .5px; line-height: 1.2; }
  .kpi .l { font-size: 10px; color: #6b7385; margin-top: 2px; }
  .kpi .n { font-size: 9.5px; color: #98a0ae; margin-top: 2px; }
  .note { background: #f7f8fa; border-left: 3px solid #7c8798; padding: 8px 11px; font-size: 11px; color: #4a5262; margin: 8px 0; }
  .warn { border-left-color: #b8863b; background: #fdf9f0; }
  .ok { border-left-color: #3f8f5e; background: #f3faf5; }
  ul { margin: 6px 0; padding-left: 18px; }
  li { margin: 3px 0; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 26px; page-break-inside: avoid; }
  .sign .box { border-top: 1px solid #14181f; padding-top: 7px; font-size: 11px; color: #4a5262; }
  .sign .box .ln { height: 40px; }
  .foot { margin-top: 24px; padding-top: 8px; border-top: 1px solid #dfe3ea; font-size: 9.5px; color: #8a93a3; }
  .pb { page-break-before: always; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 10px; word-break: break-all; }
  .path { color: #4a5262; }
  .bar { height: 6px; background: #e8ebf1; border-radius: 3px; overflow: hidden; margin-top: 5px; }
  .bar > i { display: block; height: 100%; background: #3f8f5e; }
`;

function docWrap(title, body) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><title>' + esc(title) +
    '</title><style>' + PRINT_CSS + '</style></head><body>' + body + '</body></html>';
}

/** 交付与验收报告（这是客户签字的那张纸） */
function renderReportHtml(ev, meta) {
  const m = meta || {};
  const c = ev.counts;
  const shortId = String(ev.project.id).replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase().padStart(4, '0');
  const no = 'FDE-' + shortId + '-' +
    new Date().getFullYear() + pad(new Date().getMonth() + 1) + pad(new Date().getDate());

  const kpi = (v, l, n) => '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div>' +
    (n ? '<div class="n">' + n + '</div>' : '') + '</div>';

  const runRows = ev.runs.length
    ? ev.runs.slice(-40).map((r, i) =>
      '<tr><td class="num">' + (i + 1) + '</td><td>' + fmtTime(r.at) + '</td><td>' + esc(r.name) + '</td>' +
      '<td>' + (r.ok ? '成功' : '失败') + '</td><td class="num">' + (r.code == null ? '—' : r.code) + '</td>' +
      '<td>' + (r.fromItem ? '脚本记录' : '运行日志') + '</td></tr>').join('')
    : '<tr><td colspan="6" style="text-align:center;color:#8a93a3;">统计周期内无脚本执行记录</td></tr>';

  const scriptRows = ev.scripts.length
    ? ev.scripts.map(s => '<tr><td>' + esc(s.name) + '</td><td class="mono path">' + esc(s.path) + '</td>' +
      '<td>' + (s.lastAt ? fmtTime(s.lastAt) : '未运行') + '</td>' +
      '<td>' + (s.lastCode == null ? '—' : (s.lastCode === 0 ? '成功' : '失败 ' + s.lastCode)) + '</td></tr>').join('')
    : '<tr><td colspan="4" style="text-align:center;color:#8a93a3;">尚未登记脚本</td></tr>';

  const ctxRows = ev.context.length
    ? ev.context.map(x => '<tr><td>' + esc(x.kind) + '</td><td>' + esc(x.title) + '</td><td class="mono path">' +
      esc(String(x.value).slice(0, 90)) + '</td></tr>').join('')
    : '<tr><td colspan="3" style="text-align:center;color:#8a93a3;">未登记上下文材料</td></tr>';

  const successBar = c.successRate == null ? '' :
    '<div class="bar"><i style="width:' + c.successRate + '%"></i></div>';

  const body =
    '<div class="cover">' +
      '<div class="kicker">Delivery &amp; Acceptance Report</div>' +
      '<h1>交付与验收报告</h1>' +
      '<div class="sub">' + esc(ev.project.name) + (ev.case.client ? ' · 客户：' + esc(ev.case.client) : '') + '</div>' +
      '<div class="meta">' +
        '<div><b>报告编号</b>' + no + '</div>' +
        '<div><b>生成时间</b>' + fmtTime(Date.now()) + '</div>' +
        '<div><b>服务方</b>' + esc(ev.case.owner || m.operator || '（填写服务方名称）') + '</div>' +
        '<div><b>客户方</b>' + esc(ev.case.client || '（填写客户名称）') + '</div>' +
        '<div><b>服务周期</b>' + fmtDate(ev.case.since || ev.range.from || c.firstRun) + ' 至 ' +
          fmtDate(ev.range.to || Date.now()) + '</div>' +
        '<div><b>交付形态</b>本地运行（数据不出客户机器）</div>' +
      '</div>' +
    '</div>' +
    '<div class="note"><b>这份报告说明什么：</b>下面每一行都来自这台机器上的真实运行记录，不是估算，可逐条核对。' +
      '业务效果相关的数字单独放在第 6 节，并写明了计算口径，客户可以按自己的口径重算。</div>' +

    '<h2><span class="no">1</span>交付摘要</h2>' +
    '<div class="kpis">' +
      kpi(c.scripts, '自动化脚本', '可重复执行的流程数') +
      kpi(c.autorun, '开机自动项', '进入工作台自动拉起') +
      kpi(c.runs, '执行次数', '统计周期内') +
      kpi(c.successRate == null ? '—' : c.successRate + '%', '执行成功率', c.okRuns + ' 成功 / ' + c.failRuns + ' 失败') +
    '</div>' +
    successBar +
    '<div class="kpis" style="margin-top:10px;">' +
      kpi(c.windows, '纳管窗口', '按项目隔离') +
      kpi(c.context, '上下文材料', '数据源 / 文档 / 账号说明') +
      kpi(c.canvasNodes, '工作流节点', '梳理清楚的步骤') +
      kpi(c.lastRun ? fmtDate(c.lastRun) : '—', '最近一次运行', '') +
    '</div>' +

    '<h2><span class="no">2</span>这套工作台做了什么（逐项可核）</h2>' +
    '<ul>' +
      (c.runs ? '<li>累计执行 <b>' + c.runs + '</b> 次，其中成功 <b>' + c.okRuns + '</b> 次，全部记录可回溯。</li>' : '') +
      (c.scripts ? '<li>把 <b>' + c.runs + '</b> 次人工操作固化为 <b>' + c.scripts + '</b> 个可重复执行的脚本，同一个动作不再靠人记。</li>' : '') +
      (c.windows ? '<li>把 <b>' + c.windows + '</b> 个窗口按项目隔离在独立桌面，切换项目不会串台、不会互相干扰。</li>' : '') +
      (c.context ? '<li>把散落在聊天记录、Excel、同事脑子里的 <b>' + c.context + '</b> 项资料固化成项目上下文，换人接手时不用重新问一遍。</li>' : '') +
      (c.canvasNodes ? '<li>把流程画成 <b>' + c.canvasNodes + '</b> 个工作流节点，谁在什么时候做什么，图上能直接看出来。</li>' : '') +
      (!c.runs && !c.scripts && !c.windows && !c.context && !c.canvasNodes ?
        '<li style="color:#8a93a3;">统计周期内暂无运行记录。先把流程跑起来，报告会随使用自动充实。</li>' : '') +
    '</ul>' +

    '<h2><span class="no">3</span>脚本清单</h2>' +
    '<table><thead><tr><th style="width:26%">名称</th><th>路径</th><th style="width:18%">最近运行</th><th style="width:12%">结果</th></tr></thead>' +
    '<tbody>' + scriptRows + '</tbody></table>' +

    '<h2><span class="no">4</span>执行记录（可逐条核对）</h2>' +
    '<table><thead><tr><th class="num" style="width:5%">#</th><th style="width:22%">时间</th><th>脚本</th>' +
    '<th style="width:10%">结果</th><th class="num" style="width:8%">退出码</th><th style="width:16%">来源</th></tr></thead>' +
    '<tbody>' + runRows + '</tbody></table>' +
    (ev.runs.length > 40 ? '<div class="note">仅显示最近 40 条，完整记录见本机运行日志。</div>' : '') +

    '<h2><span class="no">5</span>上下文材料清单</h2>' +
    '<table><thead><tr><th style="width:14%">类型</th><th style="width:36%">名称</th><th>指向</th></tr></thead>' +
    '<tbody>' + ctxRows + '</tbody></table>' +

    '<h2><span class="no">6</span>业务效果（含计算口径）</h2>' +
    '<table><thead><tr><th style="width:40%">指标</th><th class="num">数值</th><th>口径说明</th></tr></thead><tbody>' +
      '<tr><td>单次人工耗时（客户确认）</td><td class="num">' + (ev.saved.perRun ? ev.saved.perRun + ' 分钟' : '待填') + '</td>' +
        '<td>由客户与服务方在附件中共同确认，作为折算基准</td></tr>' +
      '<tr><td>成功执行次数</td><td class="num">' + c.okRuns + '</td><td>第 4 节中结果为「成功」的条数</td></tr>' +
      '<tr><td>折算节省人工工时</td><td class="num">' + (ev.saved.minutes ? Math.round(ev.saved.minutes / 60 * 10) / 10 + ' 小时' : '—') + '</td>' +
        '<td>成功次数 × 单次人工耗时；<b>未扣除人工复核时间</b></td></tr>' +
      '<tr><td>折算人力成本</td><td class="num">' + (ev.saved.yuan ? '¥' + ev.saved.yuan.toLocaleString('zh-CN') : '—') + '</td>' +
        '<td>节省工时 × 客户提供的小时成本' + (ev.saved.rate ? '（¥' + ev.saved.rate + '/小时）' : '（未提供，不计）') + '</td></tr>' +
    '</tbody></table>' +
    '<div class="note warn"><b>口径声明：</b>上述节省数据为「按客户确认的基准折算」，属于内部参考，不构成对结果的承诺。' +
      '双方约定的效果指标以《服务等级附件》为准。执行过程中的失败记录已完整保留在第 4 节，未做筛选。</div>' +
    '<div class="note ok"><b>关于人员：</b>本项目的目标是减少重复性操作，不涉及人员编制调整。' +
      '编制决策由客户自行作出，服务方不参与、不提供任何裁减建议；流程中需要判断的环节仍由客户人员负责。</div>' +

    '<h2><span class="no">7</span>数据与安全</h2>' +
    '<ul>' +
      '<li><b>数据存放：</b>全部保存在客户本机（或客户指定的目录），不上传任何云端；程序本体不向外部服务器发送数据。</li>' +
      '<li><b>AI 使用：</b>默认不调用第三方模型接口；需要模型能力时由人复制上下文到自有账号使用，客户数据不经过服务方服务器。</li>' +
      '<li><b>权限：</b>' + (m.isAdmin ? '本次运行需要管理员权限（涉及窗口纳管/壁纸切换），已在客户知情下使用。' :
        '常规操作不需要管理员权限；仅窗口纳管等特定功能在授权后使用。') + '</li>' +
      '<li><b>退出机制：</b>服务结束时可导出完整环境快照，客户可用同一程序继续运行，不需要服务方在场。</li>' +
    '</ul>' +

    (() => {
      const list = Array.isArray(m.acks) ? m.acks : [];
      if (!list.length) return '';
      const st = m.ackStats || {};
      const mark = { ok: '已确认', object: '有异议', pending: '待确认' };
      const rows = list.map(a =>
        '<tr><td>' + esc(a.title) + '</td><td style="width:14%">' + (mark[a.state] || '待确认') + '</td>' +
        '<td style="width:18%">' + esc(a.by || '—') + '</td>' +
        '<td style="width:16%">' + (a.at ? fmtDate(a.at) : '—') + '</td>' +
        '<td style="width:26%">' + esc(a.remark || '') + '</td></tr>').join('');
      return '<h2><span class="no">8</span>各方确认记录（逐条记名）</h2>' +
        '<div class="note">共 ' + (st.total || list.length) + ' 项，已确认 ' + (st.ok || 0) + ' 项' +
        ((st.object || 0) ? '，其中 <b>' + st.object + ' 项有异议</b>（原因见下表）' : '，无异议') + '。' +
        '记录在双方共用的确认台账里生成，谁在什么时候点的都可回溯；有异议未处理的项，不作为验收依据。</div>' +
        '<table><thead><tr><th>确认事项</th><th>结论</th><th>署名</th><th>时间</th><th>备注 / 异议原因</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    })() +

    '<h2><span class="no">9</span>验收</h2>' +
    '<div class="note">验收标准：第 3 节脚本清单中的脚本可在客户机器上独立执行成功；第 4 节记录真实；' +
      '客户指定的日常流程可按《操作说明》由客户人员独立完成一次。</div>' +
    '<div class="sign">' +
      '<div class="box"><div class="ln"></div>服务方（签字 / 日期）</div>' +
      '<div class="box"><div class="ln"></div>客户方（签字 / 日期）</div>' +
    '</div>' +
    '<div class="foot">本报告由 FDE Manager 于 ' + fmtTime(Date.now()) + ' 自动生成，编号 ' + no +
      '。报告内容来自本机运行记录，未经人工修改；如需核对原始日志，可在程序「运行日志」中查看。</div>';

  return docWrap('交付与验收报告 · ' + ev.project.name, body);
}

/** 案例卡：一页纸，脱敏后可对外发 */
function renderCaseHtml(ev, opt) {
  const o = opt || {};
  const c = ev.counts, cs = ev.case;
  const title = cs.client ? cs.client + '：' + (o.headline || ev.project.name) : (o.headline || ev.project.name);

  const body =
    '<div class="cover">' +
      '<div class="kicker">Case Study</div>' +
      '<h1>' + esc(title) + '</h1>' +
      '<div class="sub">' + esc(cs.industry || '行业待填') + ' · ' +
        (cs.allowPublish ? '已获客户授权对外使用' : '内部素材，对外前需取得客户授权') + '</div>' +
    '</div>' +
    '<div class="kpis" style="margin-top:14px;">' +
      '<div class="kpi"><div class="v">' + (ev.saved.minutes ? Math.round(ev.saved.minutes / 60) + 'h' : '—') + '</div>' +
        '<div class="l">折算节省人工</div></div>' +
      '<div class="kpi"><div class="v">' + c.scripts + '</div><div class="l">自动化脚本</div></div>' +
      '<div class="kpi"><div class="v">' + c.runs + '</div><div class="l">累计执行</div></div>' +
      '<div class="kpi"><div class="v">' + (c.successRate == null ? '—' : c.successRate + '%') + '</div><div class="l">执行成功率</div></div>' +
    '</div>' +
    '<h2><span class="no">01</span>客户原来的做法</h2>' +
    '<p>' + (cs.pain ? esc(cs.pain) : '<span style="color:#8a93a3;">（待填写：客户原来每天/每周怎么干这件事，卡在哪，一次要多久）</span>') + '</p>' +
    '<h2><span class="no">02</span>我们做的事</h2>' +
    '<p>' + (cs.solution ? esc(cs.solution) : '<span style="color:#8a93a3;">（待填写：拆成了哪几步、哪些交给了程序、哪一步还留给人复核）</span>') + '</p>' +
    (ev.scripts.length ? '<ul>' + ev.scripts.slice(0, 8).map(s => '<li><b>' + esc(s.name) + '</b></li>').join('') + '</ul>' : '') +
    '<h2><span class="no">03</span>结果</h2>' +
    '<table><thead><tr><th style="width:38%">项目</th><th>情况</th></tr></thead><tbody>' +
      '<tr><td>单次处理耗时</td><td>' + (ev.saved.perRun ? '原人工 ' + ev.saved.perRun + ' 分钟 → 程序执行，人工只需复核' : '待填') + '</td></tr>' +
      '<tr><td>释放人工工时</td><td>' + (ev.saved.minutes ? Math.round(ev.saved.minutes / 60 * 10) / 10 + ' 小时（按 ' + c.okRuns + ' 次成功执行折算）' : '待填') + '</td></tr>' +
      '<tr><td>出错情况</td><td>共 ' + c.runs + ' 次执行，失败 ' + c.failRuns + ' 次，失败均有记录可回溯</td></tr>' +
      '<tr><td>换人接手</td><td>' + (c.context ? c.context + ' 项上下文材料已固化，新人按图操作即可' : '流程已固化为 ' + c.canvasNodes + ' 个步骤节点') + '</td></tr>' +
    '</tbody></table>' +
    (cs.quote ? '<h2><span class="no">04</span>客户评价</h2><div class="note ok">「' + esc(cs.quote) + '」' +
      (cs.contact ? '<div style="margin-top:6px;font-size:10.5px;color:#6b7385;">—— ' + esc(cs.contact) + '</div>' : '') + '</div>'
      : '<h2><span class="no">04</span>客户评价</h2><div class="note warn">还没有客户评价。第一次交付后主动要一句' +
        '「最直接的变化是什么」，比任何自述都有用；拿到授权后可放到这里对外。</div>') +
    '<div class="foot">数据来源：该客户工作台的运行记录（' + fmtDate(c.firstRun) + ' 至 ' + fmtDate(c.lastRun) + '）。' +
      '已脱敏处理，不含客户业务数据。生成时间 ' + fmtTime(Date.now()) + '。</div>';

  return docWrap('案例 · ' + title, body);
}

/** 数据处理说明：给客户 IT / 法务看的一页纸 */
function renderSecurityHtml(facts, data) {
  const projectRows = (data.projects || []).map(p =>
    '<tr><td>' + esc(p.name) + '</td><td class="num">' + (p.items || []).length + '</td>' +
    '<td class="num">' + (p.context || []).length + '</td><td>本地隔离</td></tr>').join('') ||
    '<tr><td colspan="4" style="text-align:center;color:#8a93a3;">暂无项目</td></tr>';

  const body =
    '<div class="cover">' +
      '<div class="kicker">Data Processing Statement</div>' +
      '<h1>数据处理说明</h1>' +
      '<div class="sub">用于客户 IT / 信息安全部门评估 · FDE Manager v' + esc(facts.version) + '</div>' +
    '</div>' +

    '<h2><span class="no">1</span>一句话结论</h2>' +
    '<div class="note ok"><b>本工具在客户机器上本地运行，不向任何外部服务器发送数据。</b>' +
    '程序本体不含上传、遥测、统计上报功能；断网状态下全部功能可用（涉及外部网站的操作除外，那部分由客户自己的浏览器完成）。</div>' +

    '<h2><span class="no">2</span>数据存在哪里</h2>' +
    '<table><thead><tr><th style="width:30%">内容</th><th>位置</th><th style="width:22%">是否加密</th></tr></thead><tbody>' +
      '<tr><td>项目 / 脚本 / 上下文配置</td><td class="mono path">' + esc(facts.dataFile) + '</td><td>明文 JSON（可按需放入加密盘）</td></tr>' +
      '<tr><td>数据根目录</td><td class="mono path">' + esc(facts.dataRoot) + '</td><td>—</td></tr>' +
      '<tr><td>程序文件</td><td class="mono path">' + esc(facts.appDir) + '</td><td>—</td></tr>' +
      '<tr><td>运行日志</td><td class="mono path">同上目录 startup.log</td><td>仅记录本机操作</td></tr>' +
      '<tr><td>对外通信</td><td><b>无</b>（0 个外发请求）</td><td>—</td></tr>' +
    '</tbody></table>' +
    '<div class="note">建议：把数据根目录指到客户已有的加密盘或受控目录，即可纳入客户现有备份与审计体系。</div>' +

    '<h2><span class="no">3</span>数据流向</h2>' +
    '<table><thead><tr><th style="width:26%">环节</th><th style="width:20%">是否离开本机</th><th>说明</th></tr></thead><tbody>' +
      '<tr><td>读取文件 / 目录</td><td>否</td><td>程序直接读客户指定路径，不复制到别处</td></tr>' +
      '<tr><td>执行脚本</td><td>否</td><td>脚本在本机进程内执行，输出只留在本机</td></tr>' +
      '<tr><td>调用 AI 模型</td><td>否（默认）</td><td>只生成提示词并复制到剪贴板，由客户用自己账号在自选工具中提交</td></tr>' +
      '<tr><td>打开网页 / 后台</td><td>是（客户浏览器）</td><td>由客户自己的浏览器访问客户自己的系统，程序不代理、不抓包</td></tr>' +
      '<tr><td>导出报告 / 快照</td><td>否</td><td>只写到客户选择的本地路径</td></tr>' +
    '</tbody></table>' +

    '<h2><span class="no">4</span>权限说明</h2>' +
    '<ul>' +
      '<li>常规功能（脚本、上下文、报告导出）不需要管理员权限。</li>' +
      '<li>窗口纳管、按项目切换桌面、壁纸切换需要较普通用户更高权限；只在客户明确同意时启用，可随时关闭。</li>' +
      '<li>本次记录：' + (facts.isAdmin ? '<b>当前以管理员权限运行</b>' : '当前非管理员运行') + '。</li>' +
    '</ul>' +

    '<h2><span class="no">5</span>本机纳管范围</h2>' +
    '<table><thead><tr><th>项目</th><th class="num">脚本</th><th class="num">上下文材料</th><th>隔离方式</th></tr></thead>' +
    '<tbody>' + projectRows + '</tbody></table>' +

    '<h2><span class="no">6</span>数据删除与退出</h2>' +
    '<ul>' +
      '<li><b>单个项目：</b>在面板中删除项目即清除其配置与上下文引用（不删除客户原始文件）。</li>' +
      '<li><b>全部数据：</b>删除数据根目录下的 fde-data.json 即可，程序不留残留。</li>' +
      '<li><b>服务终止：</b>可导出环境快照交给客户，客户在同一程序内继续运行，不依赖服务方。</li>' +
    '</ul>' +
    '<div class="foot">本说明由 FDE Manager 根据当前机器实际配置生成（' + fmtTime(Date.now()) + '）。' +
      '如与客户安全要求冲突，以双方签署的协议为准；需要补充条款可在此文档基础上修改。</div>';

  return docWrap('数据处理说明', body);
}

// ---------- 商务模板 ----------
const BIZ_TEMPLATES = [
  {
    id: 'contract',
    name: '服务合同（框架）',
    desc: '一份能签的骨架：范围、交付、验收、责任上限、数据条款、退出机制 —— 双方各自的权利义务都写在同一页',
    body: `# 自动化流程服务合同（框架）

甲方（客户）：____________________
乙方（服务方）：____________________
签订日期：______年____月____日

## 第一条 服务内容
1.1 乙方为甲方提供"业务流程自动化"服务，具体范围以每一期《工作说明书（SOW）》为准。
1.2 服务方式：在甲方提供的设备或甲方授权使用的设备上，部署乙方自有的自动化管理工具，配置并交付可重复执行的自动化流程。
1.3 本合同为框架合同，可签署多期 SOW；单期 SOW 与本合同冲突时，以 SOW 为准。

## 第二条 交付物
2.1 每一期交付以下内容，缺一不可：
  (1) 可执行的自动化脚本及运行说明；
  (2) 《交付与验收报告》（含执行记录、脚本清单、上下文清单）；
  (3) 项目环境快照（甲方可自行导入、自行运行）；
  (4) 一页《操作说明》，甲方人员按此可独立完成一次操作。
2.2 交付物以电子形式移交，乙方不保留甲方业务数据的副本。

## 第三条 验收
3.1 交付后 5 个工作日内，甲方按 SOW 约定的验收标准确认；逾期未提出书面异议视为验收通过。
3.2 验收不通过时，乙方在 5 个工作日内整改并重新提交，整改次数不超过 2 次。
3.3 验收以"功能可用"为标准，不以"业务结果达标"为标准；业务效果指标见《服务等级附件》。

## 第四条 费用与支付
4.1 计费方式：□ 固定期费  □ 按工时  □ 基础费 + 效果分成（比例 ____%）
4.2 支付节点：合同签署 ____%，验收通过 ____%，运行满 ____ 个月 ____%。
4.3 效果分成以《交付与验收报告》中的折算节省工时为计算基数，双方每月核对一次。

## 第五条 责任限制（关键条款，别删）
5.1 乙方对因交付物缺陷导致的直接损失承担赔偿责任，累计赔偿上限为甲方就该期 SOW 已支付费用的 ____%（建议 100%）。
5.2 乙方不承担间接损失、利润损失、商誉损失、数据丢失导致的损失。
5.3 因甲方系统变更、第三方平台规则调整、账号被封等非乙方原因导致流程失效的，乙方负责修复但不承担由此产生的业务损失。
5.4 甲方应自行保留业务数据的原始记录与备份；乙方交付物不替代甲方的数据备份义务。

## 第六条 数据与保密
6.1 乙方仅在甲方设备上处理数据，不将甲方数据传输至乙方或第三方服务器。
6.2 乙方人员接触甲方数据限于配置与排障所必需，且遵守甲方现场管理要求。
6.3 保密义务自签署之日起生效，终止后继续有效 ____ 年。
6.4 详见附件《数据处理与保密协议》。

## 第七条 知识产权
7.1 通用工具、框架及乙方既有组件的知识产权归乙方。
7.2 为甲方定制的脚本与配置，所有权归甲方；乙方保留在脱敏后用于方法论沉淀与案例展示的权利，甲方可书面禁止。
7.3 甲方不得将交付物转售或用于向第三方提供同类服务。

## 第八条 退出与交接（客户最在意的一条）
8.1 任一方可提前 30 日书面通知终止。
8.2 终止时乙方须完成：交付全部脚本与配置、交付最新环境快照、配合甲方或继任服务方完成 1 次交接说明（线上，不超过 4 小时）。
8.3 乙方不得以任何技术手段（授权锁、远程停用、依赖乙方服务器）阻碍甲方继续使用已交付成果。

## 第九条 其他
9.1 争议解决：______（建议约定甲方所在地法院）。
9.2 本合同一式两份，双方各持一份，具同等效力。

甲方（盖章）：____________  乙方（盖章）：____________
授权代表：______________  授权代表：______________`
  },
  {
    id: 'sow',
    name: '工作说明书（SOW）',
    desc: '单期项目的范围：做什么、不做什么、多久、多少钱、怎么算完成 —— 变更也有地方落',
    body: `# 工作说明书（SOW）第 ____ 期

关联合同：____________    有效期：____年__月__日 至 ____年__月__日

## 一、本期目标（一句话）
把 ________（流程名）从「人工每次约 ____ 分钟」变成「程序执行 + 人工复核约 ____ 分钟」。

## 二、范围（做到什么程度）
| # | 流程步骤 | 交付形式 | 是否本期完成 |
|---|---------|---------|------------|
| 1 | | 脚本 | |
| 2 | | 脚本 | |
| 3 | | 脚本 | |

## 三、明确不包含（防止范围膨胀，必须写）
- 不包含甲方账号的申请、开通、实名、资质办理；
- 不包含第三方平台规则变化后的策略调整（按变更单另行计费）；
- 不包含甲方内部审批流程改造；
- 不包含 7×24 值守（值守另计：见附件）。

## 四、验收标准（可逐条打勾）
- [ ] 脚本在甲方机器上连续执行 3 次成功；
- [ ] 甲方指定人员按《操作说明》独立完成 1 次；
- [ ] 交付物 4 项齐全（脚本 / 验收报告 / 环境快照 / 操作说明）；
- [ ] 失败场景有记录且可回溯。

## 五、时间与里程碑
| 阶段 | 内容 | 交付时间 |
|------|------|---------|
| 调研 | 现场或远程梳理现状、确认口径 | 第 ___ 天 |
| 搭建 | 配置流程、跑通首次 | 第 ___ 天 |
| 试运行 | 并行运行 ___ 天，人工复核 | 第 ___ 天 |
| 验收 | 按第四节逐条确认 | 第 ___ 天 |

## 六、费用
本期费用：¥________（含税 / 不含税）
计费口径：□ 固定  □ 按人天（____ 元/人天 × ____ 人天）
额外变更：按 ____ 元/人天计，需双方书面确认后执行。

## 七、口径确认（效果数据的基础，别省这一步）
- 单次人工耗时：____ 分钟（由甲方业务负责人在此确认）
- 人工小时成本：¥____/小时（可选，用于折算金额）
- 频次：每天 ____ 次 / 每周 ____ 次

双方确认签字：甲方 ________  乙方 ________  日期 ________`
  },
  {
    id: 'dpa',
    name: '数据处理与保密协议（DPA）',
    desc: '把"数据不出本机"写成条款。IT 与法务审这一份，服务方的边界也由这一份界定',
    body: `# 数据处理与保密协议

甲方（数据控制方）：____________
乙方（数据处理方）：____________

## 一、处理范围
1.1 处理的数据类别：甲方业务系统数据、订单/客户信息、内部文档（以实际接触为准）。
1.2 处理目的：仅用于配置与运行甲方授权的自动化流程。
1.3 处理方式：仅在甲方指定的设备与目录内读取、执行、输出；不建立独立副本。

## 二、存储位置与隔离
2.1 乙方交付物运行于甲方设备，数据存储于甲方指定的本地目录：________________。
2.2 乙方不将数据传输至境外，不使用公有云存储、不接入任何第三方数据分析服务。
2.3 乙方自有工具不含遥测、统计上报、远程控制功能；如后续版本新增网络功能，须提前书面告知甲方并经甲方同意后方可启用。

## 三、AI / 自动化决策说明（现在客户一定会问）
3.1 乙方工具默认不调用外部大模型接口。
3.2 需使用大模型能力时，由甲方人员使用甲方自有账号在甲方选定工具中提交，数据流向由甲方自行控制。
3.3 涉及对外承诺、定价、合规判断等决策，须由甲方人员复核确认，工具不自动执行。

## 四、人员与访问
4.1 乙方接触数据的人员名单：____________；变更须提前通知。
4.2 远程协助须经甲方同意，使用甲方指定的远程工具，过程可录屏。
4.3 乙方人员离开项目后，其对甲方系统的访问权限由甲方立即回收。

## 五、安全措施
5.1 甲方设备开启磁盘加密与登录口令，乙方不降低甲方既有安全配置。
5.2 乙方不在甲方设备上安装与交付无关的软件。
5.3 发生数据泄露或疑似泄露，乙方在 ____ 小时内书面通知甲方并配合调查。

## 六、留存与删除
6.1 乙方不留存甲方业务数据副本；排障所需的截图/日志，在问题关闭后 ____ 日内删除。
6.2 合作终止后 ____ 日内，乙方删除全部甲方数据并出具书面确认。

## 七、违约
7.1 违反本协议造成甲方损失的，乙方承担赔偿责任，赔偿上限适用主合同第五条。

甲方（盖章）：________  乙方（盖章）：________
日期：________          日期：________`
  },
  {
    id: 'sla',
    name: '服务等级附件（效果保证怎么说）',
    desc: '只承诺可控的过程指标（可用率、响应时长、修复时限），不承诺经营结果 —— 这是双方都不吃亏的写法',
    body: `# 服务等级附件（SLA）

> 核心原则：**承诺你能控制的过程指标，不承诺你控制不了的业务结果。**
> "保证利润提升 30%" 这种话不要写，写"保证流程可用性、响应时间、修复时限"。

## 一、承诺指标（乙方可控）

| 指标 | 承诺值 | 计算方式 | 未达成的补偿 |
|------|--------|---------|------------|
| 流程可用率 | ≥ 99%（按月） | 成功执行次数 / 应执行次数 | 每低 1% 减免当月费用 5% |
| 故障响应 | 4 小时内响应 | 甲方报障至乙方首次回复 | 超 24 小时，减免当月 10% |
| 故障修复 | 24 小时内恢复（工作日） | 报障至流程重新可用 | 每超 1 个工作日减免 5% |
| 变更交付 | 3 个工作日内 | 平台规则变更确认后 | 每超 1 日减免 3% |

## 二、明确不承诺（必须写，否则以后扯皮）
- 不承诺甲方业务收入、利润、转化率、排名等经营结果；
- 不承诺第三方平台的账号状态、规则稳定性、接口可用性；
- 不承诺因甲方系统升级、人员误操作、网络中断导致的中断时间；
- 不承诺数据绝对无差错，承诺"差错可被发现并可回溯"。

## 三、效果数据的计算口径
3.1 节省工时 = 成功执行次数 × 单次人工耗时（由甲方在 SOW 第七条确认）。
3.2 未扣除人工复核时间；如甲方要求净节省，按复核耗时据实扣减。
3.3 数据来源为《交付与验收报告》第 4 节执行记录，双方均可核对原始日志。

## 四、免责
4.1 不可抗力、平台封禁、甲方未按操作说明执行导致的损失，乙方不承担责任。
4.2 甲方应在流程上线前完成自身数据备份。

甲方确认：________  乙方确认：________  日期：________`
  },
  {
    id: 'poc',
    name: '试点协议（降低第一次合作门槛）',
    desc: '2 周、一条流程、按已完成结算、不满意可终止 —— 第一次合作最省事的起步方式',
    body: `# 试点（POC）协议

甲方：____________  乙方：____________

## 一、为什么做试点
双方在不承担长期风险的前提下，用 2 周验证「这条流程能不能自动化、效果是否可量化」。

## 二、试点范围（只选 1 条流程，不要贪多）
流程名称：____________________
现状：人工每次 ____ 分钟，每天 ____ 次
试点目标：连续 10 个工作日稳定运行，人工只需复核

## 三、费用
3.1 试点费：¥________（含搭建、试运行、验收报告）
3.2 效果分成：按《交付与验收报告》折算节省工时，¥____/小时 × ____% 归乙方（可选，二选一）
3.3 试点期内甲方可随时终止，按已完成人天结算，不收取违约金。

## 四、乙方在试点期提供
- 流程搭建与调试；
- 试运行期间的问题修复（工作日 24 小时内）；
- 试点结束出具《交付与验收报告》与《案例卡》（脱敏）；
- 试点通过后，交付物归甲方，可继续使用。

## 五、试点不通过怎么办
5.1 若流程无法在试点期内稳定运行，乙方退还试点费的 ____%，并交付已完成的配置供甲方参考。
5.2 双方均不因此承担其他责任。

## 六、试点结束的选择
- [ ] 转正式合作（签署框架合同 + SOW，试点费可抵扣首期费用 ____%）
- [ ] 终止合作（甲方保留已交付成果）

甲方签字：________  乙方签字：________  日期：________`
  },
  {
    id: 'nda',
    name: '保密协议（NDA 简版）',
    desc: '第一次接触就签：双方各自的信息都不外流，谈不成也不留尾巴',
    body: `# 保密协议（NDA）

甲方：____________  乙方：____________

1. **保密信息**：一方以书面、口头、电子形式披露的、标注或应合理认定为保密的技术、业务、财务、客户信息，包括流程细节、账号信息、数据结构、报价。
2. **义务**：接收方仅为本合作目的使用保密信息；不向第三方披露；仅向确有需要的人员披露并使其承担同等义务。
3. **例外**：已公开的、接收方独立开发的、依法必须披露的（须提前通知对方）。
4. **期限**：自签署起 ____ 年；合作终止后仍有效。
5. **返还与删除**：合作结束或对方要求时，____ 日内返还或删除全部保密信息并书面确认。
6. **违约**：违约方赔偿守约方因此产生的直接损失。
7. **其他**：本协议不构成任何合作承诺。

甲方（盖章）：________  乙方（盖章）：________  日期：________`
  },
  {
    id: 'handover',
    name: '交接清单（客户最怕"你走了我就废了"）',
    desc: '一页纸交付清单：东西在哪、怎么跑、找谁 —— 换人时 30 秒讲完',
    body: `# 交接清单

项目：____________        交接日期：____________

## 一、交付物核对
- [ ] 自动化脚本（____ 个），路径：____________________
- [ ] 《交付与验收报告》（编号：__________）
- [ ] 环境快照文件（.fdeenv），位置：____________________
- [ ] 《操作说明》（一页，含截图）
- [ ] 账号与凭据清单（不含明文密码，注明由谁保管）：____________________
- [ ] 故障处理联系人：____________ 电话：____________

## 二、现场验收动作（当着客户面做一遍）
- [ ] 客户人员独立执行一次流程，成功；
- [ ] 演示出错时如何看日志、如何回滚；
- [ ] 演示如何自行导入快照、把工作台搬到另一台机器；
- [ ] 确认客户已知晓：不需要乙方在场也能继续运行。

## 三、遗留事项
| # | 事项 | 负责方 | 计划完成 |
|---|------|-------|---------|
| 1 | | | |

## 四、确认
甲方确认人：____________  乙方交付人：____________
日期：____________`
  }
];

module.exports = {
  collectEvidence,
  securityFacts,
  renderReportHtml,
  renderCaseHtml,
  renderSecurityHtml,
  BIZ_TEMPLATES,
  fmtTime,
  fmtDate,
  // 供 adopt.js 复用同一套打印样式，保证给客户的文档长一个样
  PRINT_CSS,
  docWrap,
  esc,
  fmtDur
};
