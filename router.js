/**
 * 自动挑模型（纯函数，方便单测）
 * ------------------------------------------------------------------
 * 背景：默认只挂一个模型时，它可能不稳、太慢、或者不擅长当前任务
 *       （写脚本要强推理、聊天要便宜快、看图要视觉模型）。
 * 这里只做「按任务给候选排序 + 失败换下一个」的决策，不发网络请求。
 *
 * 用法：
 *   router.isAuto('auto')                       → true
 *   router.plan({ preferred:'auto', task:{...}, chatModels:[...] })
 *     → { auto:true, picked:'gem-3.8-flash', reason:'…', chain:['…','…'] }
 */

const AUTO_ID = 'auto';

/** 是否是「自动」档（没填模型也当自动，避免卡住不让跑） */
function isAuto(m) {
  const s = String(m == null ? '' : m).trim().toLowerCase();
  return !s || s === AUTO_ID || s === '自动';
}

/** 模型能力画像：从名字推档位/视觉/代码（平台命名都带 flash / pro / max / vision 这类词） */
function analyze(name) {
  const raw = String(name || '');
  const n = raw.toLowerCase();
  const tier = /(pro|max|plus|ultra|opus|reason|thinking)/.test(n) ? 3
    : /(flash|mini|lite|turbo|small|nano|speed|air)/.test(n) ? 1
      : 2;
  return {
    name: raw,
    tier,
    vision: /(vision|vl|omni|multimodal|image)/.test(n),
    code: /(coder|code|devstral|deepseek|gem-?3|claude|qwen)/.test(n)
  };
}

