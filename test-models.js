/**
 * models.js 单测：模型目录整形 + 媒体任务请求/状态解析
 * 跑法：node test-models.js
 */
const m = require('./models');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

console.log('\n== 类型识别（认不出名字时靠前缀兜底） ==');
t('suno-v6 → 音乐', m.inferType('suno-v6') === 'audio');
t('kling-v3-video → 视频', m.inferType('kling-v3-video') === 'video');
t('seedance-2.0 → 视频', m.inferType('seedance-2.0-anci') === 'video');
t('tt-image-2.5 → 图片', m.inferType('tt-image-2.5') === 'image');
t('gem-3.8-flash → 文本', m.inferType('gem-3.8-flash') === 'chat');
t('speech-2.8 → 音乐/语音', m.inferType('speech-2.8') === 'audio');

console.log('\n== 目录整形 ==');
const raw = {
  models: [
    { name: 'gem-3.8-flash', display_name: 'GEM 3.8 flash', type: 'chat', tags: ['对话'], description: '轻量', input_hint: '' },
    {
      name: 'tt-image-2.5', display_name: 'TT Image 2.5', type: 'image', tags: ['文生图'],
      description: '图像模型', input_hint: '主体+场景',
      params: [
        { name: 'prompt', label: '提示词', type: 'textarea', required: true },
        { name: 'version', label: '模型版本', type: 'select', required: true, options: [{ value: 'flare', label: '标准版' }, { value: 'sunburst', label: '增强版' }] },
        { name: 'aspect_ratio', label: '比例', type: 'select', required: false, options: [{ value: '1:1', label: '1:1' }] }
      ]
    },
    { name: 'suno-v6', display_name: 'Suno 6', type: 'audio', tags: ['音乐生成'] },
    { name: 'kling-v3-video', display_name: 'Kling', type: 'video' },
    { name: 'tt-image-2.5', display_name: '重复的', type: 'image' }
  ]
};
const list = m.normalizeCatalog(raw);
t('去重后 4 个', list.length === 4, String(list.length));
t('保留展示名/标签', list.find(x => x.name === 'tt-image-2.5').displayName === 'TT Image 2.5' && list[1].tags[0] === '文生图');
t('参数被规整', list.find(x => x.name === 'tt-image-2.5').params.length === 3);
t('参数选项带 value/label', m.normalizeParams(raw.models[1].params)[1].options[0].label === '标准版');

const g = m.group(list);
t('四类分组计数', g.chat.length === 1 && g.image.length === 1 && g.video.length === 1 && g.audio.length === 1);
const c = m.counts(list);
t('counts.total', c.total === 4 && c.audio === 1);
t('缺类型时按名字兜底', m.normalizeCatalog([{ name: 'seedream-4' }])[0].type === 'image');

console.log('\n== 参数默认值与清洗 ==');
const params = m.normalizeParams(raw.models[1].params);
const dft = m.defaultsFor(params);
t('必填 select 预填第一个', dft.version === 'flare');
t('非必填不预填', dft.aspect_ratio === undefined);
t('prompt 不进 params', dft.prompt === undefined);

const cleaned = m.cleanParams({ version: 'flare', aspect_ratio: '', duration: '  ', prompt: 'x', list: [], ok: ['a'] });
t('空值/空数组/prompt 被丢掉', Object.keys(cleaned).join(',') === 'version,ok', JSON.stringify(cleaned));

console.log('\n== 请求体 ==');
const body = m.buildGenerateBody('tt-image-2.5', ' 一只猫 ', { version: 'flare', aspect_ratio: '' });
t('model + prompt + params', body.model === 'tt-image-2.5' && body.prompt === '一只猫' && body.params.version === 'flare', JSON.stringify(body));
t('没有参数就不带 params 键', m.buildGenerateBody('x', 'p', {}).params === undefined);
const song = m.buildGenerateBody('suno-v6', '轻快民谣', { lyrics: '啦啦啦', make_instrumental: 'instrumental' });
t('音乐参数原样带上', song.params.lyrics === '啦啦啦');

console.log('\n== 提交返回 ==');
t('data.task_id', m.parseSubmit({ code: 200, data: { task_id: 208877408 } }).taskId === 208877408);
t('中文兼容字段', m.parseSubmit({ data: { '任务ids': [123] } }).taskId === 123);
t('没有 id 报错', m.parseSubmit({ msg: '余额不足' }).ok === false);
t('错误信息可读', /余额不足/.test(m.parseSubmit({ msg: '余额不足' }).error));

