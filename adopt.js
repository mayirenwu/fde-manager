/**
 * 推进引擎（Adoption）—— 一个项目推不动，通常不是技术问题，是人的分工没摊开。
 *
 * 这一层不站在任何一方说话。它只做三件事：
 *   1. 把每个角色关心的事写成公开的话（客户方自己能看，服务方也能看）；
 *   2. 把"关心"对应到已经写进文件的做法上，而不是靠临场表态；
 *   3. 把账算准：能用真实运行记录就不用估算，算不合算就直说，别硬推。
 *
 * 数字口径：估算必须标来源；复核耗时 >= 人工耗时时，直接判"这条不适合自动化"。
 */
const { PRINT_CSS, docWrap, esc, fmtTime, fmtDate } = require('./trust');

const pad2 = (n) => String(n).padStart(2, '0');
const hour1 = (min) => Math.round(min / 6) / 10;   // 分钟 → 小时，保留 1 位
const yuan = (n) => '¥' + Math.round(n).toLocaleString('zh-CN');

/** 角色定义：各方分别关心什么、能拿到的做法是什么。文案是对外可读的，不用藏着。 */
const ROLE_DEFS = {
  boss: {
    name: '决策人', icon: '👑', power: 3,
    worry: '这笔钱花得值不值、出了问题谁担、能不能随时停',
    action: '看决策版一页纸：每月支出、做完省多少、不做的代价、三个选项',
    doc: 'boss'
  },
  operator: {
    name: '操作员', icon: '🧑‍💻', power: 2,
    worry: '会不会动到我的岗位，规则之外的事还归不归我判断',
    action: '把分工写清：不涉及编制调整、判断权与否决权在他、署名在文件上',
    doc: 'operator'
  },
  reviewer: {
    name: '复核 / 审核', icon: '🔍', power: 2,
    worry: '签了字要不要为结果担保，出了事算谁的责任',
    action: '给他核对清单：签的是"核对过这几项"，保留意见照写，一样算通过',
    doc: 'reviewer'
  },
  it: {
    name: 'IT / 信息安全', icon: '🛡', power: 2,
    worry: '装什么、开不开端口、数据流向哪里、会不会影响自己的考核',
    action: '给数据处理说明：不装服务端、不开端口、数据不出本机，可当场断网验证',
    doc: 'security'
  },
  finance: {
    name: '财务 / 采购', icon: '💰', power: 2,
    worry: '预算科目怎么走、按什么计价、怎么对账',
    action: '给成本折算与结算方式：按工时计价、按月结算、按月核对',
    doc: 'boss'
  },
  mid: {
    name: '中层管理者', icon: '📊', power: 3,
    worry: '部门指标会不会难看、人均产出怎么算、人手会不会被动',
    action: '口径先由他定：报表用"释放工时"，不动编制口径，数据怎么呈现他先说',
    doc: 'boss'
  }
};

const ATTITUDES = {
  support: { name: '支持', color: '#22c55e' },
  neutral: { name: '中立', color: '#f59e0b' },
  resist: { name: '抵触', color: '#ef4444' },
  unknown: { name: '未接触', color: '#6b7789' }
};

/**
 * 各方关心的事 → 容易失效的说法 → 更有效的做法 → 依据。
 * 这些内容客户方也能看：看了不会不舒服，反而知道自己的顾虑被写下来了。
 */
