'use strict';

const $ = id => document.getElementById(id);
const native = window.chrome?.webview;
const pending = new Map();
let serial = 0;
const state = {
  audio: null, background: null, cover: null, lyrics: '', lines: [], instrumental: false,
  dependencies: null, rendering: false, installing: false, output: null, lyricRevision: 0,
  searchRevision: 0, offset: 0, activeLine: -2, audioContext: null, gain: null, analyser: null, spectrumFrame: 0, spectrumTime: 0,
  spectrumLevels: new Float64Array(AudioSpectrum.BAND_COUNT), seekDragging: false
};
const defaults = { volume: 100, brightness: 45, fontSize: 44, resolution: '1080', fps: '30', defaultFontSize: 44, outputDirectory: '', showSpectrum: true, container: 'mp4' };
let prefs = { ...defaults };
try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem('preferences') || '{}') }; } catch { /* A damaged setting never prevents startup. */ }
let composition = Composition.normalize(prefs.layout, prefs.fontSize);
if (!prefs.layout) Composition.get(composition, 'spectrum').enabled = prefs.showSpectrum;
prefs.showSpectrum = Composition.get(composition, 'spectrum').enabled;
prefs.fontSize = Composition.get(composition, 'lyrics').fontSize;
prefs.encoding = EncodingSettings.normalize(prefs.encoding);
if (!['mp4', 'mkv', 'mov', 'webm'].includes(prefs.container)) prefs.container = 'mp4';
prefs.encoding = EncodingSettings.forContainer(prefs.encoding, prefs.container);

function rpc(action, payload = {}) {
  if (!native) return Promise.reject(new Error('请从拾音桌面程序打开此界面。'));
  return new Promise((resolve, reject) => {
    const id = String(++serial);
    pending.set(id, { resolve, reject });
    native.postMessage({ id, action, payload });
  });
}