console.log('\n== 任务状态 ==');
const running = m.parseStatus({ task_id: 1, state: 'running', status: '处理中', progress: '10', result_urls: [], cost: 0.4, is_final: false });
t('进行中', running.running === true && running.done === false && running.progress === 10);
const okImg = m.parseStatus({ task_id: 2, state: 'success', status: '生成完成', progress: '100%', result_url: 'https://x/a.png', result_type: 'image', cost: 0.0087, is_final: true });
t('成功 + 结果地址', okImg.ok && okImg.done && okImg.url === 'https://x/a.png');
t('进度百分号解析', okImg.progress === 100);
t('多结果地址', m.parseStatus({ state: 'success', result_urls: ['a.mp4', 'b.mp4'], is_final: true }).urls.length === 2);
const bad = m.parseStatus({ task_id: 3, state: 'failed', error: '内容违规', is_final: true });
t('失败带原因', bad.failed && /内容违规/.test(bad.error) && bad.ok === false);
t('is_final 但没地址不算成功', m.parseStatus({ state: '', is_final: true, error: '' }).ok === false);
t('结果类型图片', m.resultKind(okImg, 'image') === 'image');
t('按扩展名判断视频', m.resultKind({ url: 'https://x/v.mp4', resultType: '' }, 'video') === 'video');
t('音乐给播放器', m.resultKind({ url: 'https://x/a.mp3' }, 'audio') === 'audio');

console.log('\n== 默认模型挑选 ==');
const imgs = [
  { name: 'tt-image-2.5-token', displayName: 'TT Image 2.5 官转', type: 'image', available: true },
  { name: 'tt-image-2.5', displayName: 'TT Image 2.5', type: 'image', available: true },
  { name: 'mj_imagine', displayName: 'MJ', type: 'image', available: false }
];
t('避开 token/官转', m.pickDefault(imgs, 'image').name === 'tt-image-2.5');
t('没有可用时也返回一个', !!m.pickDefault([{ name: 'x', type: 'image', available: false }], 'image'));
t('空列表返回 null', m.pickDefault([], 'image') === null);

console.log('\n== 运行前校验 ==');
const node = { ref: { modal: 'image', model: '', prompt: 'a cat' } };
t('没选模型报错', m.prepareRun(node, { apiKey: 'sk-1' }).ok === false);
t('没密钥报错', /密钥/.test(m.prepareRun({ ref: { model: 'm', prompt: 'x' } }, {}).error));
t('没提示词报错', /提示词/.test(m.prepareRun({ ref: { modal: 'image', model: 'm', prompt: '' } }, { apiKey: 'sk-1' }).error));
const prep = m.prepareRun({ ref: { modal: 'image', model: 'tt-image-2.5', prompt: 'a cat', params: { version: 'flare' } } }, { apiKey: 'sk-1' });
t('正常组装', prep.ok && prep.body.model === 'tt-image-2.5' && prep.body.params.version === 'flare' && prep.modal === 'image');
t('上游内容会拼进提示词', /【上游上下文】/.test(m.prepareRun({ ref: { modal: 'image', model: 'm', prompt: 'a' } }, { apiKey: 'k' }, '上游说的').body.prompt));