const OBSTACLES = [
  {
    role: 'operator', say: '「这套上了，是不是就要减人了？」',
    dont: '「不会的，放心吧。」—— 没有依据的保证，他听过太多次。',
    do: '「编制的事由你们公司决定，服务方不参与，也不出减人建议，这句会写进验收文件。这套东西里，规则之外的判断只有你能做；哪一步不放心，可以要求保留人工，不需要理由。」',
    basis: '把口头承诺换成写在文件里的结构：判断权、署名权、否决权都在他手上。'
  },
  {
    role: 'operator', say: '「我们一直都是这么干的。」',
    dont: '先讲效率、讲先进 —— 那等于说他的经验没价值。',
    do: '「先不动你现在的做法。程序在旁边并行跑一份，你对照两周，看它算得对不对、哪一步不如你。差异按你说的改。」',
    basis: '并行跑不改变现状，风险为零，才谈得下去。'
  },
  {
    role: 'operator', say: '「你先去问我们主管吧。」',
    dont: '真的只去找主管 —— 主管更在意部门指标，未必愿意先动。',
    do: '「行，我跟主管谈的时候需要你帮一句：实际每天花多久、哪一步最烦。这两个数只有你能给，别人说的我改不动。」',
    basis: '让他成为信息的提供者，而不是被改造的对象。'
  },
  {
    role: 'reviewer', say: '「脚本我看不懂，没法签。」',
    dont: '解释代码、发技术文档 —— 越讲越不敢签。',
    do: '「不用看代码。你只要核对 5 项：数据范围、能做什么、不能做什么、出错怎么办、谁负责。每项都写成能当场验证的，核对完再签。」',
    basis: '复核的本质是确认边界，不是审代码。'
  },
  {
    role: 'reviewer', say: '「出了问题我担不起。」',
    dont: '「不会出问题。」—— 这句等于让他兜所有风险。',
    do: '「你签的是『我核对过这 5 项』，不是『我为结果担保』。赔偿上限在合同里写明，以该期费用为限。你有保留，写在保留意见栏，一样算通过。」',
    basis: '给出「有条件通过」的出口，他就不需要用不签来表达担心。'
  },
  {
    role: 'boss', say: '「先放放，等这阵忙完。」',
    dont: '催进度、讲趋势 —— 他这时候听不进去。',
    do: '「可以。留一页纸给你：这条流程现在每月花 X 小时，放三个月就是 Y 小时。你什么时候想动，两天能上线，不用重新调研。」',
    basis: '把「要不要做」变成「什么时候做」，并把不做的代价写在纸上。'
  },
  {
    role: 'boss', say: '「这东西靠谱吗？万一不行呢？」',
    dont: '讲架构、举别人的案例 —— 别人的案例说服力有限。',
    do: '「先跑两周，只做这一条流程，验收口径现在就写进确认台账。不满意的部分随时停，钱按已完成结算。两周后一份验收报告，每条执行记录都能核对。」',
    basis: '决策人要的不是保证，是试错的代价可控。'
  },
  {
    role: 'mid', say: '「这会影响我们部门的考核指标。」',
    dont: '「对你们有好处。」—— 空话，他会更防。',
    do: '「考核口径按你的来。报表不写『减少人数』，只写『释放工时』；人没少，人均产出数字会好看。具体怎么呈现，你先定。」',
    basis: '中层反对的不是效率，是「显得我部门多余」。口径先由他定。'
  },
  {
    role: 'it', say: '「要装软件、开端口？流程要走三个月。」',
    dont: '「这个不用管 IT。」—— 绕过一次，以后次次被卡。',
    do: '「不装服务端、不开端口、不连你们内网，就是客户机上的一个程序，数据全在本机。有一页数据处理说明，你拿去过会；需要的话可以当场断网演示。」',
    basis: 'IT 的诉求是可审，不是禁止。给他能过会的材料，他自己会推。'
  }
];

/**
 * 双方都可能卡住的地方 —— 不是谁对谁错，是这类合作里反复出现的四件事。
 * 放在这里，是为了在发生之前就有一个双方都认的处理方式。
 */
const MUTUAL = [
  {
    say: '「先免费用一个月，做出来再说。」',
    dont: '免费试没有验收口径，做完也说不清好不好，双方都容易觉得吃亏。',
    do: '两周、一条流程、验收口径开工前写进确认台账、按已完成结算。范围小到可以真的做完。',
    basis: '把「要不要相信」换成「试一次的成本是多少」。'
  },
  {
    say: '「这个顺便也加一下吧。」',
    dont: '每次都顺手加，范围会失控，最后谁都说不清这一期做了什么。',
    do: '记进「下一步清单」，按批处理；超出本期范围的另开一单，写清加多少时间、多少钱。',
    basis: '范围变更本身不是问题，没有记录才是问题。'
  },
  {
    say: '「验收标准再改一下。」',
    dont: '反复改标准等于没有标准，做完也验收不了。',
    do: '标准在开工前写进确认台账，要改就改台账、重新确认一次，并记下改动原因。',
    basis: '可追溯的改动不会伤感情，口头改动才会。'
  },
  {
    say: '「上次那个谁做得挺好的，现在换人了。」',
    dont: '换人后一切从头解释，项目通常就停在这里。',
    do: '用决策记录 + 交接清单 + 环境快照：谁批的、批的什么范围、东西在哪、怎么跑起来，30 秒讲完。',
    basis: '项目资产留在客户机器上，人才敢接手。'
  }
];

