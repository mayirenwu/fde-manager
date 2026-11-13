/**
 * 确认台账（acks）
 *
 * 这是所有参与方一起过一遍的清单：客户方的决策人 / 操作员 / 复核人 / IT / 财务，
 * 以及服务方。每一项写清四件事：
 *   谁要确认（roles）、确认的是什么（title/hint）、
 *   这一条对各方各自有什么用（why）、依据在哪一页能看到（page）。
 *
 * 三个原则：
 *  1. 只收事实，不收评价。"数据目录在哪"可以确认，"这套东西好不好"不能。
 *  2. 每一项都对多方有用，不是给某一方交作业——没人会为别人的作业签字。
 *  3. 确认可撤回、可改、可提异议。逼着人一次点对，等于逼着人不点。
 */

const ACK_DEFS = [
  {
    key: 'scope',
    title: '数据范围与存放位置',
    who: '客户 IT',
    roles: ['it', 'fde'],
    hint: '程序只读写本机文件，不向外部服务器发送内容，断网可用全部功能。数据在哪、谁能碰，这一条写清楚。',
    why: 'IT 拿它过会；服务方拿它免扯皮；真出问题时，双方指的是同一条。',
    page: 'security'
  },
  {
    key: 'baseline',
    title: '流程口径（每次人工耗时、每月频次）',
    who: '客户负责人',
    roles: ['boss', 'operator'],
    hint: '后面所有数字都由这两个数推出来。先谈定口径，以后不用争；频次优先用近 30 天实测，不靠估。',
    why: '客户拿它判断值不值；服务方拿它证明值不值；数字有争议时回到这一条。',
    page: 'people'
  },
  {
    key: 'scripts',
    title: '自动执行的脚本清单',
    who: '客户核对',
    roles: ['operator', 'reviewer'],
    hint: '每个脚本做什么、跑在哪个目录、最近一次结果，都能逐条看。',
    why: '操作员知道哪些活不用手做了；复核人知道界线在哪；服务方不用反复解释同一件事。',
    page: 'evidence'
  },
  {
    key: 'runs',
    title: '执行记录与成功率',
    who: '客户核对',
    roles: ['reviewer', 'boss'],
    hint: '含失败记录与退出码，不做筛选。',
    why: '复核人据此签字；决策人据此看进展；服务方据此证明在干活，而不是在讲故事。',
    page: 'evidence'
  },
  {
    key: 'roles',
    title: '人员分工与职责',
    who: '操作员 / 复核人',
    roles: ['operator', 'reviewer'],
    hint: '谁操作、谁复核、谁有权叫停。不涉及编制调整，也不改变汇报关系。',
    why: '操作员据此知道自己不会被绕过；复核人知道责任边界；服务方知道每一步找谁。',
    page: 'people'
  },
  {
    key: 'security',
    title: '数据不外发与退出交接',
    who: '客户 IT',
    roles: ['it', 'fde'],
    hint: '退出时交付完整快照，不用授权锁、不远程停用；数据与脚本留在客户机器上。',
    why: '客户不怕被绑定；服务方也把边界说清楚，免得被当成黑盒。',
    page: 'security'
  },
  {
    key: 'fee',
    title: '费用、周期与责任上限',
    who: '客户负责人 / 财务',
    roles: ['boss', 'finance', 'fde'],
    hint: '金额、结算方式、出问题赔到哪为止——写清楚比写漂亮更重要。',
    why: '财务好入账；决策人好批；服务方好排交付；争议时不用翻聊天记录。',
    page: 'terms'
  },
  {
    key: 'accept',
    title: '本期验收结论',
    who: '双方',
    roles: ['boss', 'reviewer', 'fde'],
    hint: '三种结论都算通过：通过 / 有条件通过 / 不通过（须写明原因）。',
    why: '客户拿到能存档的结论；服务方拿到能复用的证据；下一期从这里接着谈。',
    page: 'evidence'
  }
];

const VALID_STATE = ['ok', 'object', 'pending'];

