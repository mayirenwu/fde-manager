/**
 * 模型目录与媒体生成（纯函数，方便单测）
 * ------------------------------------------------------------------
 * 平台（api.lk888.ai / ai.my10086.cn 同源）的模型分四类：
 *   chat   文本：对话、写代码、分析（走 /v1/chat/completions）
 *   image  图片：文生图 / 图生图（走 /v1/media/generate 异步任务）
 *   video  视频：文生视频 / 图生视频
 *   audio  音乐 / 语音 / 音色克隆（平台把 TTS、音乐、音效统一归 audio）
 *
 * 画布上的「生成节点」就是按这四类摆的：选模型 → 写提示词 → 填参数 → 跑 → 出图/出片/出歌。
 * 这里只做数据整形，不发网络请求（网络在 ai.js）。
 */

const MEDIA_TYPES = ['image', 'video', 'audio'];
const ALL_TYPES = ['chat', 'image', 'video', 'audio'];

const TYPE_META = {
  chat: { key: 'chat', name: '聊天', icon: '💬', color: '#4f8cff', verb: '对话 / 写作 / 分析' },
  image: { key: 'image', name: '图片', icon: '🖼', color: '#22c55e', verb: '文生图 / 图生图' },
  video: { key: 'video', name: '视频', icon: '🎬', color: '#f59e0b', verb: '文生视频 / 图生视频' },
  audio: { key: 'audio', name: '音乐 / 语音', icon: '🎵', color: '#a855f7', verb: '音乐 / 配音 / 音色克隆' }
};

/** 认不出的模型按名字前缀兜底分类（老接口只给 name 时也能分对） */
const NAME_HINTS = [
  [/^(suno|udio|music|ace-?step|diffrhythm|mureka)/i, 'audio'],
  [/(tts|speech|voice|audio|sound|whisper|asr)/i, 'audio'],
  [/(seedance|kling|vidu|sora|veo|runway|hailuo|luma|wan2|omni|video|mv)/i, 'video'],
  [/(image|flux|mj_|midjourney|dall-?e|stable-?diffusion|sd[-_]?xl|seedream|tt-image|qwen-image|kolors|ideogram|recraft)/i, 'image']
];

function inferType(name) {
  const s = String(name || '');
  for (const [re, t] of NAME_HINTS) if (re.test(s)) return t;
  return 'chat';
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function str(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n || 4000);
}

/**
 * 把 /v1/skills/models（或 /v1/media/models）的返回整理成统一结构。
 * 兼容：{models:[...]}、{data:[...]}、数组；字段 name/id、display_name/label/title。
 */
function normalizeCatalog(payload) {
  const arr = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.models) ? payload.models
      : (payload && Array.isArray(payload.data) ? payload.data : []));
  const out = [];
  const seen = new Set();
  for (const m of arr) {
    if (!m) continue;
    const name = str(m.name || m.id || m.model, 120);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let type = str(m.type || m.modal || '', 20).toLowerCase();
    if (!ALL_TYPES.includes(type)) type = inferType(name);
    out.push({
      name,
      displayName: str(m.display_name || m.displayName || m.label || m.title || name, 80),
      type,
      tags: Array.isArray(m.tags) ? m.tags.map(x => str(x, 24)).slice(0, 10) : [],
      desc: str(m.description || m.desc || '', 600),
      hint: str(m.input_hint || m.hint || '', 600),
      icon: str(m.icon || '', 300),
      apiFormat: str(m.api_format || '', 20),
      endpoint: str(m.api_endpoint || '', 120),
      params: normalizeParams(m.params),
      available: m.available_for_this_key !== false
    });
  }
  return out;
}

/**
 * 参数定义规整：{name,label,type,required,options,min,max,desc,when,limits...}
 * 平台的 /v1/skills/models/<name> 里每个参数带：
 *   type: select / radio / segment / upload / switch / number / textarea / input
 *   options、description、available_when（按 mode 显隐）、upload_limits（MB/格式/秒数）
 * 这些直接决定"这个模型能传什么、能调什么"，所以一个都不能丢。
 */
