(function (root) {
  'use strict';
  const defaults = { schemaVersion: 2, codec: 'h264', encoder: 'software', rateControl: 'crf', crf: 20, bitrateMbps: 8, maxBitrateMbps: 0, bufferSeconds: 2, preset: 'veryfast', profile: 'auto', pixelFormat: 'auto', tune: 'auto', keyframeSeconds: 0, bFrames: 3, threads: 0, audioCodec: 'auto', audioBitrateKbps: 256, sampleRate: 0, channels: 0, fastStart: true, proresProfile: 3, ffv1Level: 3, lookahead: 0, spatialAq: false, multipass: 'disabled', vorbisQuality: 5 };
  const presets = { ultrafast: '极速', superfast: '超快', veryfast: '很快', faster: '较快', fast: '快速', medium: '均衡', slow: '慢速', slower: '较慢', veryslow: '很慢' };
  const codecs = { h264: 'H.264', hevc: 'H.265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', prores: 'ProRes', ffv1: 'FFV1' };
  const software = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1', vp9: 'libvpx-vp9', vp8: 'libvpx', prores: 'prores_ks', ffv1: 'ffv1' };
  const backends = { software: '处理器软件编码', nvenc: '英伟达 NVENC', qsv: '英特尔 QSV', amf: 'AMD AMF' };
  const videoContainers = { h264: ['mp4', 'mkv', 'mov'], hevc: ['mp4', 'mkv', 'mov'], av1: ['mp4', 'mkv', 'webm'], vp9: ['mp4', 'mkv', 'webm'], vp8: ['mkv', 'webm'], prores: ['mov', 'mkv'], ffv1: ['mkv'] };
  const audioContainers = { mp4: ['aac', 'mp3', 'alac'], mov: ['aac', 'mp3', 'alac', 'pcm16', 'pcm24'], mkv: ['aac', 'opus', 'mp3', 'flac', 'pcm16', 'pcm24', 'vorbis'], webm: ['opus', 'vorbis'] };
  const audioNames = { aac: 'AAC', opus: 'Opus', mp3: 'MP3', flac: 'FLAC', alac: 'ALAC', pcm16: 'PCM 16 位', pcm24: 'PCM 24 位', vorbis: 'Vorbis' };
  const audioEncoders = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame', flac: 'flac', alac: 'alac', pcm16: 'pcm_s16le', pcm24: 'pcm_s24le', vorbis: 'libvorbis' };
  const ranges = { crf: [0, 63, '画质值'], bitrateMbps: [.1, 200, '目标码率'], maxBitrateMbps: [0, 300, '峰值码率'], bufferSeconds: [.1, 30, '缓冲时长'], keyframeSeconds: [0, 30, '关键帧间隔'], bFrames: [0, 8, '双向预测帧'], threads: [0, 64, '编码线程数'], audioBitrateKbps: [32, 512, '音频码率'], lookahead: [0, 32, '前瞻帧数'], vorbisQuality: [0, 10, 'Vorbis 音频质量'] };
  const choices = { schemaVersion: [2], codec: Object.keys(codecs), encoder: Object.keys(backends), rateControl: ['crf', 'vbr', 'cbr'], preset: Object.keys(presets), profile: ['auto', 'baseline', 'main', 'high', 'main10'], pixelFormat: ['auto', 'yuv420p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'], tune: ['auto', 'film', 'animation', 'grain', 'stillimage', 'zerolatency'], audioCodec: ['auto', ...Object.keys(audioNames)], sampleRate: [0, 22050, 32000, 44100, 48000, 88200, 96000], channels: [0, 1, 2], proresProfile: [0, 1, 2, 3, 4, 5], ffv1Level: [1, 3], multipass: ['disabled', 'qres', 'fullres'] };
  const isSpecial = s => ['prores', 'ffv1'].includes(s.codec);
  const audioCodec = (s, container) => s.audioCodec === 'auto' ? container === 'webm' ? 'opus' : 'aac' : s.audioCodec;
  const encoderName = s => s.encoder === 'software' ? software[s.codec] : s.codec + '_' + s.encoder;
  const profiles = s => s.codec === 'h264' ? ['auto', 'baseline', 'main', 'high'] : s.codec === 'hevc' ? ['auto', 'main', 'main10'] : ['auto'];
  const pixels = s => s.codec === 'prores' ? [s.proresProfile >= 4 ? 'yuv444p10le' : 'yuv422p10le'] : s.codec === 'ffv1' ? s.ffv1Level === 1 ? ['yuv420p'] : ['yuv420p', 'yuv422p10le', 'yuv444p10le'] : ['hevc', 'av1', 'vp9'].includes(s.codec) ? ['yuv420p', 'yuv420p10le'] : ['yuv420p'];
  const tunes = s => s.encoder !== 'software' ? ['auto'] : s.codec === 'h264' ? choices.tune : s.codec === 'hevc' ? ['auto', 'animation', 'grain', 'zerolatency'] : ['auto'];
  function validate(value, container) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编码设置格式无效。');
    const s = { ...defaults, ...value };
    for (const [key, [low, high, name]] of Object.entries(ranges)) if (!Number.isFinite(s[key]) || s[key] < low || s[key] > high) throw new Error(`${name}应在 ${low} 到 ${high} 之间。`);
    for (const [key, allowed] of Object.entries(choices)) if (!allowed.includes(s[key])) throw new Error('编码选项无效：' + key);
    for (const key of ['bFrames', 'threads', 'audioBitrateKbps', 'lookahead']) if (!Number.isInteger(s[key])) throw new Error('帧数、线程数和音频码率必须为整数。');
    if (typeof s.fastStart !== 'boolean' || typeof s.spatialAq !== 'boolean') throw new Error('开关选项无效。');
    if (s.crf > (['av1', 'vp9', 'vp8'].includes(s.codec) && s.encoder === 'software' ? 63 : 51)) throw new Error('此编码器的画质值不能大于 51。');
    if (s.encoder !== 'software' && !['h264', 'hevc', 'av1'].includes(s.codec)) throw new Error('所选视频编码不支持此硬件编码器。');
    if (s.codec === 'av1' && s.encoder === 'software' && s.rateControl === 'cbr') throw new Error('AV1 软件编码请使用恒定画质或动态平均码率。');
    if (!profiles(s).includes(s.profile)) throw new Error('所选视频编码不支持此编码规格。');
    if (s.pixelFormat !== 'auto' && !pixels(s).includes(s.pixelFormat)) throw new Error('所选编码或规格不支持此像素格式。');
    if (s.codec === 'hevc' && s.profile === 'main' && s.pixelFormat === 'yuv420p10le') throw new Error('10 位 H.265 请使用自动或主要 10 位规格。');
    if (!tunes(s).includes(s.tune)) throw new Error('所选编码器不支持此调优方式。');
    if (!isSpecial(s) && !(s.codec === 'av1' && s.encoder === 'software') && s.rateControl === 'vbr' && s.maxBitrateMbps && s.maxBitrateMbps < s.bitrateMbps) throw new Error('峰值码率不能小于目标码率。');
    if (s.codec === 'h264' && s.profile === 'baseline') s.bFrames = 0;
    if (container !== undefined) {
      if (!audioContainers[container] || !videoContainers[s.codec].includes(container)) throw new Error('视频编码与文件格式不兼容。');
      const audio = audioCodec(s, container);
      if (!audioContainers[container].includes(audio)) throw new Error('音频编码与文件格式不兼容。');
      if (audio === 'mp3' && (s.audioBitrateKbps > 320 || s.sampleRate > 48000)) throw new Error('MP3 最高支持 320 kbps 和 48 kHz。');
      if (audio === 'opus' && s.channels === 1 && s.audioBitrateKbps > 256) throw new Error('单声道 Opus 码率不能超过 256 kbps。');
    }
    return Object.fromEntries(Object.keys(defaults).map(key => [key, s[key]]));
  }
  function normalize(value) { try { return validate(value || {}); } catch { return { ...defaults }; } }
  function forContainer(value, container) {
    const s = normalize(value);
    if (!videoContainers[s.codec].includes(container)) Object.assign(s, { codec: container === 'webm' ? 'vp9' : 'h264', encoder: 'software', profile: 'auto', pixelFormat: 'auto', tune: 'auto' });
    if (!['av1', 'vp9', 'vp8'].includes(s.codec) && s.crf > 51) s.crf = 20;
    if (!audioContainers[container].includes(audioCodec(s, container))) s.audioCodec = 'auto';
    return s;
  }
  function summary(s, container = 'mp4') {
    const mode = s.codec === 'ffv1' ? '无损' : s.codec === 'prores' ? ['代理', '轻量', '标准', '高质量', '4444', '4444 高质量'][s.proresProfile] : s.rateControl === 'crf' ? '恒定画质 ' + s.crf : (s.rateControl === 'vbr' ? '动态' : '固定') + ' ' + s.bitrateMbps + ' Mbps';
    return `${codecs[s.codec]} · ${mode}${isSpecial(s) ? '' : ' · ' + presets[s.preset]}${s.encoder === 'software' ? '' : ' · ' + backends[s.encoder]} · ${audioNames[audioCodec(s, container)]}`;
  }
  let dialogLoading;
  async function loadDialog() {
    if (document.getElementById('encodingDialog')) return;
    if (!dialogLoading) dialogLoading = (async () => {
      const response = await fetch('encoding-dialog.html');
      if (!response.ok) throw new Error('编码设置组件未能加载，请重新安装程序。');
      const template = document.createElement('template'); template.innerHTML = await response.text();
      if (!template.content.querySelector('dialog#encodingDialog')) throw new Error('编码设置组件不完整，请重新安装程序。');
      document.body.append(template.content);
    })().catch(error => { dialogLoading = null; throw error; });
    return dialogLoading;
  }
  function mount({ get, save, duration, toast, rpc, getContainer = () => 'mp4' }) {
    const $ = id => document.getElementById(id), dialog = $('encodingDialog');
    const inputs = [...dialog.querySelectorAll('[data-encoding]')];
    for (const button of dialog.querySelectorAll('[data-close="encodingDialog"]')) button.addEventListener('click', () => dialog.close());
    const description = dialog.querySelector('.modal-description'), normalDescription = description.textContent;
    let commit = save, capabilities, detecting = false, detectionError = '';
    const available = name => capabilities?.encoders[name]?.available;
    function read() {
      const value = { ...defaults };
      for (const input of inputs) {
        const key = input.dataset.encoding;
        value[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' || input.dataset.number !== undefined ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
        if (input.disabled && typeof value[key] === 'number' && !Number.isFinite(value[key])) value[key] = defaults[key];
      }
      return value;
    }
    function write(s) { for (const input of inputs) { if (input.type === 'checkbox') input.checked = s[input.dataset.encoding]; else input.value = s[input.dataset.encoding]; } refresh(); }
    async function detect(force = false) {
      if (detecting || capabilities && !force) return;
      detecting = true; detectionError = ''; refresh();
      try { capabilities = await rpc('getEncodingCapabilities', { refresh: force }); }
      catch (error) { detectionError = error.message; }
      finally { detecting = false; refresh(); }
    }
    function edit(value, onSave = save, explanation = normalDescription, context = {}) {
      commit = onSave; $('encContainer').value = context.container || getContainer();
      write(forContainer(value, $('encContainer').value)); $('encodingError').textContent = ''; description.textContent = explanation; dialog.showModal(); detect();
    }
    function show(id, active) { const input = $(id); input.closest('label').hidden = !active; input.disabled = !active; }
    function refresh() {
      const s = read(), container = $('encContainer').value, special = isSpecial(s), audio = audioCodec(s, container);
      for (const option of $('encCodec').options) option.disabled = !videoContainers[option.value].includes(container);
      for (const option of $('encEncoder').options) {
        const name = option.value === 'software' ? software[s.codec] : s.codec + '_' + option.value;
        const unsupported = option.value !== 'software' && !['h264', 'hevc', 'av1'].includes(s.codec);
        option.disabled = unsupported || (option.value !== 'software' ? available(name) !== true : available(name) === false);
        option.textContent = backends[option.value] + (unsupported ? ' · 不适用' : available(name) === false ? ' · 不可用' : option.value !== 'software' && !capabilities ? ' · 待检测' : '');
        option.title = capabilities?.encoders[name]?.detail || '';
      }
      for (const option of $('encAudioCodec').options) option.disabled = option.value !== 'auto' && (!audioContainers[container].includes(option.value) || available(audioEncoders[option.value]) === false);
      for (const option of $('encProfile').options) option.disabled = !profiles(s).includes(option.value);
      if (!profiles(s).includes(s.profile)) { $('encProfile').value = s.profile = 'auto'; }
      for (const option of $('encPixelFormat').options) option.disabled = option.value !== 'auto' && !pixels(s).includes(option.value);
      if (s.pixelFormat !== 'auto' && !pixels(s).includes(s.pixelFormat)) $('encPixelFormat').value = 'auto';
      for (const option of $('encTune').options) option.disabled = !tunes(s).includes(option.value);
      if (!tunes(s).includes(s.tune)) $('encTune').value = 'auto';
      $('encMode').querySelector('[value=cbr]').disabled = s.codec === 'av1' && s.encoder === 'software';
      if (s.codec === 'av1' && s.encoder === 'software' && s.rateControl === 'cbr') $('encMode').value = s.rateControl = 'vbr';
      show('encMode', !special); show('encCrf', !special && s.rateControl === 'crf');
      show('encBitrate', !special && (s.rateControl !== 'crf' || s.codec === 'vp8'));
      show('encMaxBitrate', !special && s.rateControl !== 'cbr' && !(s.encoder === 'qsv' && s.rateControl === 'crf') && !(s.codec === 'av1' && s.encoder === 'software' && s.rateControl === 'vbr'));
      show('encBuffer', !special); $('encBuffer').disabled = special || s.rateControl !== 'cbr' && !s.maxBitrateMbps || s.encoder === 'qsv' && s.rateControl === 'crf' || s.codec === 'av1' && s.encoder === 'software' && s.rateControl === 'vbr';
      show('encPreset', !special); show('encProfile', ['h264', 'hevc'].includes(s.codec));
      show('encTune', s.encoder === 'software' && ['h264', 'hevc'].includes(s.codec));
      show('encKeyframe', !special); show('encBFrames', ['h264', 'hevc'].includes(s.codec) && s.encoder !== 'amf');
      if (s.codec === 'h264' && s.profile === 'baseline') { $('encBFrames').value = 0; $('encBFrames').disabled = true; }
      show('encThreads', s.encoder === 'software'); show('encProresProfile', s.codec === 'prores'); show('encFfv1Level', s.codec === 'ffv1');
      for (const id of ['encLookahead', 'encSpatialAq', 'encMultipass']) show(id, s.encoder === 'nvenc');
      show('encFastStart', ['mp4', 'mov'].includes(container));
      show('encAudioBitrate', !['flac', 'alac', 'pcm16', 'pcm24', 'vorbis'].includes(audio));
      show('encVorbisQuality', audio === 'vorbis');
      $('encSampleRate').disabled = audio === 'opus'; if (audio === 'opus') $('encSampleRate').value = '48000';
      $('encCrf').max = ['av1', 'vp9', 'vp8'].includes(s.codec) && s.encoder === 'software' ? '63' : '51';
      $('encodingQualityHint').textContent = s.encoder === 'amf' ? '使用固定量化参数；数值越低画质越高。' : `范围 0–${$('encCrf').max}，数值越低画质越高。不同编码器的数值不可直接比较。`;
      $('encodingModeHint').textContent = special ? s.codec === 'ffv1' ? '无损保存合成后的画面，文件可能较大；不使用目标码率或画质值。' : '适合后期剪辑，使用 ProRes 规格控制质量和体积；不使用目标码率或画质值。' : s.rateControl === 'crf' ? (s.encoder === 'qsv' ? '使用硬件质量控制，码率随画面复杂度变化；峰值限制不适用。' : s.codec === 'vp8' ? 'VP8 使用画质值与目标码率共同控制输出。' : '根据画面复杂度动态分配码率。数值越低画质越高，文件通常越大。') : s.rateControl === 'vbr' ? '指定目标平均码率，峰值填 0 表示不额外限制。' : '以固定目标约束码率；实际短时码率仍可能波动。';
      const status = capabilities?.encoders[encoderName(s)];
      $('encodingCapabilities').textContent = detecting ? '正在检测本机编码器与硬件可用性…' : detectionError || (status ? `${encoderName(s)}：${status.detail}。` : '打开弹窗后检测本机编码能力。');
      $('refreshEncoders').disabled = detecting;
      $('applyEncoding').disabled = available(encoderName(s)) === false || s.encoder !== 'software' && available(encoderName(s)) !== true || available(audioEncoders[audio]) === false;
      $('encodingEstimate').textContent = special || s.rateControl === 'crf' || ['flac', 'alac', 'pcm16', 'pcm24', 'vorbis'].includes(audio) ? '文件大小由实际画面、音频及编码质量决定。' : !duration() ? '导入音频后显示预计文件大小。' : Number.isFinite(s.bitrateMbps) ? `预计约 ${((s.bitrateMbps + s.audioBitrateKbps / 1000) * duration() / 8).toFixed(1)} MB（实际大小略有差异）` : '请输入有效码率。';
    }
    for (const id of ['openEncoding', 'openEncodingPanel']) $(id)?.addEventListener('click', () => edit(get()));
    $('resetEncoding').addEventListener('click', () => { write(forContainer(defaults, $('encContainer').value)); $('encodingError').textContent = ''; });
    $('encContainer').addEventListener('change', () => { write(forContainer(read(), $('encContainer').value)); });
    $('refreshEncoders').addEventListener('click', () => detect(true));
    for (const input of inputs) input.addEventListener('input', () => {
      if (input.id === 'encCodec') {
        $('encProfile').value = 'auto'; $('encPixelFormat').value = 'auto'; $('encTune').value = 'auto';
        if (!['h264', 'hevc', 'av1'].includes(input.value)) $('encEncoder').value = 'software';
        if (Number($('encCrf').value) > 51 && !['av1', 'vp9', 'vp8'].includes(input.value)) $('encCrf').value = '20';
      }
      if (input.id === 'encProfile' && input.value === 'main10') $('encPixelFormat').value = 'yuv420p10le';
      if (input.id === 'encEncoder' && input.value !== 'software' && Number($('encCrf').value) > 51) $('encCrf').value = '20';
      refresh();
    });
    $('applyEncoding').addEventListener('click', () => {
      try { const container = $('encContainer').value, s = validate(read(), container); commit(s, container); dialog.close(); toast('已应用导出编码设置。'); }
      catch (error) { $('encodingError').textContent = error.message; }
    });
    const update = () => {
      const s = forContainer(get(), getContainer());
      if ($('encodingSummary')) $('encodingSummary').textContent = summary(s, getContainer());
      if ($('outputCodec')) $('outputCodec').textContent = `${codecs[s.codec]} / ${audioNames[audioCodec(s, getContainer())]}`;
      if ($('outputContainer')) $('outputContainer').textContent = (getContainer() === 'webm' ? 'WebM' : getContainer().toUpperCase()) + ' 视频';
    };
    update.edit = edit;
    return update;
  }
  const api = { defaults, presets, codecs, software, backends, audioNames, validate, normalize, forContainer, summary, loadDialog, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EncodingSettings = api;
})(typeof window !== 'undefined' ? window : globalThis);