native?.addEventListener('message', ({ data }) => {
  if (data.event) {
    if (data.event === 'downloadProgress') downloadProgress(data.data);
    if (data.event === 'renderProgress') renderProgress(data.data);
    if (data.event === 'batchProgress') batchExporter.progress(data.data);
    if (data.event === 'deviceProgress') deviceOptimizer.progress(data.data);
    if (data.event === 'mediaImport') {
      if (data.data.active) Startup.finish();
      updateMediaImport(data.data);
    }
    return;
  }
  const task = pending.get(data.id);
  if (!task) return;
  pending.delete(data.id);
  if (data.ok) task.resolve(data.data);
  else task.reject(Object.assign(new Error(data.error || '操作失败'), { cancelled: data.cancelled }));
});

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5200);
}
function attempt(handler) {
  return async event => {
    try { await handler(event); }
    catch (error) { if (!error.cancelled) toast(error.message || String(error)); }
  };
}
function on(id, event, handler) { $(id).addEventListener(event, attempt(handler)); }
let themeSaveTask = Promise.resolve(), themeRevision = 0;
SoftwareThemes.mount($('themeChoices'), theme => {
  ++themeRevision;
  themeSaveTask = themeSaveTask.catch(() => {}).then(() => rpc('setSoftwareTheme', { theme }));
  themeSaveTask.catch(error => toast(error.message || '无法保存软件主题。'));
});
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
function updateMediaImport(data) {
  $('mediaImportMessage').textContent = data.message;
  if (!data.active) { $('mediaImportDialog').close(); return; }
  if (!$('mediaImportDialog').open) { $('cancelMediaImport').disabled = false; $('cancelMediaImport').textContent = '取消导入'; }
  const bar = $('mediaImportProgress');
  const known = Number.isFinite(data.total) && data.total > 0 && Number.isFinite(data.completed);
  if (known) {
    const total = Math.max(1, Math.floor(data.total)), completed = Math.max(0, Math.min(total, Math.floor(data.completed)));
    bar.max = total; bar.value = completed;
    $('mediaImportCount').textContent = `已处理 ${completed} / ${total} · ${Math.floor(completed / total * 100)}%`;
    bar.setAttribute('aria-valuetext', $('mediaImportCount').textContent);
  } else {
    bar.removeAttribute('value'); bar.removeAttribute('aria-valuetext');
    $('mediaImportCount').textContent = '正在处理当前素材…';
  }
  openDialog('mediaImportDialog');
}
function savePrefs() { prefs.layout = composition; try { localStorage.setItem('preferences', JSON.stringify(prefs)); } catch { /* Read-only profiles still work. */ } }
function icon(name) { return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`; }
function clock(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function bytes(value) { return `${(value / 1_000_000).toFixed(1)} MB`; }
function sliderFill(input) { input.style.setProperty('--range-fill', `${(input.value - input.min) / (input.max - input.min) * 100}%`); }

function applySettings() {
  for (const name of ['volume', 'brightness', 'fontSize', 'resolution', 'fps']) {
    const input = $(name);
    if (name === 'volume') input.value = Math.min(1000, Math.max(0, Number(prefs[name]) || 0));
    else if (name === 'brightness') input.value = Math.min(100, Math.max(0, Number(prefs[name]) || 0));
    else if (name === 'fontSize') input.value = Math.min(200, Math.max(8, Number(prefs[name]) || 44));
    else input.value = prefs[name];
  }
  $('showSpectrum').checked = prefs.showSpectrum;
  updateSettings();
  $('defaultFontSize').value = prefs.defaultFontSize;
}
function updateSettings() {
  for (const name of ['volume', 'brightness', 'fontSize']) prefs[name] = Number($(name).value);
  prefs.resolution = $('resolution').value; prefs.fps = $('fps').value;
  prefs.showSpectrum = $('showSpectrum').checked;
  Composition.get(composition, 'spectrum').enabled = prefs.showSpectrum;
  Composition.get(composition, 'lyrics').fontSize = prefs.fontSize;
  composition = Composition.normalize(composition, prefs.fontSize);
  configureSpectrum();
  Composition.apply($('preview'), composition, state.audio || {});
  $('volumeValue').innerHTML = `${prefs.volume}<span>%</span>`;
  $('brightnessValue').innerHTML = `${prefs.brightness}<span>%</span>`;
  $('volumeHint').textContent = prefs.volume > 100 ? '音量已放大，输出自动限制过载峰值' : prefs.volume === 0 ? '输出音乐将静音' : '保持原声，保留每一处细节';
  $('volumeHint').classList.toggle('boost', prefs.volume > 100);
  $('preview').style.setProperty('--brightness', prefs.brightness / 100);
  $('preview').style.setProperty('--lyric-size', prefs.fontSize);
  $('lyricLines').style.setProperty('--line-gap', `${Composition.spacing(Composition.get(composition, 'lyrics')) / 19.2}cqw`);
  $('previewQuality').textContent = `${prefs.resolution}P · ${prefs.fps} 帧`;
  sliderFill($('volume')); sliderFill($('brightness'));
  if (state.gain) state.gain.gain.value = prefs.volume / 100;
  else $('audio').volume = Math.min(1, prefs.volume / 100);
  refreshSpectrum();
  state.activeLine = -2; syncPreview(); savePrefs();
}

function parseLrc(text, extraOffset = 0) {
  const groups = new Map();
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000 + extraOffset;
  for (const raw of text.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const words = raw.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    for (const stamp of matches) {
      if (+stamp[2] >= 60) continue;
      const time = Math.round(Math.max(0, +stamp[1] * 60 + +stamp[2] + +(stamp[3] || 0) / 10 ** (stamp[3]?.length || 1) + offset) * 1000) / 1000;
      if (!groups.has(time)) groups.set(time, []);
      if (!groups.get(time).includes(words)) groups.get(time).push(words);
    }
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([time, words]) => ({ time, text: words.join('\n') }));
}
const lyricMeasure = document.createElement('canvas').getContext('2d');
function measureLyric(text, size) {
  lyricMeasure.font = `700 ${size}px "Microsoft YaHei"`;
  return lyricMeasure.measureText(text).width;
}
function setLyrics(text, source) {
  const lines = parseLrc(text, state.offset);
  if (!lines.length) throw new Error('没有找到有效时间轴，请导入带有 [分:秒] 标记的 LRC 歌词。');
  state.lyrics = text; state.lines = lines; state.instrumental = false;
  $('instrumental').checked = false;
  state.activeLine = -2;
  populateLyrics();
  $('lyricDot').className = 'status-dot ready';
  $('lyricStatus').textContent = `${source} · ${lines.length} 行时间轴`;
  updateSteps();
}
function populateLyrics() {
  $('lyricLines').replaceChildren();
  const card = Composition.get(composition, 'lyrics');
  const spacing = Composition.spacing(card);
  const fragment = document.createDocumentFragment();
  for (const line of state.lines) {
    const element = document.createElement('div'); element.className = 'lyric-line';
    const layout = LyricLayout.fitLyric(line.text, card.fontSize, 1920 * card.width, spacing * .94, measureLyric);
    element.textContent = layout.text;
    element.style.fontSize = `${layout.fontSize / 19.2}cqw`;
    element.style.textAlign = card.align;
    fragment.append(element);
  }
  $('lyricLines').append(fragment);
  $('lyricEmpty').hidden = state.lines.length > 0;
  $('lyricLines').hidden = !state.lines.length;
  Composition.apply($('preview'), composition, state.audio || {});
  syncPreview();
}

function syncPreview() {
  Composition.updateLyricColors($('preview'), composition, prefs.brightness);
  const audio = $('audio');
  const duration = state.audio?.duration || 0;
  const current = Math.max(0, Math.min(audio.currentTime || 0, duration));
  const percentage = duration ? current / duration * 100 : 0;
  $('previewClock').textContent = Composition.formatTime(current, duration, Composition.get(composition, 'clock').format);
  $('transportTime').textContent = clock(current);
  $('transportDuration').textContent = clock(duration);
  if (!state.seekDragging) $('seek').value = current;
  $('seek').style.setProperty('--range-fill', percentage + '%');
  $('videoProgressFill').style.width = percentage + '%';
  const rotation = $('vinyl').getAnimations()[0];
  if (rotation && Math.abs(Number(rotation.currentTime) - current * 1000) > 50) rotation.currentTime = current * 1000;
  let active = -1;
  // Binary search keeps long lyric files responsive.
  let low = 0, high = state.lines.length;
  while (low < high) { const middle = (low + high) >> 1; if (state.lines[middle].time <= current) low = middle + 1; else high = middle; }
  active = low - 1;
  if (active !== state.activeLine) {
    state.activeLine = active;
    const target = Math.max(0, active);
    $('lyricLines').style.transform = `translateY(calc(-${target} * var(--line-gap)))`;
    [...$('lyricLines').children].forEach((line, index) => { line.classList.toggle('active', index === active); line.classList.toggle('near', index !== active && Math.abs(index - target) <= 1); });
  }
  const video = $('backgroundVideo');
  if (state.background && Number.isFinite(video.duration) && video.duration > 0) {
    const wanted = current % video.duration;
    if (Math.abs(video.currentTime - wanted) > .45) video.currentTime = wanted;
  }
}

async function togglePlayback() {
  const audio = $('audio');
  if (!state.audio) return;
  if (!audio.paused) { audio.pause(); return; }
  if (!state.audioContext && window.AudioContext) {
    try {
      try { state.audioContext = new AudioContext({ sampleRate: 24000 }); }
      catch { state.audioContext = new AudioContext(); }
      const source = state.audioContext.createMediaElementSource(audio);
      state.analyser = state.audioContext.createAnalyser();
      configureSpectrum();
      state.analyser.smoothingTimeConstant = 0;
      state.spectrumData = new Float32Array(state.analyser.frequencyBinCount);
      const limiter = state.audioContext.createDynamicsCompressor();
      limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .1;
      state.gain = state.audioContext.createGain(); state.gain.gain.value = prefs.volume / 100;
      source.connect(state.analyser); state.analyser.connect(state.gain); state.gain.connect(limiter); limiter.connect(state.audioContext.destination);
      audio.volume = 1;
    } catch { toast('当前环境仅支持最高 100% 预览音量，导出仍按设置生效。'); }
  }
  await state.audioContext?.resume();
  await audio.play();
}
function playbackState(playing) {
  $('playButton').innerHTML = icon(playing ? 'pause' : 'play');
  $('playButton').setAttribute('aria-label', playing ? '暂停预览' : '播放预览');
  $('vinyl').classList.toggle('playing', playing);
  const video = $('backgroundVideo');
  if (playing && state.background) video.play().catch(() => {}); else video.pause();
  refreshSpectrum();
}

function configureSpectrum() {
  const card = Composition.get(composition, 'spectrum');
  if (state.spectrumLevels.length !== card.bandCount) state.spectrumLevels = new Float64Array(card.bandCount);
  if (state.analyser) {
    const size = Math.min(32768, Math.max(32, 2 ** Math.round(Math.log2(state.audioContext.sampleRate / 24000 * card.fftSize))));
    if (state.analyser.fftSize !== size) state.analyser.fftSize = size;
    if (state.spectrumData?.length !== state.analyser.frequencyBinCount) state.spectrumData = new Float32Array(state.analyser.frequencyBinCount);
  }
}
function drawSpectrum() {
  const card = Composition.get(composition, 'spectrum');
  $('spectrumPath').setAttribute('d', AudioSpectrum.path(state.spectrumLevels.map(v => Math.min(1, v * card.gain)), card.width * 1920, card.height * 1080, card));
}
function resetSpectrum() { state.spectrumLevels.fill(0); state.spectrumTime = 0; drawSpectrum(); }
function refreshSpectrum() {
  $('audioSpectrum').toggleAttribute('hidden', !prefs.showSpectrum);
  if (!prefs.showSpectrum || $('audio').paused || !state.analyser) {
    cancelAnimationFrame(state.spectrumFrame); state.spectrumFrame = 0; state.spectrumTime = 0;
    if (!$('spectrumPath').hasAttribute('d')) drawSpectrum();
    return;
  }
  if (!state.spectrumFrame) state.spectrumFrame = requestAnimationFrame(animateSpectrum);
}
function animateSpectrum(now) {
  state.spectrumFrame = 0;
  if (!prefs.showSpectrum || $('audio').paused || !state.analyser) return;
  state.analyser.getFloatFrequencyData(state.spectrumData);
  const card = Composition.get(composition, 'spectrum');
  const bands = AudioSpectrum.frequencyBands(state.spectrumData, state.audioContext.sampleRate, state.analyser.fftSize, card);
  AudioSpectrum.smoothBands(bands, state.spectrumLevels, state.spectrumTime ? (now - state.spectrumTime) / 1000 : 1 / 60, card);
  state.spectrumTime = now;
  drawSpectrum();
  state.spectrumFrame = requestAnimationFrame(animateSpectrum);
}

function updateSteps() {
  $('step1').className = `step ${state.audio ? 'done' : 'current'}`;
  $('step2').className = `step ${state.background ? 'done' : state.audio ? 'current' : ''}`;
  $('step3').className = `step ${state.audio && (state.lines.length || state.instrumental) ? 'current' : ''}`;
}
function setCover(cover) {
  state.cover = cover;
  $('recordLabel').style.backgroundImage = cover?.url ? `url("${cover.url.replace(/"/g, '%22')}")` : '';
  $('recordLabel').querySelector('.label-art').hidden = !!cover;
}