function normalizeParams(params) {
  if (!Array.isArray(params)) return [];
  const out = [];
  for (const p of params) {
    if (!p || typeof p !== 'object') continue;
    const name = str(p.name, 40);
    if (!name) continue;
    const type = str(p.type || 'text', 16).toLowerCase();
    const opts = Array.isArray(p.options) ? p.options.map(o => {
      if (o && typeof o === 'object') return { value: String(o.value), label: str(o.label || o.value, 40) };
      return { value: String(o), label: String(o) };
    }) : [];
    out.push({
      name,
      label: str(p.label || name, 40),
      type,
      required: !!p.required,
      options: opts,
      min: p.min === undefined ? null : num(p.min, null),
      max: p.max === undefined ? null : num(p.max, null),
      desc: str(p.description || '', 400),
      when: p.available_when && typeof p.available_when === 'object' ? p.available_when : null,
      modes: Array.isArray(p.applies_to_mode) ? p.applies_to_mode.map(x => String(x)) : [],
      constraints: Array.isArray(p.constraints) ? p.constraints.map(x => str(x, 300)).slice(0, 4) : [],
      role: str(p.upload_role || '', 20),
      limits: normalizeLimits(p.upload_limits)
    });
  }
  return out;
}

/** 上传限制：平台中文字段 → 统一结构（只留界面用得上的） */
function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fmts = Array.isArray(raw['格式']) ? raw['格式'].map(x => String(x).toLowerCase().replace(/^\./, '')) : [];
  const ratio = Array.isArray(raw['宽高比区间']) ? raw['宽高比区间'].map(x => num(x, 0)).filter(Boolean) : [];
  const out = {
    maxMB: num(raw['单文件MB'], 0) || 0,
    formats: fmts.slice(0, 12),
    minSide: num(raw['最小边'], 0) || 0,
    ratio: ratio.length === 2 ? ratio : [],
    maxSeconds: num(raw['最长秒'], 0) || 0,
    totalSeconds: num(raw['总秒'], 0) || 0,
    maxPixels: Array.isArray(raw['像素区间']) ? num(raw['像素区间'][1], 0) : 0
  };
  if (!out.maxMB && !out.formats.length && !out.maxSeconds) return null;
  return out;
}

/* ================= 参数 → 表单控件（每个模型的输入能力都不同） =================
 * 平台 192 个模型加起来有 700+ 个参数：图片模型能传参考图、比例、分辨率、画质；
 * 视频模型有生成模式、时长、首尾帧、参考视频/音频；语音模型有音色、语速、情绪。
 * 这里把参数定义翻译成"界面该画什么"，渲染端只管画，不再自己猜。
 */
const CHOICE_TYPES = ['select', 'radio', 'segment'];
const MULTI_UPLOAD_NAMES = ['images', 'videos', 'clips', 'files', 'attachments', 'reference_urls', 'image_urls', 'video_urls', 'audios', 'ref_images'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];

function widgetOf(type) {
  if (CHOICE_TYPES.includes(type)) return 'choice';
  if (type === 'upload') return 'upload';
  if (type === 'switch') return 'switch';
  if (type === 'number') return 'number';
  if (type === 'textarea') return 'longtext';
  return 'text';
}

/** 这个上传参数要的是图片 / 视频 / 音频（先看平台给的文件格式，再看参数名） */
function uploadKindOf(p) {
  const fmts = (p && p.limits && p.limits.formats) || [];
  if (fmts.length) {
    if (fmts.some(f => VIDEO_EXT.includes(f))) return 'video';
    if (fmts.some(f => AUDIO_EXT.includes(f))) return 'audio';
    if (fmts.some(f => IMAGE_EXT.includes(f))) return 'image';
  }
  const s = ((p && p.name) || '') + ' ' + ((p && p.label) || '') + ' ' + ((p && p.role) || '');
  if (/video|clip|movie|影片|视频/i.test(s)) return 'video';
  if (/audio|sound|voice|music|音频|声音|音乐/i.test(s)) return 'audio';
  if (/image|img|photo|frame|picture|图/i.test(s)) return 'image';
  return 'file';
}

