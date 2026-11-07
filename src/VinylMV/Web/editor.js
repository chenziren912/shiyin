'use strict';
const $ = id => document.getElementById(id);
const native = window.chrome.webview, pending = new Map();
let serial = 0, data, layout, selected = 'record', seconds = 0, undo = [], redo = [], drag = null, levels = new Float64Array(48), audioRevision = 0, audioTimer, lyricKey = '';
const measure = document.createElement('canvas').getContext('2d');
function rpc(action, payload = {}) { return new Promise((resolve, reject) => { const id = String(++serial); pending.set(id, { resolve, reject }); native.postMessage({ id, action, payload }); }); }
native.addEventListener('message', ({ data }) => { const task = pending.get(data.id); if (!task) return; pending.delete(data.id); if (data.ok) task.resolve(data.data); else task.reject(Object.assign(new Error(data.error), { cancelled: data.cancelled })); });
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500); }
function attempt(fn) { return async event => { try { await fn(event); } catch (error) { if (!error.cancelled) toast(error.message); } }; }
function card(id = selected) { return Composition.get(layout, id); }
function pack() { return JSON.stringify({ layout, lyrics: data.lyrics, cover: data.cover, volume: data.volume }); }
function checkpoint(before) { if (before !== pack()) { undo.push(before); if (undo.length > 80) undo.shift(); redo = []; } updateHistory(); }
function restore(value) { const saved = JSON.parse(value); layout = saved.layout; Object.assign(data, { lyrics: saved.lyrics, cover: saved.cover, volume: saved.volume }); lyricKey = ''; paint(); buildList(); buildGeometry(); if ($('cardDialog').open) buildProperties(); scheduleAudio(); }
function updateHistory() { $('undo').disabled = !undo.length; $('redo').disabled = !redo.length; }
function change(fn) { const before = pack(); fn(); layout = Composition.normalize(layout); paint(); buildList(); buildGeometry(); checkpoint(before); scheduleAudio(); }
function select(id) { selected = id; paintOverlays(); for (const row of $('cardList').children) row.classList.toggle('selected', row.dataset.card === id); buildGeometry(); }