async function pickAudio() {
  if (!state.dependencies?.ffmpeg.ready) { openDialog('dependenciesDialog'); return; }
  const audio = await rpc('pickAudio'); if (!audio) return;
  await loadAudio(audio);
}

async function loadAudio(audio) {
  $('audio').pause();
  resetSpectrum();
  const revision = ++state.lyricRevision;
  state.audio = audio; state.lyrics = ''; state.lines = []; state.instrumental = false; state.offset = 0;
  $('lyricEmpty').innerHTML = '<span>那些藏在旋律里的话</span><strong>将在这里，缓缓流动</strong><span>导入音乐后自动寻找时间轴歌词</span>';
  $('lyricOffset').value = 0; $('instrumental').checked = false; state.activeLine = -2;
  $('audio').src = audio.url; $('audio').load();
  $('playButton').disabled = false; $('seek').disabled = false; $('seek').max = audio.duration;
  $('audioName').textContent = audio.title;
  $('audioMeta').textContent = `${audio.artist || '未知歌手'} · ${clock(audio.duration)} · ${audio.format || '音频'}`;
  $('pickAudio').classList.add('has-file');
  $('previewTitle').textContent = audio.title;
  $('previewArtist').textContent = audio.artist || '未知歌手';
  $('fileName').value = `${audio.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 130)} - 歌词MV.${prefs.container}`;
  setCover(audio.coverPath ? { path: audio.coverPath, url: audio.coverUrl } : null);
  $('lyricsQuery').value = `${audio.title} ${audio.artist}`.trim();
  populateLyrics(); updateSteps(); syncPreview();
  if (audio.localLyrics) {
    try { setLyrics(audio.localLyrics, '已读取本地歌词'); toast('已读取音乐旁的同名歌词或内嵌歌词。'); return; }
    catch { toast('本地歌词缺少有效时间轴，继续搜索公开歌词库。'); }
  }
  $('lyricDot').className = 'status-dot checking'; $('lyricStatus').textContent = '正在匹配公开歌词库…';
  try { await searchLyrics(false, revision); }
  catch (error) {
    if (state.lyricRevision !== revision) return;
    $('lyricDot').className = 'status-dot warning'; $('lyricStatus').textContent = '在线匹配失败，可手动导入歌词';
    toast(error.message);
  }
}