/** 计算投入产出：能用真实记录的不用估算，算不平就直说 */
function computeAdoption(ev, adopt) {
  const a = adopt || {};
  const perRun = Number(a.perRunMinutes || ev.case.manualMinutes || 0);
  const review = Number(a.reviewMinutes || 0);
  const rate = Number(a.hourlyRate || ev.case.hourlyRate || 0);
  const fee = Number(a.monthlyFee || 0);

  const monthAgo = Date.now() - 30 * 86400000;
  const realRuns = (ev.runs || []).filter(r => r.at >= monthAgo).length;
  const freq = Number(a.monthlyRuns || 0) || realRuns || 0;
  const freqSource = Number(a.monthlyRuns || 0) ? '手工填写' : (realRuns ? '近 30 天真实执行记录' : '未填写');

  const beforeMin = freq * perRun;
  const afterMin = freq * review;
  const savedMin = beforeMin - afterMin;
  const beforeYuan = beforeMin / 60 * rate;
  const afterYuan = afterMin / 60 * rate;
  const savedYuan = (savedMin / 60) * rate - fee;

  let verdict = 'worth', why = '';
  if (!perRun || !freq) {
    verdict = 'unknown';
    why = '缺少「每次人工耗时」或「每月频次」，算不出投入产出——先在这一页把口径填上，双方各留一份。';
  } else if (review >= perRun) {
    verdict = 'not-worth';
    why = '复核耗时 ≥ 人工耗时：这条流程不适合自动化，人做反而更快。先换个环节谈，别硬推这一条。';
  } else if (savedYuan <= 0) {
    verdict = 'marginal';
    why = '释放的工时折算后不够覆盖服务费：提高频次、扩大范围或调整费用，三者谈一个，谈不拢就先不做。';
  } else {
    why = '投入产出成立，可以往下推；口径写进确认台账，后面按这个算。';
  }

  return {
    perRun, review, rate, fee, freq, freqSource,
    beforeMin, afterMin, savedMin,
    beforeYuan, afterYuan, savedYuan,
    savedPerYear: savedMin * 12,
    verdict, why
  };
}

// ---------- 文档 ----------
const DOC_CSS = PRINT_CSS + `
  .hero { font-size: 17px; font-weight: 700; line-height: 1.65; margin: 10px 0 4px; padding: 12px 14px;
          border: 1.5px solid #14181f; border-radius: 4px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 10px 0; }
  .box { border: 1px solid #cfd5df; border-radius: 4px; padding: 10px 12px; }
  .box .h { font-size: 10.5px; color: #6b7385; letter-spacing: 1px; margin-bottom: 5px; }
  .box .big { font-size: 17px; font-weight: 700; }
  .box .sm { font-size: 10.5px; color: #6b7385; margin-top: 3px; line-height: 1.6; }
  .box.neg .big { color: #b23b3b; }
  .box.pos .big { color: #22733f; }
  .chkline { display: flex; gap: 8px; align-items: flex-start; margin: 7px 0; font-size: 11.5px; }
  .chkline .cb { flex: 0 0 13px; height: 13px; border: 1.2px solid #14181f; border-radius: 2px; margin-top: 2px; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 20px;
           border: 1px solid #cfd5df; color: #4a5262; margin-left: 6px; vertical-align: middle; }
  .stamp { border: 2px solid #22733f; color: #22733f; border-radius: 4px; padding: 6px 12px;
           font-size: 12px; font-weight: 700; display: inline-block; }
`;

