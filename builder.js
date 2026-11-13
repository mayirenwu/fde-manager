/**
 * 搭台 Agent：用户说一句需求，AI 返回方案（JSON），这里负责校验并落到本地数据。
 * ------------------------------------------------------------------
 * 职责边界：
 *   buildPrompt()  把"当前已有哪些项目/节点 + 用户需求"拼成给模型的消息
 *   parsePlan()    宽容地从模型回复里抠出 JSON 方案
 *   applyPlan()    按方案创建项目（含自动打开/脚本文件）+ 画布节点 + 连线
 *   summarize()    生成给用户看的"搭了什么"
 * 数据约定（中文键，方便模型稳定输出）：
 *   { 项目:[{名称,颜色?,上下文?,自动打开:[{类型:网页|应用,名称,网址?,路径?,参数?}],脚本:[{名称,内容,说明?}]}],
 *     节点:[{类型:项目|脚本|网页|AI|笔记|分组,标题,说明?,项目名?,网址?,脚本名?,模型?,多模型?,自动打开?}],
 *     连线:[[从标题,到标题]],
 *     说明:"一句话给用户" }
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

// 生成的脚本要跟着系统走：Windows 用 .ps1（PowerShell），macOS/Linux 用 .sh（bash）
const SCRIPT_EXT = platform.caps().scriptExt;
const IS_WIN = platform.caps().id === 'win32';

const NODE_TYPE_MAP = { '项目': 'project', '脚本': 'script', '网页': 'url', 'AI': 'ai', '笔记': 'note', '分组': 'group',
  '图片': 'gen', '视频': 'gen', '音乐': 'gen' };
// 生成节点的模态：画布上就是一个 gen 节点，靠 ref.modal 区分图片/视频/音乐
const GEN_MODAL = { '图片': 'image', '视频': 'video', '音乐': 'audio' };
const MAX_NODES = 40, MAX_EDGES = 60, MAX_PROJECTS = 8;

function clampStr(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n);
}
function rid(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/** 拼给模型的消息（system 讲规则，user 带现状+需求） */
function buildPrompt(projects, canvas, userRequest) {
  const ps = (Array.isArray(projects) ? projects : []).map(p => ({
    名称: p.name, 节点数: (p.items || []).length,
    自动打开: (p.autorun || []).map(a => a.name || a.path || a.url || '').slice(0, 8)
  }));
  const ns = (canvas && Array.isArray(canvas.nodes) ? canvas.nodes : []).slice(0, 40).map(n => ({
    标题: n.title, 类型: n.type, 说明: String(n.note || '').slice(0, 60)
  }));
  const system = [
    '你是 FDE 软件的「搭台助手」。用户用一句话描述需求，你输出一套可直接落地的搭建方案（严格 JSON，不要多余文字、不要 markdown 代码块以外的解释）。',
    'JSON 结构：',
    '{"项目":[{"名称":"…","颜色":"#4f8cff","上下文":"这个项目是干什么的","自动打开":[{"类型":"网页","名称":"卖家后台","网址":"https://…"},{"类型":"应用","名称":"ERP","路径":"D:\\\\erp.exe","参数":""}],"脚本":[{"名称":"整理订单","内容":"Write-Host …","说明":"做什么"}]}],',
    '"节点":[{"类型":"项目|脚本|网页|AI|笔记|分组","标题":"…","说明":"…","项目名":"关联的项目名称","网址":"https://…","脚本名":"关联的脚本名称","模型":"模型id","多模型":["id1","id2"],"自动打开":true}],',
    '"连线":[["从节点标题","到节点标题"]],',
    '"说明":"给用户看的一句话总结"}',
    '规则：',
    '1) 节点类型只有 项目/脚本/网页/AI/图片/视频/音乐/笔记/分组；脚本项目内没有对应脚本时不要建脚本节点。',
    '2) 已存在的项目直接复用（项目名写它），不要重复创建；拿不准就新建，名字具体一点。',
    '3) 脚本内容用' + (IS_WIN ? ' PowerShell（.ps1）' : ' Bash（.sh，首行 #!/usr/bin/env bash）') +
    '，要能直接跑：开头写注释说明用途，别引用不存在的文件；用户没给路径的程序不要编路径，让"自动打开"里留空路径并由用户后补。',
    '4) 连线用节点标题引用，两端必须都出现在节点列表里；流程顺序按 用户输入 → 处理 → 输出。',
    '5) 全部数量克制：项目 ≤8、节点 ≤30、连线 ≤40。',
    '6) 只输出 JSON。'
  ].join('\n');
  const user = [
    '当前已有的项目：' + JSON.stringify(ps),
    '当前画布节点：' + JSON.stringify(ns),
    '用户需求：' + clampStr(userRequest, 1500)
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 宽容解析：剥 markdown 围栏，取第一个 { 到最后一个 } */
function parsePlan(text) {
  let s = String(text || '').trim();
  s = s.replace(/```(?:json)?/gi, '```');
  const fence = s.indexOf('```');
  if (fence >= 0) {
    const end = s.indexOf('```', fence + 3);
    if (end > fence) s = s.slice(fence + 3, end);
  }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, error: '回复里没有找到 JSON 方案' };
  try {
    const plan = JSON.parse(s.slice(a, b + 1));
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, error: 'JSON 结构不对' };
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + e.message };
  }
}