async function pickBackground() {
  if (!state.dependencies?.ffmpeg.ready) { openDialog('dependenciesDialog'); return; }
  const video = await rpc('pickBackground'); if (!video) return;
  loadBackground(video);
}
function loadBackground(video) {
  state.background = video;
  $('backgroundName').textContent = video.name;
  $('backgroundMeta').textContent = `${video.width} × ${video.height} · ${clock(video.duration)} · ${video.format || '视频'} · 自动循环`;
  $('pickBackground').classList.add('has-file');
  $('backgroundVideo').src = video.url; $('backgroundVideo').load(); updateSteps();
}

async function searchLyrics(manual, revision = state.lyricRevision) {
  if (!state.audio) { toast('请先选择音乐文件。'); return; }
  const searchId = ++state.searchRevision;
  const audio = state.audio;
  $('lyricsResults').replaceChildren();
  const loading = document.createElement('p'); loading.className = 'empty-message working'; loading.textContent = '正在寻找这首歌的时间轴…'; $('lyricsResults').append(loading);
  if (manual) openDialog('lyricsDialog');
  let results;
  try {
    results = await rpc('searchLyrics', { title: audio.title, artist: audio.artist, album: audio.album, duration: audio.duration, query: manual ? $('lyricsQuery').value : '' });
  } catch (error) {
    if (searchId === state.searchRevision) { loading.classList.remove('working'); loading.textContent = error.message; loading.classList.add('error-text'); }
    throw error;
  }
  if (revision !== state.lyricRevision || searchId !== state.searchRevision) return;
  $('lyricsResults').replaceChildren();
  for (const candidate of results) {
    const timed = !!candidate.syncedLyrics && parseLrc(candidate.syncedLyrics).length > 0;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'lyric-result'; button.disabled = !timed && !candidate.instrumental;
    const body = document.createElement('div'), title = document.createElement('b'), meta = document.createElement('p'), badge = document.createElement('small');
    title.textContent = candidate.title; meta.textContent = `${candidate.artist || '未知歌手'} · ${candidate.album || '未注明专辑'} · ${clock(candidate.duration)}`;
    badge.textContent = timed ? '时间轴歌词 · 选择' : candidate.instrumental ? '纯音乐 · 选择' : '仅纯文本，无时间轴';
    body.append(title, meta); button.append(body, badge);
    button.addEventListener('click', attempt(() => { if (candidate.instrumental && !timed) setInstrumental(true); else setLyrics(candidate.syncedLyrics, 'LRCLIB 歌词'); $('lyricsDialog').close(); }));
    $('lyricsResults').append(button);
  }
  if (!results.length) {
    const empty = document.createElement('p'); empty.className = 'empty-message'; empty.textContent = '暂未找到这首歌。可修改歌名、歌手重试，或导入本地 LRC。'; $('lyricsResults').append(empty);
  }
  if (!manual) {
    const match = results.find(item => item.score >= 65 && item.syncedLyrics && Math.abs(item.duration - audio.duration) < 4 && parseLrc(item.syncedLyrics).length);
    if (match) { setLyrics(match.syncedLyrics, '已自动匹配歌词'); toast('已匹配时间轴歌词，可以播放试听。'); }
    else {
      $('lyricDot').className = 'status-dot warning'; $('lyricStatus').textContent = results.length ? '找到候选歌词，请选择匹配版本' : '未找到歌词，可导入本地 LRC';
      openDialog('lyricsDialog');
    }
  }
}