function uploadMultipleOf(p) {
  const name = String((p && p.name) || '');
  if (MULTI_UPLOAD_NAMES.includes(name)) return true;
  const d = String((p && p.desc) || '');
  // "0~9 张" "1~16 张" 这类描述说明是多张
  if (/\d+\s*[~～-]\s*\d+\s*张/.test(d)) return true;
  return false;
}

/** 从描述里抠出张数上限：0~9 张 / 最多 8 张 */
function uploadMaxCountOf(p) {
  const d = String((p && p.desc) || '');
  const range = d.match(/(\d+)\s*[~～-]\s*(\d+)\s*张/);
  if (range) return Math.max(0, parseInt(range[2], 10) || 0);
  const most = d.match(/最多\s*(\d+)\s*张/);
  if (most) return parseInt(most[1], 10) || 0;
  return 0;
}

/** 单位：时长类参数补上"秒"，宽度/张数同理 */
function unitOf(p) {
  const s = String((p && p.label) || '') + ' ' + String((p && p.name) || '');
  if (/秒|second|duration/i.test(s)) return '秒';
  if (/张/.test(s)) return '张';
  if (/像素|px/i.test(s)) return 'px';
  return '';
}

/** 参数 → 字段（带控件类型、上传种类、显隐条件），渲染端直接用 */
function fieldOf(p) {
  const widget = widgetOf(p.type);
  const f = {
    name: p.name,
    label: p.label,
    type: p.type,
    widget,
    required: !!p.required,
    options: p.options || [],
    min: p.min,
    max: p.max,
    unit: unitOf(p),
    desc: p.desc || '',
    when: p.when || null,
    modes: p.modes || [],
    constraints: p.constraints || [],
    role: p.role || ''
  };
  if (widget === 'upload') {
    f.upload = {
      kind: uploadKindOf(p),
      multiple: uploadMultipleOf(p),
      maxCount: uploadMaxCountOf(p),
      maxMB: (p.limits && p.limits.maxMB) || 0,
      formats: (p.limits && p.limits.formats) || [],
      maxSeconds: (p.limits && p.limits.maxSeconds) || 0,
      minSide: (p.limits && p.limits.minSide) || 0
    };
  }
  return f;
}

/** 全部字段（prompt 走单独输入框，不重复出现在参数区） */
function fieldsOf(params) {
  const list = Array.isArray(params) ? params : [];
  return list.filter(p => p && p.name !== 'prompt').map(fieldOf);
}

function hasValue(v) {
  if (Array.isArray(v)) return v.filter(x => String(x == null ? '' : x).trim()).length > 0;
  return v !== undefined && v !== null && String(v).trim() !== '';
}
function countRefs(v) {
  if (Array.isArray(v)) return v.filter(x => String(x == null ? '' : x).trim()).length;
  return hasValue(v) ? 1 : 0;
}

/**
 * 显隐：平台的 available_when 形如 {mode:['cankaosheng']} 或 {需上传:['video_url']}。
 * 前者比当前模式，后者表示"填了某个素材才出现"。
 */
function isFieldVisible(field, values) {
  const v = values || {};
  const when = field && field.when;
  if (!when || typeof when !== 'object') return true;
  for (const k of Object.keys(when)) {
    const want = (Array.isArray(when[k]) ? when[k] : [when[k]]).map(String);
    if (k === '需上传') {
      if (!want.some(n => hasValue(v[n]))) return false;
      continue;
    }
    if (!want.includes(String(v[k] === undefined || v[k] === null ? '' : v[k]))) return false;
  }
  return true;
}

function visibleFields(fields, values) {
  return (Array.isArray(fields) ? fields : []).filter(f => isFieldVisible(f, values));
}

/** 只保留当前可见字段的值（切换模式后，另一模式的素材不会误发上去） */
function activeValues(fields, values) {
  const out = {};
  for (const f of visibleFields(fields, values)) {
    const v = values ? values[f.name] : undefined;
    if (hasValue(v)) out[f.name] = v;
  }
  return out;
}