/** 写脚本文件：userData/pack-scripts/auto/<项目名>/<脚本名>.<平台扩展名>，返回路径 */
function writeScript(scriptRoot, projName, name, content) {
  const dir = path.join(scriptRoot, 'auto', clampStr(projName, 30).replace(/[\\/:*?"<>|]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, clampStr(name, 30).replace(/[\\/:*?"<>|]/g, '_') + SCRIPT_EXT);
  const body = String(content || '').trim() ||
    (IS_WIN
      ? ('# ' + clampStr(name, 30) + '（搭台助手生成的骨架，补上具体步骤即可）\nWrite-Host "TODO: ' + clampStr(name, 30) + '"\n')
      : ('#!/usr/bin/env bash\n# ' + clampStr(name, 30) + '（搭台助手生成的骨架，补上具体步骤即可）\nset -euo pipefail\necho "TODO: ' + clampStr(name, 30) + '"\n'));
  fs.writeFileSync(file, body, 'utf8');
  if (!IS_WIN) { try { fs.chmodSync(file, 0o755); } catch (e) {} }
  return file;
}

/**
 * 把方案落进 data（projects + canvas），直接改传入对象，由调用方 saveData。
 * @returns {{created:{projects:[],nodes:[],edges:[],scripts:[]}, errors:[]}}
 */