function setInstrumental(enabled) {
  state.instrumental = enabled; $('instrumental').checked = enabled;
  if (enabled) {
    state.lyrics = ''; state.lines = []; populateLyrics();
    $('lyricEmpty').replaceChildren();
    const text = document.createElement('strong'); text.textContent = '纯音乐 · 此刻只听旋律'; $('lyricEmpty').append(text);
    $('lyricStatus').textContent = '纯音乐模式 · 不显示滚动歌词'; $('lyricDot').className = 'status-dot ready';
  } else { $('lyricStatus').textContent = '请选择或导入时间轴歌词'; $('lyricDot').className = 'status-dot warning'; $('lyricEmpty').textContent = '请选择或导入带有时间轴的歌词'; }
  updateSteps();
}
async function importLyrics() {
  if (!state.audio) { toast('请先选择音乐文件。'); return; }
  const selected = await rpc('pickLyrics'); if (!selected) return;
  ++state.lyricRevision; ++state.searchRevision;
  setLyrics(selected.lyrics, '已导入歌词'); $('lyricsDialog').close(); toast(`已导入 ${selected.name}`);
}

function showDependencies(deps) {
  state.dependencies = deps;
  $('envDot').className = `status-dot ${deps.ready ? 'ready' : 'warning'}`;
  $('envTitle').textContent = deps.ready ? '渲染环境已就绪' : '需要安装渲染组件';
  $('envSubtitle').textContent = deps.ready ? 'FFmpeg 与 Python 可用' : '点击查看缺失的组件';
  $('dependencyList').replaceChildren();
  for (const dep of [deps.ffmpeg, deps.python]) {
    const row = document.createElement('div'); row.className = 'dependency-row';
    const symbol = document.createElement('span'); symbol.className = 'dependency-icon'; symbol.innerHTML = icon(dep.name === 'FFmpeg' ? 'video' : 'settings');
    const body = document.createElement('div'), title = document.createElement('b'), version = document.createElement('p'), detail = document.createElement('small'), tag = document.createElement('span');
    title.textContent = dep.name; version.textContent = dep.version; version.title = dep.path || dep.detail; detail.textContent = dep.detail;
    body.append(title, version, detail); tag.className = `dependency-tag ${dep.ready ? '' : 'missing'}`; tag.textContent = dep.ready ? '已就绪' : '需要安装';
    row.append(symbol, body, tag); $('dependencyList').append(row);
  }
  $('installDependencies').hidden = deps.ready;
  $('refreshDependencies').textContent = deps.ready ? '重新检测' : '重新检测';
}
function downloadProgress(data) {
  $('downloadBox').hidden = false; $('downloadName').textContent = data.name;
  if (data.total > 0) { $('downloadProgress').value = data.received / data.total * 100; $('downloadPercent').textContent = `${Math.floor(data.received / data.total * 100)}%`; }
  else { $('downloadProgress').removeAttribute('value'); $('downloadPercent').textContent = ''; }
  $('downloadStats').textContent = data.total ? `${bytes(data.received)} / ${bytes(data.total)} · ${bytes(data.bytesPerSecond)}/s · ${data.threads} 线程` : '';
  $('downloadStatus').textContent = data.status;
}
async function installDependencies() {
  if (state.installing) return;
  state.installing = true; $('installDependencies').disabled = true; $('refreshDependencies').disabled = true; $('cancelDownload').hidden = false;
  try {
    const deps = await rpc('installDependencies'); showDependencies(deps);
    $('downloadProgress').value = 100; $('downloadStatus').textContent = '全部组件已就绪，可以开始创作。'; toast('依赖已安装完成。');
  } catch (error) {
    $('downloadStatus').textContent = error.cancelled ? '下载已取消' : error.message;
    if (!error.cancelled) toast(error.message);
    try { showDependencies(await rpc('detectDependencies')); } catch { /* Preserve the original installation error. */ }
  } finally { state.installing = false; $('installDependencies').disabled = false; $('refreshDependencies').disabled = false; $('cancelDownload').hidden = true; }
  await deviceOptimizer.offer(state.dependencies?.ready);
}