/** 合并默认条目与已存状态，返回带状态、署名、时间的完整清单 */
function acksOf(p) {
  const store = (p && p.acks && typeof p.acks === 'object' && !Array.isArray(p.acks)) ? p.acks : {};
  return ACK_DEFS.map(d => {
    const s = store[d.key] || {};
    return {
      key: d.key,
      title: d.title,
      who: d.who,
      roles: d.roles || [],
      hint: d.hint,
      why: d.why || '',
      page: d.page,
      state: VALID_STATE.includes(s.state) ? s.state : 'pending',
      by: typeof s.by === 'string' ? s.by : '',
      at: Number(s.at) || 0,
      remark: typeof s.remark === 'string' ? s.remark : ''
    };
  });
}

/** 统计进度，给首页进度条和导航徽标用 */
function ackStats(list) {
  const arr = Array.isArray(list) ? list : [];
  const total = ACK_DEFS.length;
  const ok = arr.filter(a => a.state === 'ok').length;
  const object = arr.filter(a => a.state === 'object').length;
  return {
    total,
    ok,
    object,
    pending: Math.max(0, total - ok - object),
    pct: total ? Math.round(ok / total * 100) : 0,
    // 有人提异议就算"未完成"——不能因为 7/8 通过就当成通过
    complete: total > 0 && ok === total && object === 0
  };
}

/**
 * 待确认项按"在等哪一方"分组，用于首页那行"谁在等谁"。
 * 一个条目可能同时要几方确认，就按第一个非服务方的角色归类。
 */
function waitByRole(list) {
  const LABEL = { boss: '决策人', operator: '操作员', reviewer: '复核人', it: 'IT', finance: '财务', fde: '服务方' };
  const out = {};
  for (const a of (Array.isArray(list) ? list : [])) {
    if (a.state !== 'pending') continue;
    const roles = a.roles || [];
    const key = roles.find(r => r !== 'fde') || roles[0] || 'boss';
    const k = LABEL[key] || key;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * 写入一项确认。返回 { ok, error, acks, ackStats }。
 * 校验放在这里，IPC 只负责落盘和广播——这样规则只有一份，测得到。
 */
function setAck(p, key, state, by, remark) {
  if (!p) return { ok: false, error: '项目不存在' };
  if (!ACK_DEFS.some(d => d.key === key)) return { ok: false, error: '未知的确认项' };
  if (!VALID_STATE.includes(state)) return { ok: false, error: '状态无效' };
  const name = String(by == null ? '' : by).trim();
  const note = String(remark == null ? '' : remark).trim();
  if (state !== 'pending' && !name) return { ok: false, error: '请填写署名，确认要记名' };
  if (state === 'object' && !note) return { ok: false, error: '异议要写清原因，否则无法处理' };

  if (!p.acks || typeof p.acks !== 'object' || Array.isArray(p.acks)) p.acks = {};
  if (state === 'pending') {
    delete p.acks[key];
  } else {
    p.acks[key] = { state, by: name, at: Date.now(), remark: note };
  }
  const list = acksOf(p);
  return { ok: true, acks: list, ackStats: ackStats(list) };
}

/** 一段摘要，方便贴到群里或写进报告附录——各方看到的是同一份 */
function ackDigest(p) {
  const list = acksOf(p);
  const st = ackStats(list);
  const mark = { ok: '✓ 已确认', object: '! 有异议', pending: '· 待确认' };
  const head = (p && p.name ? '项目：' + p.name + '\n' : '') +
    '确认进度 ' + st.ok + '/' + st.total + (st.object ? '（' + st.object + ' 项有异议）' : '');
  const body = list.map(a => mark[a.state] + '  ' + a.title +
    (a.state === 'ok' ? '  —— ' + a.by + ' ' + fmtDay(a.at) : '') +
    (a.state === 'object' ? '  —— ' + a.by + '：' + a.remark : ''));
  const tail = st.complete ? '\n（八项均无异议，可作为本期验收依据）'
    : '\n（有异议的项目处理完之前，这份记录不作为验收依据）';
  return [head, ...body, tail.trim()].join('\n');
}

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = { ACK_DEFS, acksOf, ackStats, waitByRole, setAck, ackDigest };