/** 按四类分组（画布和模型库都按这个顺序展示） */
function group(models) {
  const g = { chat: [], image: [], video: [], audio: [] };
  const list = Array.isArray(models) ? models : [];
  for (const m of list) {
    const t = ALL_TYPES.includes(m.type) ? m.type : inferType(m.name);
    if (!g[t]) g[t] = [];
    g[t].push(m);
  }
  return g;
}

function counts(models) {
  const g = group(models);
  return { chat: g.chat.length, image: g.image.length, video: g.video.length, audio: g.audio.length, total: (Array.isArray(models) ? models.length : 0) };
}

function byType(models, type) {
  return group(models)[type] || [];
}

function findModel(models, name) {
  const list = Array.isArray(models) ? models : [];
  return list.find(m => m.name === name) || null;
}

/**
 * 默认参数：平台不会替我们填默认值，所以必填项要预选。
 *  - 必填的选项类：优先"推荐/默认"，其次"自适应 auto"，再退第一个
 *  - 生成模式（mode）：即使非必填也预选第一个 —— 它决定下面出现哪些素材框
 *  - 数字：有下限取下限
 * 可选项一律留空 = 不传，由平台走自己的默认（避免我们乱设参数）
 */
function recommendedOption(p) {
  const opts = (p && p.options) || [];
  if (!opts.length) return null;
  return opts.find(o => /推荐|默认/.test(o.label)) ||
    opts.find(o => String(o.value).toLowerCase() === 'auto') ||
    opts[0];
}

function defaultsFor(params) {
  const out = {};
  for (const p of (Array.isArray(params) ? params : [])) {
    if (!p || p.name === 'prompt') continue;
    if (CHOICE_TYPES.includes(p.type) && p.options.length) {
      if (!(p.required || p.name === 'mode')) continue;
      const o = recommendedOption(p);
      if (o) out[p.name] = o.value;
    } else if (p.type === 'switch') {
      if (p.required) out[p.name] = 'false';
    } else if (p.type === 'number' && p.required && p.min !== null) {
      out[p.name] = String(p.min);
    }
  }
  return out;
}