async function generate() {
  if (state.rendering) { openDialog('renderDialog'); return; }
  if (!state.dependencies?.ready) { openDialog('dependenciesDialog'); return; }
  if (!state.audio) { toast('先选择音乐文件，再开始生成。'); return; }
  if (!state.lines.length && !state.instrumental) { toast('请先匹配时间轴歌词，或在歌词窗口选择纯音乐模式。'); openDialog('lyricsDialog'); return; }
  if (!$('outputDirectory').value.trim()) throw new Error('请选择输出目录。');
  if (!$('fileName').value.trim()) throw new Error('请填写输出文件名。');
  const font = Number($('fontSize').value);
  if (!Number.isFinite(font) || font < 8 || font > 200) throw new Error('字幕大小应为 8 到 200。');
  $('audio').pause();
  state.rendering = true; $('workspace').classList.add('busy');
  $('generateButton').querySelector('span').textContent = '查看生成进度';
  $('renderTitle').textContent = '正在生成作品'; $('renderPercent').textContent = '0%'; $('renderProgress').value = 0;
  $('renderMessage').textContent = '正在准备渲染画面'; $('renderPath').textContent = '';
  $('renderMessage').classList.remove('error-text');
  $('renderArt').classList.remove('finished'); $('renderActions').hidden = false; $('finishedActions').hidden = true;
  openDialog('renderDialog');
  const resolution = { '1080': [1920, 1080], '720': [1280, 720], '480': [854, 480] }[prefs.resolution] || [1920, 1080];
  try {
    const result = await rpc('render', {
      audioPath: state.audio.path, backgroundPath: state.background?.path || null, coverPath: state.cover?.path || null,
      title: state.audio.title, artist: state.audio.artist, lyrics: state.instrumental ? '' : state.lyrics,
      duration: state.audio.duration, volume: Number($('volume').value), brightness: Number($('brightness').value),
      fontSize: Math.round(font), width: resolution[0], height: resolution[1], fps: Number(prefs.fps),
      outputDirectory: $('outputDirectory').value, fileName: $('fileName').value, offset: state.offset, showSpectrum: prefs.showSpectrum, layout: composition, encoding: prefs.encoding, container: prefs.container
    });
    state.output = result; displayOutput(); toast('音乐影像已生成并保存。');
  } catch (error) {
    $('renderTitle').textContent = error.cancelled ? '已停止生成' : '生成未完成';
    $('renderMessage').textContent = error.message; $('renderMessage').classList.add('error-text');
    $('renderActions').hidden = true; $('renderArt').classList.add('finished');
    if (!error.cancelled) toast(error.message);
  } finally {
    state.rendering = false; $('workspace').classList.remove('busy'); $('generateButton').querySelector('span').textContent = '生成音乐影像';
  }
}
function displayOutput() {
  if (!state.output) return;
  $('renderTitle').textContent = '你的作品，完成了'; $('renderPercent').textContent = '100%'; $('renderProgress').value = 100;
  $('renderMessage').classList.remove('error-text'); $('renderMessage').textContent = '音乐和画面，已经在此刻相遇。'; $('renderPath').textContent = state.output.path;
  $('renderArt').classList.add('finished'); $('renderActions').hidden = true; $('finishedActions').hidden = false;
  $('outputCount').textContent = '1';
}
function renderProgress(data) {
  if (data.event === 'progress') { $('renderPercent').textContent = `${Math.floor(data.percent)}%`; $('renderProgress').value = data.percent; $('renderMessage').textContent = `已合成 ${clock(data.seconds)} / ${clock(state.audio?.duration)}`; }
  else if (data.event === 'status') $('renderMessage').textContent = data.message;
  else if (data.event === 'analysisProgress') $('renderMessage').textContent = `${data.phase === 'background' ? '正在分析背景颜色' : '正在分析音频可视化'} · ${Math.floor(data.percent)}%`;
  else if (data.event === 'speed' && data.value !== 'N/A') $('renderProgress').title = `渲染速度 ${data.value}`;
}