function wrapDoc(title, body) {
  return docWrap(title, '<style>' + DOC_CSS + '</style>' + body);
}

function signBlock(left, right) {
  return '<div class="sign"><div class="box"><div class="ln"></div>' + left + '</div>' +
    '<div class="box"><div class="ln"></div>' + right + '</div></div>';
}

/** ① 给老板：一页决策简报（能被转发的那种） */
function renderBossBrief(ev, adopt, calc) {
  const a = adopt || {};
  const flow = a.flowName || ev.project.name;
  const client = ev.case.client || '（客户名称）';
  const oneSentence = flow + ' 这块，现在每月花 ' + hour1(calc.beforeMin) + ' 小时人工，' +
    '改成程序执行、人只看异常，每月释放约 ' + hour1(calc.savedMin) + ' 小时' +
    (calc.rate ? '（折算 ' + yuan(calc.savedYuan) + '）' : '') +
    '；数据不出贵司电脑、先试两周，不满意随时停。';

  const warn = calc.verdict === 'not-worth'
    ? '<div class="note warn"><b>先说结论：这条流程不建议做自动化。</b>' + esc(calc.why) +
      '建议先换一条流程谈，别在这条上耗。</div>'
    : (calc.verdict === 'marginal'
      ? '<div class="note warn"><b>账算得比较紧：</b>' + esc(calc.why) + '</div>'
      : (calc.verdict === 'unknown' ? '<div class="note warn">' + esc(calc.why) + '</div>' : ''));

  const body =
    '<div class="cover">' +
      '<div class="kicker">One-page Decision Brief</div>' +
      '<h1>一页决策简报 · ' + esc(flow) + '</h1>' +
      '<div class="sub">' + esc(client) + ' · ' + fmtDate(Date.now()) + ' · 建议阅读时间 90 秒</div>' +
    '</div>' +

    '<div class="hero">' + esc(oneSentence) + '</div>' +
    '<div style="font-size:10.5px;color:#6b7385;">↑ 这段可以直接转给合伙人 / 上级，不用改。</div>' +
    warn +

    '<div class="grid3">' +
      '<div class="box neg"><div class="h">现在（每月）</div>' +
        '<div class="big">' + hour1(calc.beforeMin) + ' 小时</div>' +
        '<div class="sm">' + calc.freq + ' 次 × ' + calc.perRun + ' 分钟人工' +
        (calc.rate ? '<br>≈ ' + yuan(calc.beforeYuan) : '') + '</div></div>' +
      '<div class="box"><div class="h">之后（每月）</div>' +
        '<div class="big">' + hour1(calc.afterMin) + ' 小时</div>' +
        '<div class="sm">程序执行 + 人复核异常<br>每次约 ' + (calc.review || 0) + ' 分钟' +
        (calc.fee ? '<br>服务费 ' + yuan(calc.fee) : '') + '</div></div>' +
      '<div class="box pos"><div class="h">净变化（每月）</div>' +
        '<div class="big">-' + hour1(calc.savedMin) + ' 小时</div>' +
        '<div class="sm">≈ ' + (Math.round(calc.savedMin / 480 * 10) / 10) + ' 人天' +
        (calc.rate ? '<br>折算 ' + yuan(calc.savedYuan) : '') + '</div></div>' +
    '</div>' +

    '<h2><span class="no">1</span>这个数字怎么来的</h2>' +
    '<table><thead><tr><th style="width:34%">项目</th><th class="num">数值</th><th>来源</th></tr></thead><tbody>' +
      '<tr><td>每月执行频次</td><td class="num">' + calc.freq + ' 次</td><td>' + esc(calc.freqSource) + '</td></tr>' +
      '<tr><td>每次人工耗时</td><td class="num">' + calc.perRun + ' 分钟</td><td>双方在 SOW 中确认</td></tr>' +
      '<tr><td>之后每次复核</td><td class="num">' + (calc.review || 0) + ' 分钟</td><td>按异常清单长度估算，可实测修正</td></tr>' +
      '<tr><td>人力小时成本</td><td class="num">' + (calc.rate ? yuan(calc.rate) : '未提供') + '</td><td>客户提供；不提供则只算小时不算钱</td></tr>' +
    '</tbody></table>' +
    '<div class="note">口径：只算"被替代的重复操作时间"，<b>没有</b>把复核时间藏起来不计；也没有把"少出错"折算成钱。' +
      '宁可算少，不算多——算多了，第一次核对就对不上。</div>' +

    '<h2><span class="no">2</span>不做的成本</h2>' +
    '<p>维持现状，每月仍然花 <b>' + hour1(calc.beforeMin) + ' 小时</b>做重复操作，一年 <b>' +
      hour1(calc.savedPerYear) + ' 小时</b>。这类工作不会因为忙就消失，只会挤占真正需要判断的时间；' +
      '且每次靠人回忆排查，出错时定位成本随次数上升。</p>' +

    '<h2><span class="no">3</span>风险与兜底</h2>' +
    '<ul>' +
      '<li><b>数据：</b>在本机运行，不上传任何服务器；断网可用。可提供《数据处理说明》给贵司 IT 过会。</li>' +
      '<li><b>出错：</b>每次执行留有记录（时间、结果、退出码），原始数据不被覆盖，人工可随时接管。</li>' +
      '<li><b>依赖：</b>交付环境快照，人员变动、换电脑都能继续运行，不依赖服务方在场。</li>' +
      '<li><b>退出：</b>试点期内可随时终止，费用按已完成部分结算，不设违约金。</li>' +
    '</ul>' +

    '<h2><span class="no">4</span>需要决策人做的只有一件事</h2>' +
    '<p>指定 1 名对接人（通常是现在做这件事的同事），并允许他前两周每天投入约 30 分钟，把"凭什么这么判断"讲清楚。' +
      '其余环节不需要决策人介入。</p>' +

    '<h2><span class="no">5</span>三个选项</h2>' +
    '<table><thead><tr><th style="width:26%">选项</th><th>内容</th><th style="width:22%">代价</th></tr></thead><tbody>' +
      '<tr><td><b>A 先试两周</b>（推荐）</td><td>只做这一条流程，并行运行，出验收报告后再决定是否扩大</td><td>两周时间 + 试点费</td></tr>' +
      '<tr><td>B 直接上线</td><td>范围扩大到 ___ 条流程，需要 ___ 天</td><td>投入更大，风险集中</td></tr>' +
      '<tr><td>C 暂不做</td><td>维持现状</td><td>每月继续 ' + hour1(calc.beforeMin) + ' 小时；明年再做，等于晚省 ' +
        hour1(calc.savedPerYear) + ' 小时</td></tr>' +
    '</tbody></table>' +

    signBlock('决策人（签字 / 日期）', '服务方（签字 / 日期）') +
    '<div class="foot">本简报由 FDE Manager 生成，数字来自该工作台运行记录与双方确认的口径。' +
      '如需核对原始记录，可要求服务方当场打开运行日志。</div>';

  return wrapDoc('决策简报 · ' + flow, body);
}