/** 从平台描述里抠一句"这个参数能干什么"，给界面做小字提示 */
function shortDesc(f, n) {
  const t = String((f && f.desc) || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const cut = n || 96;
  return t.length > cut ? t.slice(0, cut) + '…' : t;
}

/**
 * 提交前校验：必填项缺了就说清楚"缺哪个、怎么填"。
 * 返回 [{name,label,reason}]，空数组 = 能跑。
 */
function validateFields(fields, values) {
  const v = values || {};
  const errs = [];
  for (const f of visibleFields(fields, v)) {
    const val = v[f.name];
    const has = f.widget === 'upload' ? countRefs(val) > 0 : hasValue(val);
    if (!has) {
      if (!f.required) continue;
      errs.push({
        name: f.name,
        label: f.label,
        reason: f.widget === 'upload'
          ? '「' + f.label + '」必填：点「＋ ' + (f.upload.kind === 'audio' ? '选音频' : f.upload.kind === 'video' ? '选视频' : f.upload.kind === 'image' ? '选图片' : '选文件') + '」上传素材'
          : '「' + f.label + '」必填' + (f.widget === 'choice' && f.options.length ? '：选一个' : '')
      });
      continue;
    }
    if (f.widget === 'upload') {
      const max = f.upload && f.upload.maxCount;
      if (max && countRefs(val) > max) {
        errs.push({ name: f.name, label: f.label, reason: '「' + f.label + '」最多 ' + max + ' 个' });
      }
      continue;
    }
    if (f.widget === 'number') {
      if (!Number.isFinite(Number(val))) {
        errs.push({ name: f.name, label: f.label, reason: '「' + f.label + '」要填数字' });
        continue;
      }
      if (f.min !== null && f.min !== undefined && Number(val) < f.min) {
        errs.push({ name: f.name, label: f.label, reason: '「' + f.label + '」不能小于 ' + f.min });
      }
      if (f.max !== null && f.max !== undefined && Number(val) > f.max) {
        errs.push({ name: f.name, label: f.label, reason: '「' + f.label + '」不能大于 ' + f.max });
      }
    }
  }
  return errs;
}

/** 节点卡片上的一行摘要：16:9 · 8秒 · 720p · 图 2 张 */
function paramSummary(fields, values, max) {
  const v = values || {};
  const out = [];
  for (const f of visibleFields(fields, v)) {
    const val = v[f.name];
    if (!hasValue(val)) continue;
    if (f.widget === 'upload') {
      out.push(f.label + ' ' + countRefs(val) + (f.upload && f.upload.kind === 'image' ? ' 张' : ' 个'));
    } else if (f.widget === 'choice') {
      const o = (f.options || []).find(x => String(x.value) === String(val));
      out.push(o ? o.label : String(val));
    } else if (f.widget === 'switch') {
      if (String(val) === 'true') out.push(f.label);
    } else if (f.widget === 'number') {
      out.push(f.label.replace(/[（(].*?[)）]/g, '') + ' ' + val + (f.unit || ''));
    } else {
      const s = String(val).replace(/\s+/g, ' ');
      out.push(f.label + ' ' + (s.length > 12 ? s.slice(0, 12) + '…' : s));
    }
  }
  const lim = max || 4;
  return out.length > lim ? out.slice(0, lim).join(' · ') + ' …' : out.join(' · ');
}

/** 模型能力徽标：让用户一眼看出"这个模型能传图 / 能选比例 / 能选秒数" */
function capabilities(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const out = [];
  for (const f of list) {
    if (f.widget === 'upload') {
      const k = f.upload.kind;
      const name = k === 'image' ? '可传图片' : k === 'video' ? '可传视频' : k === 'audio' ? '可传音频' : '可传文件';
      const n = f.upload.maxCount;
      out.push(name + (n ? (f.upload.multiple ? ' 0~' + n + ' 个' : ' 1 个') : ''));
      continue;
    }
    if (/^(aspect_ratio|aspectRatio|ratio|ratio_type|size_ratio)$/i.test(f.name)) {
      if (f.options.length) out.push('比例 ' + f.options.length + ' 档');
      continue;
    }
    if (/^(duration|seconds|video_duration|length)$/i.test(f.name)) {
      if (f.options.length > 1) {
        const first = f.options[0].value, last = f.options[f.options.length - 1].value;
        out.push('时长 ' + first + '~' + last + ' 秒');
      } else out.push('可设时长');
      continue;
    }
    if (/^(resolution|quality|imageSize|image_size|size_quality)$/i.test(f.name)) {
      if (f.options.length) out.push('清晰度 ' + f.options.length + ' 档');
      continue;
    }
    if (f.name === 'lyrics') out.push('可填歌词');
    if (f.name === 'web_search') out.push('可联网');
    if (/^voice_id$/i.test(f.name)) out.push('可选音色');
  }
  const uniq = [...new Set(out)];
  return uniq.slice(0, 6);
}

/** 只保留填了的参数；空字符串/空数组直接丢掉（平台不会替我们补默认） */
function cleanParams(params) {
  const out = {};
  const src = params && typeof params === 'object' ? params : {};
  for (const k of Object.keys(src)) {
    if (!/^[A-Za-z0-9_\-.]{1,40}$/.test(k)) continue;
    if (k === 'prompt') continue;              // prompt 走顶层
    let v = src[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      v = v.trim();
      if (!v) continue;
    }
    if (Array.isArray(v)) {
      v = v.map(x => (typeof x === 'string' ? x.trim() : x)).filter(x => x !== '' && x !== null && x !== undefined);
      if (!v.length) continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 组装 /v1/media/generate 请求体。
 * 传了 fields（模型的参数定义）时：
 *   - 只发"当前模式可见"的参数（首尾帧/参考生两套素材不会混着发）
 *   - 数字参数转成数字，多图参数一律数组
 */
function buildGenerateBody(model, prompt, params, fields) {
  const body = { model: str(model, 120) };
  const p = str(prompt, 4000);
  if (p) body.prompt = p;
  const hasSchema = Array.isArray(fields) && fields.length > 0;
  const src = hasSchema ? activeValues(fields, params) : (params || {});
  const cp = cleanParams(src);
  if (hasSchema) {
    for (const f of fields) {
      if (!(f.name in cp)) continue;
      const v = cp[f.name];
      if (f.widget === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) cp[f.name] = n;
      } else if (f.widget === 'upload' && f.upload) {
        if (f.upload.multiple) {
          // 老节点可能把多个直链粘成一个字符串（换行/逗号分开），拆成数组
          let arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\r?\n|,\s*(?=https?:\/\/|data:)/) : [v]);
          cp[f.name] = arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        } else {
          cp[f.name] = Array.isArray(v) ? v[0] : v;
        }
      }
    }
  }
  if (Object.keys(cp).length) body.params = cp;
  return body;
}

/** 提交返回：只认 data.task_id（平台说中文旧字段要下线） */
function parseSubmit(payload) {
  const j = payload || {};
  const d = j.data && typeof j.data === 'object' ? j.data : j;
  const id = d.task_id || d.taskId || (Array.isArray(d.task_ids) && d.task_ids[0]) ||
    (Array.isArray(d['任务ids']) && d['任务ids'][0]) || 0;
  const taskId = Number(id) || 0;
  if (taskId) return { ok: true, taskId };
  const msg = (j.error && (j.error.message || j.error.code)) || j.msg || j.message || '平台没有返回任务 ID';
  return { ok: false, error: String(msg), raw: j };
}

/** 进度：'10' / '100%' / 10 → 0~100 */
function parseProgress(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

const DONE_STATES = ['success', 'succeed', 'succeeded', 'completed', 'complete', 'done', 'finished', 'ok'];
const FAIL_STATES = ['failed', 'fail', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'];

/** 任务状态：把平台的字段收敛成"跑没跑完 / 成没成 / 出了什么" */
function parseStatus(payload) {
  const j = payload && payload.data && typeof payload.data === 'object' && !payload.state ? payload.data : (payload || {});
  const state = str(j.state || '', 20).toLowerCase();
  const err = str(j.error || j.fail_reason || j.message || '', 300);
  const urls = [];
  if (Array.isArray(j.result_urls)) for (const u of j.result_urls) if (u) urls.push(String(u));
  if (!urls.length && j.result_url) urls.push(String(j.result_url));
  if (!urls.length && Array.isArray(j.urls)) for (const u of j.urls) if (u) urls.push(String(u));
  const finalFlag = j.is_final === true || j.is_final === 1 || j.is_final === 'true';
  const failed = !!err || FAIL_STATES.includes(state) || str(j.status_group || '').includes('失败');
  const success = DONE_STATES.includes(state) || (finalFlag && !failed && urls.length > 0);
  const done = failed || success || finalFlag;
  return {
    taskId: Number(j.task_id || j.taskId || 0) || 0,
    state,
    statusText: str(j.status || j.status_text || (failed ? '失败' : (success ? '完成' : '进行中')), 40),
    statusGroup: str(j.status_group || '', 20),
    progress: parseProgress(j.progress),
    running: !done,
    done,
    ok: success && !failed,
    failed,
    urls,
    url: urls[0] || '',
    resultType: str(j.result_type || '', 20),
    cost: num(j.cost, 0),
    error: err,
    duration: num(j.duration_seconds, 0),
    model: str(j.model || '', 120)
  };
}

/** 生成节点默认模型：优先同名/带"按次"的便宜版，其次第一个 */
function pickDefault(models, type) {
  const list = byType(models, type);
  if (!list.length) return null;
  const prefer = list.find(m => m.available && !/token|官转|按秒/i.test(m.displayName + m.name));
  return prefer || list.find(m => m.available) || list[0];
}

/** 节点标题：让用户一眼知道这是干什么的节点 */
function nodeTitle(model) {
  const meta = TYPE_META[(model && model.type) || 'image'] || TYPE_META.image;
  return meta.name + '生成';
}

/** 结果说明：给节点备注/日志用的一句话 */
function summarize(model, st) {
  const m = str(model, 60) || '模型';
  if (!st) return m;
  if (st.failed) return m + ' 失败：' + (st.error || '未知原因');
  if (st.ok) return m + ' 生成完成 · ' + (st.urls.length || 0) + ' 个结果' + (st.cost ? ' · 花费 ' + formatCost(st.cost) : '');
  return m + ' 进行中 ' + st.progress + '%';
}

function formatCost(n) {
  const v = num(n, 0);
  if (!v) return '';
  if (v < 0.01) return '¥' + v.toFixed(4);
  if (v < 1) return '¥' + v.toFixed(3);
  return '¥' + v.toFixed(2);
}

/** 结果类型 → 展示方式 */
function resultKind(st, modal) {
  const t = (st && st.resultType || '').toLowerCase();
  if (['image', 'images', 'img', 'picture'].includes(t)) return 'image';
  if (['video', 'videos', 'mp4'].includes(t)) return 'video';
  if (['audio', 'music', 'voice', 'mp3', 'wav'].includes(t)) return 'audio';
  if (modal && MEDIA_TYPES.includes(modal)) return modal === 'audio' ? 'audio' : modal;
  const u = (st && st.url) || '';
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) return 'image';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(u)) return 'video';
  if (/\.(mp3|wav|m4a|ogg|flac)(\?|$)/i.test(u)) return 'audio';
  return modal === 'audio' ? 'audio' : (modal || 'image');
}

/** 画布节点 → /v1/media/generate 需要的全部东西（顺便校验）
 * schema 是平台给这个模型的 params；有它就按"必填 + 当前模式"精确校验，
 * 没填的必填项会直接告诉用户是哪个框（比如「参考图片」）。
 */
function prepareRun(node, cfg, upstreamText, schema) {
  const ref = (node && node.ref) || {};
  const modal = MEDIA_TYPES.includes(ref.modal) ? ref.modal : 'image';
  const model = str(ref.model, 120);
  if (!model) return { ok: false, error: '这个节点还没选模型' };
  if (!cfg || !String(cfg.apiKey || '').trim()) return { ok: false, error: '还没接算力：去「应用功能 → ⚡ 模型设置」填密钥' };
  const own = str(ref.prompt, 3000);
  const up = str(upstreamText, 1500);
  const prompt = (own + (up ? (own ? '\n\n' : '') + '【上游上下文】\n' + up : '')).slice(0, 4000);
  const fields = Array.isArray(schema) ? fieldsOf(schema) : [];
  if (fields.length) {
    const errs = validateFields(fields, ref.params || {});
    if (errs.length) return { ok: false, error: errs[0].reason, fieldErrors: errs };
  }
  if (!prompt) return { ok: false, error: '写一句提示词再跑（或连一个上游节点给它素材）' };
  return {
    ok: true, modal, model, prompt, fields,
    params: fields.length ? activeValues(fields, ref.params || {}) : (ref.params || {}),
    body: buildGenerateBody(model, prompt, ref.params || {}, fields)
  };
}

module.exports = {
  MEDIA_TYPES, ALL_TYPES, TYPE_META, CHOICE_TYPES,
  inferType, normalizeCatalog, normalizeParams, normalizeLimits, group, counts, byType, findModel,
  widgetOf, uploadKindOf, uploadMultipleOf, uploadMaxCountOf, unitOf, fieldOf, fieldsOf,
  hasValue, countRefs, isFieldVisible, visibleFields, activeValues,
  recommendedOption, shortDesc, validateFields, paramSummary, capabilities,
  defaultsFor, cleanParams, buildGenerateBody, parseSubmit, parseProgress, parseStatus,
  pickDefault, nodeTitle, summarize, formatCost, resultKind, prepareRun
};