function applyPlan(data, plan, opts) {
  const o = opts || {};
  const created = { projects: [], nodes: [], edges: [], scripts: [] };
  const errors = [];
  if (!data || typeof data !== 'object') return { created, errors: ['数据对象无效'] };
  if (!data.canvas || !Array.isArray(data.canvas.nodes)) return { created, errors: ['画布数据无效'] };
  if (!Array.isArray(data.projects)) data.projects = [];

  const planProjects = Array.isArray(plan.项目) ? plan.项目.slice(0, MAX_PROJECTS) : [];
  const planNodes = Array.isArray(plan.节点) ? plan.节点.slice(0, MAX_NODES) : [];
  const planEdges = Array.isArray(plan.连线) ? plan.连线.slice(0, MAX_EDGES) : [];

  // 1) 项目：重名复用，否则新建
  const projByName = new Map(data.projects.map(p => [p.name, p]));
  const scriptPathByName = new Map(); // 脚本名 -> 文件路径（跨项目也可能引用）
  for (const pj of planProjects) {
    const name = clampStr(pj && pj.名称, 40);
    if (!name) { errors.push('有个项目没写名称，已跳过'); continue; }
    let p = projByName.get(name);
    const isNew = !p;
    if (!p) {
      p = {
        id: rid('p'), name,
        color: /^#[0-9a-fA-F]{6}$/.test(String(pj.颜色 || '')) ? pj.颜色 : '',
        items: [], autorun: [], windows: [], context: [],
        approvals: {}, acks: {}, stakeholders: [], adoption: {}, case: {},
        exclusive: true, status: 'stopped', statusMsg: ''
      };
      data.projects.push(p);
      projByName.set(name, p);
    }
    if (isNew) created.projects.push(name);
    if (pj.上下文 && String(pj.上下文).trim()) {
      p.context.push({ id: rid('c'), kind: 'text', title: '搭台说明', value: clampStr(pj.上下文, 800) });
    }
    // 自动打开 → autorun
    for (const a of (Array.isArray(pj.自动打开) ? pj.自动打开.slice(0, 10) : [])) {
      const an = clampStr(a && a.名称, 40);
      if (a && a.类型 === '网页' && /^https?:\/\//i.test(String(a.网址 || ''))) {
        p.autorun.push({ type: 'url', url: String(a.网址).slice(0, 500), name: an, delay: 0 });
      } else if (a && String(a.路径 || '').trim()) {
        p.autorun.push({ type: 'app', path: clampStr(a.路径, 300), name: an, args: clampStr(a.参数, 200), delay: 0, optional: true });
      } else if (an) {
        errors.push('「' + an + '」没给网址或路径，先记下名字，等你补');
      }
    }
    // 脚本 → 写 .ps1 文件
    for (const sc of (Array.isArray(pj.脚本) ? pj.脚本.slice(0, 8) : [])) {
      const sn = clampStr(sc && sc.名称, 40);
      if (!sn) continue;
      try {
        const file = writeScript(o.scriptRoot || '.', name, sn, sc.内容);
        created.scripts.push({ project: name, name: sn });
        scriptPathByName.set(sn, file);
      } catch (e) {
        errors.push('脚本「' + sn + '」写文件失败：' + e.message);
      }
    }
  }

  // 2) 画布节点
  const colMax = 4;
  const baseX = 120 + (data.canvas.nodes.length % colMax) * 320;
  const baseY = 120 + Math.floor(data.canvas.nodes.length / colMax) * 260;
  const byTitle = new Map(data.canvas.nodes.map(n => [n.title, n]));
  planNodes.forEach((pn, i) => {
    const type = NODE_TYPE_MAP[String(pn && pn.类型 || '').trim()] || 'note';
    const title = clampStr(pn && pn.标题, 40) || (type + '节点' + (i + 1));
    if (byTitle.has(title)) {
      errors.push('节点「' + title + '」已存在，跳过'); return;
    }
    const ref = {};
    if (type === 'gen') {
      const modal = GEN_MODAL[String(pn && pn.类型 || '').trim()] || 'image';
      ref.modal = modal;
      ref.model = clampStr(pn.模型, 120);
      ref.prompt = clampStr(pn.提示词 || pn.说明, 800);
      ref.params = {};
      ref.urls = [];
    }
    if (type === 'project') {
      const pname = clampStr(pn.项目名, 40);
      const p = projByName.get(pname);
      if (!p) { errors.push('节点「' + title + '」引用的项目「' + pname + '」不存在，改成笔记'); }
      else { ref.projectId = p.id; ref.autoRun = !!pn.自动打开; }
    }
    if (type === 'url') {
      if (!/^https?:\/\//i.test(String(pn.网址 || ''))) { errors.push('网页节点「' + title + '」网址无效，改成笔记'); }
      else ref.url = String(pn.网址).slice(0, 500);
    }
    if (type === 'script') {
      const sn = clampStr(pn.脚本名, 40);
      const file = scriptPathByName.get(sn);
      if (!file) { errors.push('脚本节点「' + title + '」找不到脚本「' + sn + '」，改成笔记'); }
      else ref.path = file;
    }
    const finalType = (type === 'project' && !ref.projectId) || (type === 'url' && !ref.url) ||
      (type === 'script' && !ref.path) ? 'note' : type;
    const n = {
      id: rid('n'), type: finalType, title,
      note: clampStr(pn.说明, 800),
      x: baseX + (i % colMax) * 320, y: baseY + Math.floor(i / colMax) * 260,
      w: 240, h: 0, color: '', ref, collapsed: false, locked: false, tags: ['搭台'], z: 0
    };
    if (finalType === 'ai') {
      if (Array.isArray(pn.多模型) && pn.多模型.length) n.models = pn.多模型.slice(0, 6).map(m => clampStr(m, 60));
      else if (pn.模型) n.model = clampStr(pn.模型, 60);
    }
    data.canvas.nodes.push(n);
    byTitle.set(title, n);
    created.nodes.push(title + '（' + (Object.keys(NODE_TYPE_MAP).find(k => NODE_TYPE_MAP[k] === finalType) || finalType) + '）');
  });

  // 3) 连线
  for (const pair of planEdges) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const from = byTitle.get(clampStr(pair[0], 40)), to = byTitle.get(clampStr(pair[1], 40));
    if (!from || !to || from.id === to.id) { errors.push('连线「' + clampStr(pair[0], 20) + '→' + clampStr(pair[1], 20) + '」有一端不存在，跳过'); continue; }
    if (data.canvas.edges.some(e => e.from === from.id && e.to === to.id)) continue;
    data.canvas.edges.push({
      id: rid('e'), from: from.id, to: to.id, label: '', kind: 'flow', dashed: false
    });
    created.edges.push(clampStr(pair[0], 20) + '→' + clampStr(pair[1], 20));
  }

  return { created, errors };
}

/** 给用户看的一句话 + 明细 */
function summarize(r) {
  const c = r.created || { projects: [], nodes: [], edges: [], scripts: [] };
  const parts = [];
  if (c.projects.length) parts.push(c.projects.length + ' 个项目');
  if (c.scripts.length) parts.push(c.scripts.length + ' 个脚本');
  if (c.nodes.length) parts.push(c.nodes.length + ' 个节点');
  if (c.edges.length) parts.push(c.edges.length + ' 条连线');
  if (!parts.length) return '没有搭出新东西' + (r.errors && r.errors.length ? '（' + r.errors[0] + '）' : '');
  return '搭好了：' + parts.join('、');
}