on('titlebar', 'mousedown', event => { if (event.button === 0 && !event.target.closest('button')) rpc('windowDrag').catch(() => {}); });
on('titlebar', 'dblclick', event => { if (!event.target.closest('button')) return rpc('windowMaximize'); });
for (const [id, action] of [['minimize', 'windowMinimize'], ['maximize', 'windowMaximize'], ['closeWindow', 'windowClose']]) on(id, 'click', () => rpc(action));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
on('pickAudio', 'click', pickAudio); on('pickBackground', 'click', pickBackground);
on('pickCover', 'click', async () => { if (!state.audio) { toast('请先选择音乐文件。'); return; } const cover = await rpc('pickCover'); if (cover) setCover(cover); });
on('pickOutput', 'click', async () => { const path = await rpc('pickOutput', { current: $('outputDirectory').value }); if (path) { $('outputDirectory').value = path; $('outputDirectory').title = path; prefs.outputDirectory = path; savePrefs(); } });
on('outputDirectory', 'click', () => $('pickOutput').click());
for (const name of ['volume', 'brightness']) on(name, 'input', updateSettings);
on('fontSize', 'change', () => { $('fontSize').value = Math.min(200, Math.max(8, Number($('fontSize').value) || 44)); updateSettings(); populateLyrics(); });
for (const name of ['resolution', 'fps', 'showSpectrum']) on(name, 'change', updateSettings);
on('resetSettings', 'click', () => { Object.assign(prefs, { volume: 100, brightness: 45, fontSize: prefs.defaultFontSize, resolution: '1080', fps: '30', showSpectrum: true }); applySettings(); populateLyrics(); toast('已重置画面与音量参数。'); });
on('playButton', 'click', togglePlayback);
on('audio', 'play', () => playbackState(true)); on('audio', 'pause', () => playbackState(false));
on('audio', 'ended', () => { playbackState(false); resetSpectrum(); syncPreview(); }); on('audio', 'timeupdate', syncPreview);
on('audio', 'seeking', resetSpectrum);
on('audio', 'error', () => { if (state.audio) toast('无法预览此音频，请检查媒体文件。'); });
on('backgroundVideo', 'loadeddata', syncPreview);
on('backgroundVideo', 'seeked', syncPreview);
on('backgroundVideo', 'error', () => { if (state.background) { $('previewNote').textContent = '该视频无法在当前环境预览，FFmpeg 仍可尝试导出；建议选择 MP4 背景。'; toast('背景预览不支持此编码，可换成 MP4 视频。'); } });
on('seek', 'pointerdown', () => { state.seekDragging = true; });
on('seek', 'input', () => { if (state.audio) { $('audio').currentTime = Number($('seek').value); syncPreview(); } });
on('seek', 'change', () => { state.seekDragging = false; syncPreview(); });
window.addEventListener('pointerup', () => { state.seekDragging = false; });
on('openLyricSearch', 'click', () => { if (!state.audio) { toast('请先选择音乐文件。'); return; } openDialog('lyricsDialog'); });
on('lyricsSearchForm', 'submit', async event => { event.preventDefault(); await searchLyrics(true); });
on('importLyrics', 'click', importLyrics); on('importLyricsFromDialog', 'click', importLyrics);
on('instrumental', 'change', () => { ++state.lyricRevision; ++state.searchRevision; setInstrumental($('instrumental').checked); });
on('editLyrics', 'click', () => { if (!state.audio) { toast('请先选择音乐文件。'); return; } $('lyricsEditor').value = state.lyrics; $('lyricOffset').value = state.offset; $('editValidation').textContent = '支持 UTF-8 和 GBK 歌词文件'; openDialog('editDialog'); });
on('saveLyrics', 'click', () => {
  const offset = Number($('lyricOffset').value);
  if (!Number.isFinite(offset) || offset < -60 || offset > 60) throw new Error('歌词偏移应在 -60 到 60 秒之间。');
  if (!parseLrc($('lyricsEditor').value, offset).length) { $('editValidation').textContent = '请填写带有有效时间轴的歌词'; throw new Error('没有有效的时间轴。'); }
  state.offset = offset; ++state.lyricRevision; ++state.searchRevision; setLyrics($('lyricsEditor').value, '已编辑歌词'); $('editDialog').close();
});
on('openDependencies', 'click', () => openDialog('dependenciesDialog'));
on('refreshDependencies', 'click', async () => { showDependencies(await rpc('detectDependencies')); toast('环境检测已完成。'); await deviceOptimizer.offer(state.dependencies?.ready); });
on('installDependencies', 'click', installDependencies);
on('cancelDownload', 'click', async () => { await rpc('cancelDownload'); $('downloadStatus').textContent = '正在取消；若已进入安装阶段，请等待安装完成。'; });
async function cancelMediaImport() {
  if ($('cancelMediaImport').disabled) return;
  $('cancelMediaImport').disabled = true; $('cancelMediaImport').textContent = '正在取消…';
  try { await rpc('cancelMediaImport'); }
  catch (error) { $('cancelMediaImport').disabled = false; $('cancelMediaImport').textContent = '取消导入'; throw error; }
}
on('cancelMediaImport', 'click', cancelMediaImport);
$('mediaImportDialog').addEventListener('cancel', event => { event.preventDefault(); attempt(cancelMediaImport)(); });
on('openSettings', 'click', () => openDialog('settingsDialog'));
on('settingsDependencies', 'click', () => { $('settingsDialog').close(); openDialog('dependenciesDialog'); });
on('defaultFontSize', 'change', () => { prefs.defaultFontSize = Math.min(200, Math.max(8, Number($('defaultFontSize').value) || 44)); $('defaultFontSize').value = prefs.defaultFontSize; prefs.fontSize = prefs.defaultFontSize; applySettings(); populateLyrics(); });
on('moreSettings', 'click', async () => {
  $('audio').pause();
  const result = await rpc('editLayout', { audio: state.audio, background: state.background, cover: state.cover, lyrics: state.lyrics, offset: state.offset,
    seconds: $('audio').currentTime || 0, volume: prefs.volume, brightness: prefs.brightness, layout: composition });
  if (!result) return;
  composition = Composition.normalize(result.layout, prefs.fontSize);
  prefs.fontSize = Composition.get(composition, 'lyrics').fontSize;
  prefs.showSpectrum = Composition.get(composition, 'spectrum').enabled;
  prefs.volume = Math.max(0, Math.min(1000, Number(result.volume) || 0));
  setCover(result.cover || null);
  if (result.lyrics !== state.lyrics) {
    if (parseLrc(result.lyrics, state.offset).length) setLyrics(result.lyrics, '已在更多设置中编辑');
    else if (!result.lyrics.trim()) setInstrumental(true);
  }
  applySettings(); populateLyrics(); drawSpectrum(); savePrefs(); toast('已应用更多设置。');
});
on('helpButton', 'click', () => openDialog('helpDialog'));
on('generateButton', 'click', generate);
on('cancelRender', 'click', async () => { $('cancelRender').disabled = true; try { await rpc('cancelRender'); } finally { $('cancelRender').disabled = false; } });
on('showOutput', 'click', () => rpc('showOutput')); on('playOutput', 'click', () => rpc('openOutput'));
on('navOutput', 'click', () => { if (state.rendering) openDialog('renderDialog'); else if (state.output) { displayOutput(); openDialog('renderDialog'); } else toast('生成的作品会显示在这里。'); });
on('navCreate', 'click', () => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); });
document.addEventListener('keydown', event => { if (event.code === 'Space' && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName)) { event.preventDefault(); attempt(togglePlayback)(); } });