function parseLrc(text) {
  const groups = new Map(), offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000 + (Number(data.offset) || 0);
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const words = raw.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    for (const stamp of stamps) {
      if (+stamp[2] >= 60) continue;
      const time = Math.round(Math.max(0, +stamp[1] * 60 + +stamp[2] + +(stamp[3] || 0) / 10 ** (stamp[3]?.length || 1) + offset) * 1000) / 1000;
      if (!groups.has(time)) groups.set(time, []); if (!groups.get(time).includes(words)) groups.get(time).push(words);
    }
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([time, words]) => ({ time, text: words.join('\n') }));
}
function paintLyrics() {
  const lyrics = card('lyrics'), spacing = Composition.spacing(lyrics), lines = parseLrc(data.lyrics || '');
  const key = JSON.stringify([data.lyrics, lyrics.fontSize, lyrics.width, lyrics.height, lyrics.lineSpacing, lyrics.align]);
  if (key !== lyricKey) {
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const fitted = LyricLayout.fitLyric(line.text, lyrics.fontSize, lyrics.width * 1920, spacing * .94, (text, size) => { measure.font = `700 ${size}px "Microsoft YaHei"`; return measure.measureText(text).width; });
      const element = document.createElement('div'); element.className = 'lyric-line'; element.textContent = fitted.text; element.style.fontSize = `${fitted.fontSize / 19.2}cqw`; element.style.textAlign = lyrics.align; fragment.append(element);
    }
    $('lyricLines').replaceChildren(fragment); lyricKey = key;
  }
  let active = -1;
  for (let index = 0; index < lines.length && lines[index].time <= seconds; index++) active = index;
  const target = Math.max(0, active);
  $('lyricLines').style.transform = `translateY(calc(-${target} * var(--line-gap)))`;
  [...$('lyricLines').children].forEach((element, index) => { element.classList.toggle('active', index === active); element.classList.toggle('near', index !== active && Math.abs(index - target) <= 1); });
  $('lyricEmpty').hidden = lines.length > 0; $('lyricEmpty').textContent = '纯音乐 · 此刻只听旋律'; $('lyricLines').hidden = !lines.length;
}
function paint() {
  Composition.apply($('preview'), layout, data.audio || {});
  $('preview').style.setProperty('--brightness', (Number(data.brightness) || 0) / 100);
  $('recordLabel').style.backgroundImage = data.cover?.url ? `url("${data.cover.url.replace(/"/g, '%22')}")` : '';
  $('recordLabel').querySelector('.label-art').hidden = !!data.cover;
  $('vinyl').style.transform = `rotate(${seconds / card('record').spinSeconds * 360}deg)`;
  const duration = data.audio?.duration || 0;
  $('previewClock').textContent = Composition.formatTime(seconds, duration, card('clock').format);
  $('videoProgressFill').style.width = `${duration ? seconds / duration * 100 : 0}%`;
  const spectrum = card('spectrum');
  if (levels.length !== spectrum.bandCount) levels = new Float64Array(spectrum.bandCount);
  $('spectrumPath').setAttribute('d', AudioSpectrum.path(levels.map(value => Math.min(1, value * spectrum.gain)), spectrum.width * 1920, spectrum.height * 1080, spectrum));
  $('frameTime').textContent = Composition.formatTime(seconds, duration, 'elapsed'); $('frameDuration').textContent = Composition.formatTime(duration, duration, 'total');
  $('frameSeek').style.setProperty('--range-fill', `${duration ? seconds / duration * 100 : 0}%`);
  paintLyrics(); Composition.updateLyricColors($('preview'), layout, data.brightness); paintOverlays(); updateHistory();
}
function paintOverlays() {
  const root = $('cardOverlays');
  for (const c of layout.cards) {
    let box = root.querySelector(`[data-card="${c.id}"]`);
    if (!box) {
      box = document.createElement('div'); box.className = 'card-box'; box.dataset.card = c.id; box.tabIndex = 0; box.setAttribute('aria-label', `${Composition.names[c.type]}卡片`);
      const tag = document.createElement('span'); tag.className = 'card-tag'; tag.textContent = Composition.names[c.type];
      const handle = document.createElement('span'); handle.className = 'resize-handle'; handle.setAttribute('aria-label', '缩放卡片');
      box.append(tag, handle); root.append(box);
      box.addEventListener('pointerdown', startDrag);
      box.addEventListener('pointermove', moveDrag); box.addEventListener('pointerup', endDrag); box.addEventListener('pointercancel', endDrag);
      box.addEventListener('dblclick', () => { select(c.id); openProperties(); });
      box.addEventListener('focus', () => { if (selected !== c.id) select(c.id); });
    }
    Composition.rect(box, c); box.classList.toggle('selected', selected === c.id);
  }
}
function startDrag(event) {
  if (event.button !== 0) return;
  const box = event.currentTarget;
  select(box.dataset.card);
  drag = { before: pack(), original: { ...card() }, x: event.clientX, y: event.clientY, resize: event.target.classList.contains('resize-handle'), box };
  box.setPointerCapture(event.pointerId); event.preventDefault();
}
function moveDrag(event) {
  if (!drag) return;
  const bounds = $('preview').getBoundingClientRect(), dx = (event.clientX - drag.x) / bounds.width, dy = (event.clientY - drag.y) / bounds.height;
  const c = card(), original = drag.original;
  if (c.type === 'spectrum') c.linked = false;
  if (drag.resize) {
    c.width = Math.max(.03, original.width + (Math.abs(dx) < .001 && c.type === 'record' ? dy * 9 / 16 : dx));
    c.height = Math.max(.01, original.height + dy);
    if ('fontSize' in c) c.fontSize = original.fontSize * Math.sqrt(c.width / original.width * c.height / original.height);
  } else { c.x = original.x + dx; c.y = original.y + dy; }
  layout = Composition.normalize(layout); paint(); updateGeometryValues();
}
function endDrag(event) {
  if (!drag) return;
  const before = drag.before;
  if (drag.box.hasPointerCapture(event.pointerId)) drag.box.releasePointerCapture(event.pointerId);
  drag = null; checkpoint(before); buildList(); buildGeometry();
}

function buildList() {
  $('cardList').replaceChildren(); $('restoreCard').replaceChildren();
  for (const c of layout.cards) {
    const row = document.createElement('div'); row.className = 'card-list-row' + (selected === c.id ? ' selected' : ''); row.dataset.card = c.id;
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = c.enabled; check.setAttribute('aria-label', `显示${Composition.names[c.type]}`);
    check.addEventListener('change', () => change(() => { card(c.id).enabled = check.checked; }));
    const button = document.createElement('button'); button.textContent = Composition.names[c.type]; button.addEventListener('click', () => select(c.id)); button.addEventListener('dblclick', () => { select(c.id); openProperties(); });
    const hint = document.createElement('small'); hint.textContent = c.enabled ? '双击编辑' : '已删除'; row.append(check, button, hint); $('cardList').append(row);
    if (!c.enabled) { const option = document.createElement('option'); option.value = c.id; option.textContent = Composition.names[c.type]; $('restoreCard').append(option); }
  }
  const empty = !$('restoreCard').children.length;
  if (empty) { const option = document.createElement('option'); option.textContent = '全部卡片已添加'; $('restoreCard').append(option); }
  $('restoreButton').disabled = empty; $('restoreCard').disabled = empty;
}