/** ② 给操作员：你的工作会变成什么样（消除"被裁"恐惧，靠结构而不是安慰） */
function renderOperatorBrief(ev, adopt, calc) {
  const a = adopt || {};
  const flow = a.flowName || ev.project.name;
  const scripts = (ev.scripts || []).slice(0, 6);

  const body =
    '<div class="cover">' +
      '<div class="kicker">For the person who does the work</div>' +
      '<h1>这件事之后，你的工作会变成什么样</h1>' +
      '<div class="sub">' + esc(flow) + ' · 给 ' + esc(a.operatorName || '实际操作的同事') +
        ' · ' + fmtDate(Date.now()) + '</div>' +
    '</div>' +

    '<div class="note ok" style="font-size:12px;line-height:1.9;">' +
      '<b>先把最要紧的三句说清楚：</b><br>' +
      '1. 这个项目<b>不减少岗位</b>，也不改变你的职级和薪资。<br>' +
      '2. 人员编制由公司决定，<b>服务方不参与，也不会提供任何裁员建议</b>。<br>' +
      '3. 程序只会按规则跑，<b>规则之外的情况只有你能判断</b>——这套东西离了你就跑不起来。' +
    '</div>' +

    '<h2><span class="no">1</span>原来你做的，现在谁做</h2>' +
    '<table><thead><tr><th style="width:32%">这一步</th><th>原来</th><th>现在</th><th style="width:24%">你还要做什么</th></tr></thead><tbody>' +
      (a.steps && a.steps.length
        ? a.steps.map(s => '<tr><td>' + esc(s.step) + '</td><td>' + esc(s.before) + '</td><td>' + esc(s.after) +
          '</td><td><b>' + esc(s.you) + '</b></td></tr>').join('')
        : '<tr><td>导数据</td><td>你逐个后台导出、另存</td><td>程序自动导出</td><td><b>确认有没有缺表</b></td></tr>' +
          '<tr><td>核对</td><td>你一行行对</td><td>程序比对出差异清单</td><td><b>判断差异要不要处理</b></td></tr>' +
          '<tr><td>出结果</td><td>你凭经验估</td><td>程序按你定的规则算</td><td><b>改规则、拍板</b></td></tr>') +
    '</tbody></table>' +
    (scripts.length ? '<div class="note">涉及的程序共 ' + scripts.length + ' 个：' +
      scripts.map(s => esc(s.name)).join('、') + '。它们的规则由你确认后才生效。</div>' : '') +

    '<h2><span class="no">2</span>你多了两件事（这才是你不可替代的地方）</h2>' +
    '<ul>' +
      '<li><b>判断权。</b>所有拿不准的情况，系统都交给你，不自己做主——' +
        '比如数量对不上、金额异常、数据缺失、供应商改了规则。这些情况它只会列出来，等你决定。</li>' +
      '<li><b>署名权。</b>你定的判断规则会被写进流程说明，标注"规则由 ' + esc(a.operatorName || '（你的名字）') +
        ' 确认"。以后换人接手，这套东西是你的工作成果，不是一堆没人看得懂的脚本。</li>' +
    '</ul>' +

    '<h2><span class="no">3</span>你需要投入多少</h2>' +
    '<table><thead><tr><th style="width:30%">时间</th><th>做什么</th><th style="width:22%">大概多久</th></tr></thead><tbody>' +
      '<tr><td>前 2 周</td><td>把"你凭什么这么判断"讲清楚（这部分只有你能提供）</td><td>每天约 30 分钟</td></tr>' +
      '<tr><td>之后每天</td><td>看异常清单，处理需要人决定的部分</td><td>约 ' + (calc.review || 5) + ' 分钟</td></tr>' +
      '<tr><td>规则变更时</td><td>确认新的判断口径（比如平台改了规则）</td><td>按次，通常 10 分钟内</td></tr>' +
    '</tbody></table>' +

    '<h2><span class="no">4</span>你的否决权</h2>' +
    '<p>任何一步你觉得不放心，<b>可以要求保留人工执行，不需要理由</b>。这条会写进交接文件，服务方不得以"已经做好了"为由拒绝。</p>' +

    '<h2><span class="no">5</span>如果程序判错了</h2>' +
    '<p>不会影响你的原始数据：程序只读取、不覆盖。每次运行都留记录，哪一步错了能查到。' +
      '判错的责任由服务方修规则，不由你承担。</p>' +

    signBlock('我已阅读（签名 / 日期）', '服务方（签名 / 日期）') +
    '<div class="foot">这份说明由 FDE Manager 生成。如果你的实际感受和这份文件不一致，' +
      '以你的感受为准——请直接告诉服务方，这属于交付问题，不属你配合不到位。</div>';

  return wrapDoc('你的工作会变成什么样 · ' + flow, body);
}