console.log('\n== 每个模型自己的输入项（素材/比例/秒数/质量） ==');
const videoParams = m.normalizeParams([
  { name: 'prompt', label: '提示词', type: 'textarea', required: true },
  { name: 'mode', label: '生成模式', type: 'segment', required: false, options: [{ value: 'shouweizhen', label: '首尾帧' }, { value: 'cankaosheng', label: '参考生' }] },
  { name: 'duration', label: '视频时长', type: 'select', required: true, options: [{ value: '4', label: '4秒' }, { value: '8', label: '8秒' }, { value: '15', label: '15秒' }] },
  {
    name: 'images', label: '首尾帧', type: 'upload', required: false,
    description: '上传 1~2 张图作为首帧 / 尾帧', available_when: { mode: ['shouweizhen'] },
    upload_limits: { 单文件MB: 30, 格式: ['jpg', 'png'], 最小边: 300 }
  },
  {
    name: 'video_url', label: '参考视频', type: 'upload', required: true,
    description: '参考视频，最多 1 个', available_when: { mode: ['cankaosheng'] },
    upload_limits: { 单文件MB: 200, 格式: ['mp4', 'mov'], 最长秒: 30 }
  },
  { name: 'aspect_ratio', label: '宽高比', type: 'radio', required: false, options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
  { name: 'seed', label: '随机种子', type: 'number', required: false, min: 1, max: 9999 }
]);
const vf = m.fieldsOf(videoParams);
t('prompt 不进参数区', vf.every(f => f.name !== 'prompt') && vf.length === 6, String(vf.length));
t('上传参数识别成图片', vf.find(f => f.name === 'images').upload.kind === 'image');
t('按格式识别视频（不信参数名）', vf.find(f => f.name === 'video_url').upload.kind === 'video');
t('多图 + 张数上限', vf.find(f => f.name === 'images').upload.multiple === true && vf.find(f => f.name === 'images').upload.maxCount === 2);
t('上传限制带上 MB/格式', vf.find(f => f.name === 'video_url').upload.maxMB === 200 && vf.find(f => f.name === 'video_url').upload.formats[0] === 'mp4');
t('seconds 单位', vf.find(f => f.name === 'duration').unit === '秒');

const vdef = m.defaultsFor(videoParams);
t('生成模式预选第一个（决定出现哪些素材框）', vdef.mode === 'shouweizhen');
t('必填时长预选第一项', vdef.duration === '4');
t('非必填比例不预填', vdef.aspect_ratio === undefined);

const v1 = { mode: 'shouweizhen', duration: '8', seed: '42' };
t('首尾帧模式：出现图片、隐藏参考视频', m.visibleFields(vf, v1).some(f => f.name === 'images') && !m.visibleFields(vf, v1).some(f => f.name === 'video_url'));
const v2 = { mode: 'cankaosheng', duration: '8', video_url: ['https://x/a.mp4'] };
t('参考生模式：出现参考视频、隐藏首尾帧', m.visibleFields(vf, v2).some(f => f.name === 'video_url') && !m.visibleFields(vf, v2).some(f => f.name === 'images'));
t('切换模式后旧素材不会误发', m.activeValues(vf, { mode: 'cankaosheng', video_url: ['u'], images: ['old.png'] }).images === undefined);

const errs = m.validateFields(vf, { mode: 'cankaosheng', duration: '8' });
t('必填素材缺了说清楚是哪个', errs.length === 1 && /参考视频/.test(errs[0].reason), JSON.stringify(errs));
t('同一套参数换模式就不报错', m.validateFields(vf, { mode: 'shouweizhen', duration: '8' }).length === 0);
t('数字越界能拦住', m.validateFields(vf, { mode: 'shouweizhen', duration: '8', seed: '99999' }).some(e => /不能大于/.test(e.reason)));

const vidBody = m.buildGenerateBody('sd-2.5', '一只猫', { mode: 'shouweizhen', duration: '8', seed: '42', images: 'https://x/a.png' }, vf);
t('只发当前模式可见的参数', vidBody.params.images[0] === 'https://x/a.png' && !vidBody.params.video_url, JSON.stringify(vidBody.params));
t('数字参数转成数字', vidBody.params.seed === 42);
t('单图也写成数组（平台要求）', Array.isArray(vidBody.params.images));
t('参数摘要能贴到节点卡片', /首尾帧/.test(m.paramSummary(vf, { mode: 'shouweizhen', duration: '8', images: ['a'] })));
const caps = m.capabilities(vf);
t('能力徽标：能传图/比例/时长', caps.some(x => /可传图片/.test(x)) && caps.some(x => /比例/.test(x)) && caps.some(x => /时长/.test(x)), JSON.stringify(caps));

console.log('\n== 展示 ==');
t('花费格式化', m.formatCost(0.0087) === '¥0.0087' && m.formatCost(1.5) === '¥1.50' && m.formatCost(0) === '');
t('一句话总结成功', /生成完成/.test(m.summarize('Suno', okImg)));
t('一句话总结失败', /失败/.test(m.summarize('Suno', bad)));
t('节点默认标题', m.nodeTitle({ type: 'video' }) === '视频生成');

console.log('\n' + (fail === 0 ? 'ALL PASS（' + pass + ' 项）' : 'FAILED ' + fail + ' / ' + (pass + fail)));
process.exit(fail === 0 ? 0 : 1);