function field(root, label, key, type = 'number', options = {}) {
  const wrapper = document.createElement('label'); wrapper.className = 'editor-field' + (options.wide ? ' wide-field' : '');
  const title = document.createElement('span'); title.textContent = label; wrapper.append(title);
  const input = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
  input.dataset.property = key;
  if (type === 'select') for (const [value, text] of options.choices) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
  else if (type !== 'textarea') input.type = type;
  if (options.min !== undefined) input.min = options.min;
  if (options.max !== undefined) input.max = options.max;
  if (type === 'number') input.step = options.step || '.1';
  const read = () => options.get ? options.get() : card()[key];
  const display = () => { if (type === 'checkbox') input.checked = !!read(); else input.value = options.percent ? Number((read() * 100).toFixed(3)) : read(); };
  display();
  let before = null;
  input.addEventListener('focus', () => { before = pack(); });
  input.addEventListener('input', () => {
    if (before === null) before = pack();
    let value = type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) / (options.percent ? 100 : 1) : input.value;
    if (type === 'number' && (!input.value || !Number.isFinite(value))) return;
    if (options.set) options.set(value); else card()[key] = value;
    layout = Composition.normalize(layout); paint(); updateGeometryValues(input); refreshPropertyFields(); scheduleAudio();
  });
  input.addEventListener('change', () => { checkpoint(before ?? pack()); before = null; display(); });
  input.addEventListener('blur', () => { if (before !== null) checkpoint(before); before = null; });
  wrapper.append(input);
  if (options.help) { const hint = document.createElement('small'); hint.textContent = options.help; wrapper.append(hint); }
  root.append(wrapper); return input;
}
function buildGeometry() {
  $('selectedTitle').textContent = Composition.names[card().type] + (card().enabled ? '' : ' · 已删除');
  $('geometryFields').replaceChildren();
  for (const [key, name] of [['x', '横向位置 %'], ['y', '纵向位置 %'], ['width', '宽度 %'], ['height', '高度 %']]) field($('geometryFields'), name, key, 'number', { percent: true, min: 0, max: 100, set: value => { card()[key] = value; if (card().type === 'spectrum') card().linked = false; if (card().type === 'record' && key === 'height') card().width = value * 9 / 16; } });
  $('deleteSelected').disabled = !card().enabled;
}
function updateGeometryValues(except) {
  for (const input of $('geometryFields').querySelectorAll('input')) if (input !== except && input !== document.activeElement) input.value = Number((card()[input.dataset.property] * 100).toFixed(3));
}
function buildProperties() {
  $('propertiesTitle').textContent = '编辑' + Composition.names[card().type] + '卡片';
  const root = $('propertyFields'); root.replaceChildren();
  const color = (label, key) => field(root, label, key, 'color');
  const font = () => field(root, '字号（按 1080P）', 'fontSize', 'number', { min: 8, max: 200 });
  const align = () => field(root, '文字对齐', 'align', 'select', { choices: [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']] });
  switch (card().type) {
    case 'record':
      field(root, '封面占黑胶直径 %', 'coverRatio', 'number', { percent: true, min: 10, max: 95 });
      field(root, '旋转一周的秒数', 'spinSeconds', 'number', { min: 2, max: 120, help: '静态预览显示时间轴所选时刻的角度。' });
      const cover = document.createElement('button'); cover.className = 'button quiet'; cover.textContent = '更换歌曲封面'; cover.style.marginTop = '20px'; cover.addEventListener('click', attempt(async () => { const value = await rpc('pickCover'); if (value) change(() => { data.cover = value; }); })); root.append(cover);
      break;
    case 'lyrics':
      font(); field(root, '歌词行间距', 'lineSpacing', 'number', { min: 1.5, max: 5 }); align(); field(root, '当前歌词加粗', 'bold', 'checkbox');
      field(root, '随背景自动配色', 'autoColor', 'checkbox', { wide: true, help: '识别歌词区域的背景明暗与色调，每半秒更新配色。关闭后使用下方手动颜色。' });
      color('当前歌词颜色', 'color'); color('相邻歌词颜色', 'nearColor'); color('其他歌词颜色', 'dimColor');
      field(root, '时间轴歌词内容', 'lyrics', 'textarea', { wide: true, get: () => data.lyrics, set: value => { data.lyrics = value; }, help: '每行格式：[00:12.30]歌词内容。英文会按完整单词换行。' });
      break;
    case 'caption':
      field(root, '歌名', 'title', 'text', { wide: true, help: '留空时使用音频标签中的歌名。' }); field(root, '歌手', 'artist', 'text', { wide: true, help: '留空时使用音频标签中的歌手。' }); font(); color('歌名颜色', 'color'); color('歌手颜色', 'artistColor');
      break;
    case 'clock':
      field(root, '时间显示格式', 'format', 'select', { choices: [['elapsed-total', '已播放 / 总时长'], ['elapsed', '仅已播放'], ['remaining-total', '剩余时间 / 总时长'], ['total', '仅总时长'], ['hours', '时:分:秒 / 总时长']] });
      field(root, '时间样式', 'style', 'select', { choices: [['plain', '纯文字'], ['pill', '圆角底色']] }); font(); align(); color('文字颜色', 'color'); color('底色', 'backgroundColor');
      break;
    case 'progress':
      color('已播放颜色', 'color'); color('进度条底色', 'trackColor'); field(root, '线条粗细（按 1080P）', 'thickness', 'number', { min: .5, max: 30 });
      break;
    case 'spectrum':
      field(root, '可视化类型', 'visualization', 'select', { choices: [['curve', '平滑曲线'], ['mirror', '上下镜像曲线'], ['bars', '柱状图']], wide: true });
      color('可视化颜色', 'color'); field(root, '曲线粗细（按 1080P）', 'thickness', 'number', { min: .5, max: 30, help: '对平滑曲线和上下镜像曲线生效。' }); field(root, '动态幅度', 'gain', 'number', { min: .1, max: 4 });
      field(root, '频段数量 / 柱子数量', 'bandCount', 'number', { min: 16, max: 192, step: 1, help: '曲线控制点数量或柱子数量；越多细节越丰富。' });
      field(root, 'FFT 采样精度', 'fftSize', 'select', { choices: [[512, '512 · 响应更快'], [1024, '1024 · 均衡'], [2048, '2048 · 频率更细'], [4096, '4096 · 最高精度']], get: () => card().fftSize, set: value => { card().fftSize = Number(value); }, help: '影响频率分辨率，也会影响导出分析耗时。' });
      field(root, '空间平滑度', 'smoothing', 'number', { min: 0, max: 4, step: 1, help: '0 保留细节，4 更柔和；适用于所有类型。' });
      field(root, '上升响应（秒）', 'attack', 'number', { min: .01, max: .5, step: .01 }); field(root, '回落响应（秒）', 'release', 'number', { min: .03, max: 1, step: .01 });
      field(root, '最低频率（Hz）', 'minFrequency', 'number', { min: 20, max: 1000, step: 1 }); field(root, '最高频率（Hz）', 'maxFrequency', 'number', { min: 1100, max: 12000, step: 1 });
      field(root, '柱间留白 %', 'barGap', 'number', { percent: true, min: 0, max: 90, help: '仅柱状图生效；柱宽随数量和卡片宽度自动计算。' });
      field(root, '跟随播放进度条', 'linked', 'checkbox', { help: '宽度跟随进度条，曲线基线对齐；镜像曲线整体位于进度条上方。拖动可单独定位。' });
      field(root, '音乐音量 %', 'volume', 'number', { min: 0, max: 1000, get: () => data.volume, set: value => { data.volume = Math.max(0, Math.min(1000, value)); }, help: '静态预览不会播放声音；此音量用于主窗口试听和成片。' });
      break;
  }
  refreshPropertyFields();
}
function refreshPropertyFields() {
  if (!$('cardDialog')) return;
  for (const input of $('propertyFields').querySelectorAll('[data-property]')) {
    const key = input.dataset.property;
    input.disabled = card().type === 'lyrics' && card().autoColor && ['color', 'nearColor', 'dimColor'].includes(key);
    input.closest('label').hidden = card().type === 'spectrum' && (key === 'barGap' && card().visualization !== 'bars' || key === 'thickness' && card().visualization === 'bars');
  }
}
function openProperties() { buildProperties(); $('cardDialog').showModal(); }
function seekFrame() {
  const video = $('backgroundVideo');
  if (data.background && Number.isFinite(video.duration) && video.duration > 0) { video.pause(); const wanted = seconds % video.duration; if (Math.abs(video.currentTime - wanted) > .001) video.currentTime = wanted; }
  paint(); scheduleAudio();
}
function scheduleAudio() {
  clearTimeout(audioTimer); const revision = ++audioRevision;
  if (!data.audio || !card('spectrum').enabled) { levels.fill(0); return; }
  $('frameStatus').textContent = '正在读取当前帧的音频曲线…';
  audioTimer = setTimeout(attempt(async () => {
    try {
      const value = await rpc('sampleAudio', { seconds, historySeconds: Math.max(.3, card('spectrum').release * 3) });
      if (revision !== audioRevision) return;
      const raw = atob(value?.pcm || ''), buffer = new ArrayBuffer(raw.length), bytes = new Uint8Array(buffer);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      levels = AudioSpectrum.analyzeSamples(new Float32Array(buffer), card('spectrum')); paint();
      $('frameStatus').textContent = '当前为静态单帧 · 不播放音频或视频';
    } catch (error) { if (revision === audioRevision && !error.cancelled) { levels.fill(0); paint(); $('frameStatus').textContent = '当前音频曲线无法读取，可继续调整卡片'; } }
  }), 130);
}

$('frameSeek').addEventListener('input', () => { seconds = Number($('frameSeek').value); seekFrame(); });
$('backgroundVideo').addEventListener('loadedmetadata', seekFrame);
$('backgroundVideo').addEventListener('loadeddata', () => Composition.updateLyricColors($('preview'), layout, data.brightness));
$('backgroundVideo').addEventListener('seeked', () => Composition.updateLyricColors($('preview'), layout, data.brightness));
$('backgroundVideo').addEventListener('play', () => $('backgroundVideo').pause());
$('backgroundVideo').addEventListener('error', () => { $('frameStatus').textContent = '此背景编码无法预览，可先调整卡片再由 FFmpeg 导出。'; });
$('undo').addEventListener('click', () => { if (undo.length) { redo.push(pack()); restore(undo.pop()); } });
$('redo').addEventListener('click', () => { if (redo.length) { undo.push(pack()); restore(redo.pop()); } });
$('deleteSelected').addEventListener('click', () => change(() => { card().enabled = false; }));
$('restoreButton').addEventListener('click', () => { const id = $('restoreCard').value; if (!id) return; change(() => { card(id).enabled = true; }); select(id); });
$('editSelected').addEventListener('click', openProperties);
$('resetCard').addEventListener('click', () => { change(() => { const index = layout.cards.findIndex(c => c.id === selected); layout.cards[index] = Composition.get(Composition.defaults(), selected); }); buildProperties(); });
$('resetLayout').addEventListener('click', () => change(() => { layout = Composition.defaults(); }));
for (const id of ['closeProperties', 'doneProperties']) $(id).addEventListener('click', () => $('cardDialog').close());
$('cancelEditor').addEventListener('click', attempt(() => rpc('closeEditor')));
$('applyEditor').addEventListener('click', attempt(async () => {
  if (data.lyrics.trim() && !parseLrc(data.lyrics).length) throw new Error('歌词缺少有效时间轴，请修正或清空后再应用。');
  await rpc('saveEditor', { layout: Composition.normalize(layout), cover: data.cover, lyrics: data.lyrics, volume: data.volume });
}));
document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (event.ctrlKey && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); $(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo').click(); return; }
  if ($('cardDialog').open) return;
  if (event.key === 'Delete') { event.preventDefault(); $('deleteSelected').click(); }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) { event.preventDefault(); change(() => { const amount = event.shiftKey ? 10 : 1; card().x += direction[0] * amount / 1920; card().y += direction[1] * amount / 1080; if (card().type === 'spectrum') card().linked = false; }); }
});

(async () => {
  try {
    data = await rpc('bootstrapEditor'); data.lyrics ||= ''; layout = Composition.normalize(data.layout);
    seconds = Math.max(0, Math.min(data.audio?.duration || 0, Number(data.seconds) || 0));
    $('frameSeek').max = data.audio?.duration || 1; $('frameSeek').value = seconds; $('frameSeek').disabled = !data.audio;
    if (data.background) $('backgroundVideo').src = data.background.url;
    buildList(); buildGeometry(); seekFrame();
  } catch (error) { toast(error.message); $('frameStatus').textContent = '编辑窗口初始化失败'; }
})();