/** ③ 给审核员：5 项核对清单（签字 = 核对过，不是担保结果） */
function renderReviewerNote(ev, adopt, calc) {
  const a = adopt || {};
  const flow = a.flowName || ev.project.name;
  const dataItems = (ev.context || []).filter(c => c.kind === 'file' || c.kind === 'dir' || c.kind === 'db');
  const other = (ev.context || []).filter(c => !(c.kind === 'file' || c.kind === 'dir' || c.kind === 'db'));

  const body =
    '<div class="cover">' +
      '<div class="kicker">Reviewer Checklist</div>' +
      '<h1>审核清单 · ' + esc(flow) + '</h1>' +
      '<div class="sub">' + esc(ev.case.client || '') + ' · 给 ' + esc(a.reviewerName || '审核 / 复核同事') +
        ' · ' + fmtDate(Date.now()) + '</div>' +
    '</div>' +

    '<div class="note"><b>你签的不是"这套系统一定不出错"。</b>你签的是：<b>我核对过下面 5 项，并且知道边界在哪。</b>' +
      '有任何保留，写在最后的保留意见栏即可，<b>一样算通过</b>——不需要用"不签"来表达担心。</div>' +

    '<h2><span class="no">1</span>数据范围：程序只碰这些位置</h2>' +
    (dataItems.length
      ? '<table><thead><tr><th style="width:22%">类型</th><th style="width:34%">名称</th><th>位置 / 说明</th></tr></thead><tbody>' +
        dataItems.map(c => '<tr><td>' + esc(c.kind) + '</td><td>' + esc(c.title) + '</td><td class="mono path">' +
          esc(c.value) + '</td></tr>').join('') + '</tbody></table>'
      : '<p>本次交付未登记明确的数据位置。请要求服务方补充后再核对此项。</p>') +
    (other.length ? '<div class="note">其余非数据类材料 ' + other.length + ' 项（网页/账号说明/备注等），不涉及文件读写：' +
      other.map(c => esc(c.title)).join('、') + '</div>' : '') +
    '<div class="chkline"><span class="cb"></span><span><b>核对方式：</b>让服务方当场打开上述目录，确认没有其他路径被程序读取。</span></div>' +

    '<h2><span class="no">2</span>能做什么：程序执行的动作</h2>' +
    (ev.scripts.length
      ? '<table><thead><tr><th style="width:26%">程序</th><th>做什么</th><th style="width:18%">最近结果</th></tr></thead><tbody>' +
        ev.scripts.map(s => '<tr><td>' + esc(s.name) + '</td><td class="mono path">' + esc(s.path) + '</td>' +
          '<td>' + (s.lastCode == null ? '未运行' : (s.lastCode === 0 ? '成功' : '失败 ' + s.lastCode)) + '</td></tr>').join('') +
        '</tbody></table>'
      : '<p>本次交付尚未登记程序清单。</p>') +
    '<div class="chkline"><span class="cb"></span><span><b>核对方式：</b>要求演示一次，用人工结果对照输出，确认数值一致。</span></div>' +

    '<h2><span class="no">3</span>不能做什么：明确排除在外</h2>' +
    '<ul>' +
      '<li>不代客户下单、不修改价格、不发起付款、不转账；</li>' +
      '<li>不删除、不覆盖任何原始数据文件（只读取并在新文件里写结果）；</li>' +
      '<li>不向任何外部服务器发送数据（程序本体无外发功能，断网可用）；</li>' +
      '<li>不在无人确认的情况下对外发送任何内容（邮件/消息/申报由人确认后发出）。</li>' +
    '</ul>' +
    '<div class="chkline"><span class="cb"></span><span><b>核对方式：</b>逐条口头确认，并写入 SOW「明确不包含」一节。</span></div>' +

    '<h2><span class="no">4</span>出错怎么办：可发现、可接管、可回滚</h2>' +
    '<ul>' +
      '<li>每次执行留记录：时间、结果、退出码、输出摘要，可在程序内直接查看；</li>' +
      '<li>失败不静默：失败会有明确记录，不会"看起来成功了"；</li>' +
      '<li>原始数据不被覆盖，最差情况是重跑一次；</li>' +
      '<li>人可以随时停用任何一步，改回手工执行。</li>' +
    '</ul>' +
    '<div class="chkline"><span class="cb"></span><span><b>核对方式：</b>要求现场制造一次失败（如断开数据源），看记录是否清楚。</span></div>' +

    '<h2><span class="no">5</span>谁负责：责任与联系人</h2>' +
    '<table><thead><tr><th style="width:30%">事项</th><th>责任人 / 约定</th></tr></thead><tbody>' +
      '<tr><td>日常对接</td><td>' + esc(a.contact || '（待填：姓名 / 联系方式）') + '</td></tr>' +
      '<tr><td>故障响应</td><td>' + esc(a.sla || '工作日 4 小时内响应，24 小时内恢复') + '</td></tr>' +
      '<tr><td>赔偿上限</td><td>以合同第五条为准（一般等于该期服务费用）</td></tr>' +
      '<tr><td>乙方不承担的</td><td>第三方平台规则变化、账号封禁、客户系统变更、不可抗力</td></tr>' +
    '</tbody></table>' +

    '<h2><span class="no">6</span>核对结论（三选一，都可以签字）</h2>' +
    '<div style="margin:10px 0;">' +
      '<div class="chkline"><span class="cb"></span><span><b>核对通过</b> —— 5 项均已核对，无保留意见。</span></div>' +
      '<div class="chkline"><span class="cb"></span><span><b>有条件通过</b> —— 基本可接受，但有保留意见（写在下面），需要服务方在约定期限内补充。</span></div>' +
      '<div class="chkline"><span class="cb"></span><span><b>不通过</b> —— 具体原因写在下面；服务方整改后重新提交，不影响后续再次核对。</span></div>' +
    '</div>' +
    '<div style="border:1px solid #cfd5df;border-radius:4px;padding:12px;min-height:78px;">' +
      '<div style="font-size:10.5px;color:#6b7385;margin-bottom:4px;">保留意见 / 不通过原因：</div></div>' +

    signBlock('审核人（签字 / 日期）', '服务方（签字 / 日期）') +
    '<div class="foot">本清单由 FDE Manager 根据该项目实际配置生成。' +
      '若你核对时发现清单与实际不符，以实际为准，并要求服务方更正后再签字。</div>';

  return wrapDoc('审核清单 · ' + flow, body);
}