/** 从模型列表里挑出聊天类（排除明显的图片/视频/音乐模型） */
function chatOnly(list) {
  const out = [];
  const seen = new Set();
  for (const m of (Array.isArray(list) ? list : [])) {
    const name = typeof m === 'string' ? m : (m && (m.name || m.id));
    if (!name || seen.has(name)) continue;
    const n = String(name).toLowerCase();
    if (/(suno|udio|tts|speech|voice|whisper|asr|seedance|kling|vidu|sora|veo|runway|hailuo|seedream|flux|midjourney|mj_|dall-?e|stable-?diffusion|tt-image|kolors|ideogram|recraft|banana)/.test(n)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 按任务给每个模型打分（分高者优先）。
 * task = { purpose, hasImages, chars, needQuality }
 *   purpose: 'chat' 普通对话 | 'build' 搭台出方案 | 'script' 写脚本 | 'canvas' 画布节点 | 'quick' 快速归类
 */
function score(model, task) {
  const a = analyze(model);
  const t = task || {};
  let s = a.tier * 10;
  const purpose = String(t.purpose || 'chat');
  if (purpose === 'build' || purpose === 'script') s += a.tier === 3 ? 26 : a.tier === 2 ? 7 : -12;
  else if (purpose === 'quick') s += a.tier === 1 ? 22 : a.tier === 2 ? 8 : -6;
  else s += a.tier === 2 ? 14 : a.tier === 1 ? 9 : 3;
  const chars = Number(t.chars || 0);
  if (chars > 8000) s += a.tier === 3 ? 16 : -8;
  else if (chars > 2500) s += a.tier >= 2 ? 6 : -2;
  if (t.hasImages) s += a.vision ? 120 : -60;          // 有图就必须视觉模型
  if (t.needQuality) s += a.tier === 3 ? 18 : -4;
  if (purpose === 'build' && a.code) s += 4;
  return s;
}

/** 某任务适合什么样的模型（一句话给界面看） */
function reasonOf(task) {
  const t = task || {};
  if (t.hasImages) return '这次带了图，自动选了能看图的模型';
  if (t.purpose === 'build') return '搭台要出方案，自动选了推理强的模型';
  if (t.purpose === 'script') return '写脚本要稳，自动选了代码/推理强的模型';
  if (t.purpose === 'quick') return '这是快问快答，自动选了轻快的模型';
  if (Number(t.chars || 0) > 8000) return '材料很长，自动选了能扛长文的模型';
  return '普通对话，自动选了综合最稳的模型';
}

/**
 * 决策：给任务排一条候选链。
 * - auto：picked = 分最高的；chain = 后面依次是备胎（同档优先，再往高档找）
 * - 固定模型：picked = 用户选的；chain 仍包含备胎，主进程按「自动换」开关决定用不用
 */
function plan(opts) {
  const o = opts || {};
  const list = chatOnly(o.chatModels);
  const auto = isAuto(o.preferred);
  const task = o.task || {};
  if (!list.length) {
    return { auto, picked: auto ? '' : String(o.preferred || ''), reason: '还没有模型目录', chain: auto ? [] : [String(o.preferred || '')].filter(Boolean) };
  }
  const ranked = list
    .map(name => ({ name, s: score(name, task), tier: analyze(name).tier }))
    .sort((a, b) => b.s - a.s || b.tier - a.tier || String(a.name).localeCompare(String(b.name)));
  let picked = ranked[0].name;
  if (!auto) {
    const want = String(o.preferred || '').trim();
    if (want && list.includes(want)) picked = want;
    else if (want) {
      // 用户填的模型不在目录里（可能手打错字），仍先试它一次，再自动兜底
      const rest = ranked.map(x => x.name).filter(x => x !== want);
      return { auto: false, picked: want, reason: '按你选的模型跑，不行会自动换', chain: [want].concat(rest.slice(0, 3)) };
    }
  }
  // 候选链：先同档的其它模型（互为备份），再高档，最后其它
  const pt = analyze(picked).tier;
  const others = ranked.filter(x => x.name !== picked);
  const sameTier = others.filter(x => x.tier === pt).map(x => x.name);
  const higher = others.filter(x => x.tier > pt).sort((a, b) => b.tier - a.tier).map(x => x.name);
  const lower = others.filter(x => x.tier < pt).map(x => x.name);
  const chain = [picked].concat(sameTier.slice(0, 2), higher.slice(0, 1), lower.slice(0, 1));
  return { auto, picked, reason: auto ? reasonOf(task) : '按你选的模型跑，不行会自动换', chain: Array.from(new Set(chain)).slice(0, 4) };
}

/** 这次失败要不要换个模型再试（密钥/网络/网页地址这类换模型也没用） */
function worthRetry(kind, triedCount, max) {
  const k = String(kind || '');
  if (triedCount >= (max || 3)) return false;
  if (k === 'nokey' || k === 'auth' || k === 'dns' || k === 'html' || k === 'nomodel') return false;
  return true;
}

/**
 * 沿候选链逐个试（不碰网络：chat 由调用方注入）。
 * opts: { chain, canSwitch, maxTries, chat(model) → {ok, kind, ...}, onSwitch(prev, next, i) }
 * 返回 { ok, result, tried, last }
 */
async function runWithFallback(opts) {
  const o = opts || {};
  const chain = Array.isArray(o.chain) ? o.chain : [];
  const max = o.maxTries || 4;
  const tried = [];
  let last = null;
  for (let i = 0; i < chain.length && tried.length < max; i++) {
    const model = chain[i];
    if (i > 0) {
      if (o.canSwitch === false) break;
      if (!worthRetry(last && last.kind, tried.length - 1, max)) break;
      if (typeof o.onSwitch === 'function') { try { o.onSwitch(tried[tried.length - 1], model, i); } catch (e) {} }
    }
    let r;
    try { r = await o.chat(model); } catch (e) { r = { ok: false, kind: 'crash', error: String(e && e.message || e) }; }
    if (r && r.ok) return { ok: true, result: r, tried: tried.concat([model]), last: null };
    tried.push(model);
    last = r || { ok: false, kind: 'unknown', error: '未知错误' };
    if (o.canSwitch === false) break;
  }
  return { ok: false, result: null, tried, last };
}

module.exports = { AUTO_ID, isAuto, analyze, chatOnly, score, reasonOf, plan, worthRetry, runWithFallback };