/** AI 写完整脚本：提示词（现状 + 需求 → 完整可跑的脚本，语言随平台） */
function scriptPrompt(projName, scriptName, requirement, currentContent) {
  const system = IS_WIN
    ? [
      '你是 FDE 软件的「脚本编写助手」。用户描述一个 Windows 脚本要做什么，你输出一份完整、可直接运行的 PowerShell 脚本。',
      '规则：',
      '1) 只输出脚本本体，不要解释、不要 markdown 围栏以外的文字；可以用 ```powershell 围栏包住。',
      '2) 开头用 <# … #> 注释块写清：用途、用法示例、前置条件（如需要管理员/已装某软件）。',
      '3) 面向 Windows PowerShell 5.1：不要用 ?? 、链式 ?. 等 7+ 语法；中文输出注意编码（必要时 [Console]::OutputEncoding = [Text.Encoding]::UTF8）。',
      '4) 引用文件路径前先 Test-Path；可能失败的步骤要 try/catch 并 Write-Host 中文提示；结束时给出明确的结果输出。',
      '5) 危险操作（删除、覆盖）先确认或先备份；不要下载运行来路不明的程序。',
      '6) 脚本长度控制在 200 行以内，能干完活就行。'
    ].join('\n')
    : [
      '你是 FDE 软件的「脚本编写助手」。用户描述一个 macOS / Linux 脚本要做什么，你输出一份完整、可直接运行的 Bash 脚本。',
      '规则：',
      '1) 只输出脚本本体，不要解释、不要 markdown 围栏以外的文字；可以用 ```bash 围栏包住。',
      '2) 首行必须是 #!/usr/bin/env bash；随后用 # 注释写清用途、用法示例、前置条件。',
      '3) 用 POSIX 兼容写法：set -euo pipefail；路径一律加引号 "$var"；不要用 PowerShell 语法。',
      '4) 中文输出注意终端编码（必要时 export LANG=en_US.UTF-8 或按需设置）。',
      '5) 危险操作（删除、覆盖）先确认或先备份；不要下载运行来路不明的程序。',
      '6) 脚本长度控制在 200 行以内，能干完活就行。'
    ].join('\n');
  const user = [
    '所属项目：' + clampStr(projName || '通用', 40),
    '脚本名：' + clampStr(scriptName || '未命名', 40),
    '现在文件里已有的内容（骨架，参考或重写）：',
    clampStr(String(currentContent || '（空）'), 1200),
    '这个脚本要做什么：' + clampStr(requirement, 1500)
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 宽容解析脚本：剥围栏取正文，校验长度 */
function parseScript(text) {
  let t = String(text || '').trim();
  if (!t) return { ok: false, error: '模型返回了空内容' };
  const fence = t.match(/```(?:powershell|ps1|sh|bash)?\s*\r?\n([\s\S]*?)```/i);
  if (fence && fence[1].trim()) t = fence[1].trim();
  else {
    // 没有围栏时，从第一行注释或第一行代码开始，砍掉可能的寒暄
    const lines = t.split(/\r?\n/);
    const start = lines.findIndex(l => /^\s*(<#|#|\$|param|Write-|function|\[)/i.test(l));
    if (start > 0) t = lines.slice(start).join('\n').trim();
  }
  if (t.length > 40000) return { ok: false, error: '脚本太长（' + t.length + ' 字符），让需求更具体一点再试' };
  const looksLikePs = /^\s*(#|<#|\$|param\b|function\b|if\b|foreach\b|for\b|while\b|try\b|\[|Write-|Get-|Set-|New-|Import-|Export-|Copy-|Move-|Remove-|Start-|Stop-|Test-|Out-)/i;
  if (!/[=:]/.test(t) && !t.split(/\r?\n/).some(l => looksLikePs.test(l))) {
    return { ok: false, error: '返回内容不像脚本', raw: t.slice(0, 200) };
  }
  return { ok: true, script: t };
}

/** 把文本消息转成带图的多模态消息（截图/贴图发给 vision 模型用） */
function toMultimodal(messages, images) {
  const imgs = (Array.isArray(images) ? images : [])
    .filter(u => /^data:image\/(png|jpe?g|webp);base64,/.test(String(u)))
    .slice(0, 3);
  if (!imgs.length) return messages;
  const out = messages.map(m => ({ role: m.role, content: m.content }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user' && typeof out[i].content === 'string') {
      out[i].content = [{ type: 'text', text: out[i].content }]
        .concat(imgs.map(u => ({ type: 'image_url', image_url: { url: u } })));
      break;
    }
  }
  return out;
}

module.exports = { buildPrompt, parsePlan, applyPlan, summarize, writeScript, scriptPrompt, parseScript, toMultimodal, NODE_TYPE_MAP };