/** 干系人推进建议：按角色 + 态度给出下一步动作，不写空话 */
function suggestNext(role, attitude) {
  const r = ROLE_DEFS[role] || ROLE_DEFS.operator;
  // 用"该给他什么、该一起做什么"的口吻，谁看到都不别扭
  if (attitude === 'resist') {
    const map = {
      boss: '先别推。给他决策版一页纸（写清不做的代价、可随时停），两周后再谈。',
      operator: '单独谈一次，不带上主管。先把分工写清（不动编制、判断权与否决权在他），再请他用两周并行对照。',
      reviewer: '不要求他审代码。给核对清单 + 有条件通过的出口，把签字落成"核对过这几项"。',
      it: '给数据处理说明（含数据流向），并主动提出可以当场断网验证。',
      finance: '给按工时计价 + 按月核对的方案，不做一次性大包。',
      mid: '口径先由他定：报表用释放工时，不动编制口径，数据怎么呈现他先说。'
    };
    return map[role] || r.action;
  }
  if (attitude === 'neutral' || attitude === 'unknown') {
    const map = {
      boss: '从他已经在意的那个数切入（交期、差错、加班），别从技术讲起。',
      operator: '请他确认现状数据（每天多久、哪步最烦），这两个数后面全靠它。',
      reviewer: '把核对清单提前给他，请他提出要改的地方，签字那天只是确认。',
      it: '提前过会，别等上线前才报备。',
      finance: '先对口径，再谈金额。',
      mid: '先问他的考核指标是什么，再定报表怎么呈现。'
    };
    return map[role] || r.action;
  }
  return '已支持：请他在关键场合讲一句他的判断（比服务方讲十句有用），并把他支持的范围记进决策记录。';
}

module.exports = {
  ROLE_DEFS,
  ATTITUDES,
  OBSTACLES,
  MUTUAL,
  computeAdoption,
  renderBossBrief,
  renderOperatorBrief,
  renderReviewerNote,
  suggestNext
};