async function start() {
  applySettings();
  try {
    const initialThemeRevision = themeRevision;
    const data = await rpc('bootstrap');
    if (themeRevision === initialThemeRevision) SoftwareThemes.apply(data.softwareTheme, true);
    showDependencies(data.dependencies);
    Startup.finish();
    $('outputDirectory').value = prefs.outputDirectory || data.outputDirectory;
    $('outputDirectory').title = $('outputDirectory').value;
    if (data.background) loadBackground(data.background);
    if (data.audio) await loadAudio(data.audio);
    if (data.importError) toast(data.importError);
    if (data.batchAudio) await batchExporter.open(data.batchAudio);
    if (!data.dependencies.ready) openDialog('dependenciesDialog');
    else await deviceOptimizer.offer(true);
  } catch (error) { $('envTitle').textContent = '界面连接失败'; $('envSubtitle').textContent = '请使用桌面程序启动'; toast(error.message); }
  finally { Startup.finish(); }
}
let updateEncodingSummary, batchExporter, deviceOptimizer;
function applyExportEncoding(value, container) {
  prefs.encoding = EncodingSettings.validate(value, container); prefs.container = container;
  $('fileName').value = $('fileName').value.replace(/\.(mp4|mkv|mov|webm)$/i, '') + '.' + container;
  updateEncodingSummary?.();
}
(async () => {
  try {
    await EncodingSettings.loadDialog();
    updateEncodingSummary = EncodingSettings.mount({ get: () => prefs.encoding, getContainer: () => prefs.container, save: (value, container) => {
      applyExportEncoding(value, container); savePrefs();
    }, duration: () => state.audio?.duration || 0, toast, rpc });
    $('openEncodingPanel').disabled = false;
    deviceOptimizer = DeviceOptimizer.mount({ rpc, toast, editEncoding: updateEncodingSummary.edit,
      getTemplate: () => ({ encoding: prefs.encoding, container: prefs.container, resolution: prefs.resolution, fps: prefs.fps, maxParallel: 3, layout: composition, showSpectrum: prefs.showSpectrum }),
      isBusy: () => state.rendering || state.installing || batchExporter?.isRunning(),
      onBusy: active => { $('generateButton').disabled = active || batchExporter?.isRunning(); $('openBatch').disabled = active; $('openEncodingPanel').disabled = active; }
    });
    $('settingsDevice').addEventListener('click', attempt(() => deviceOptimizer.open()));
    batchExporter = BatchExporter.mount({ rpc, toast, editEncoding: updateEncodingSummary.edit, openDevice: value => deviceOptimizer.open(value),
      getTemplate: () => ({ encoding: prefs.encoding, layout: composition, resolution: prefs.resolution, fps: prefs.fps, volume: prefs.volume, brightness: prefs.brightness, fontSize: prefs.fontSize, showSpectrum: prefs.showSpectrum, outputDirectory: $('outputDirectory').value }),
      onRunning: active => { if (active) $('audio').pause(); $('generateButton').disabled = active; $('workspace').classList.toggle('busy', active); }
    });
    updateEncodingSummary();
    await start();
  } catch (error) { Startup.finish(); toast(error.message); }
})();
