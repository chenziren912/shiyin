(function (root) {
  'use strict';
  const names = { record: '黑胶', caption: '歌曲信息', lyrics: '歌词', clock: '时间', spectrum: '音频曲线', progress: '播放进度条' };
  function defaults(fontSize = 44) {
    return { version: 1, cards: [
      { id: 'record', type: 'record', enabled: true, x: .1115625, y: .13, width: .286875, height: .51, coverRatio: .43, spinSeconds: 20 },
      { id: 'caption', type: 'caption', enabled: true, x: .051, y: .70, width: .408, height: .11, fontSize: 38, color: '#edf2e7', artistColor: '#b4b8af', title: '', artist: '' },
      { id: 'lyrics', type: 'lyrics', enabled: true, x: .425, y: .15, width: .55, height: .59, fontSize, color: '#e8f5f0', nearColor: '#a4b4ad', dimColor: '#6d786f', autoColor: true, lineSpacing: 2.6, align: 'center', bold: true },
      { id: 'clock', type: 'clock', enabled: true, x: .715, y: .06, width: .22, height: .05, fontSize: 22, color: '#b4b8af', backgroundColor: '#142019', format: 'elapsed-total', style: 'plain', align: 'right' },
      { id: 'spectrum', type: 'spectrum', enabled: true, x: .065, y: .87625, width: .87, height: .075, color: '#c2dfa2', thickness: 2.8, gain: 1, linked: true, visualization: 'curve', bandCount: 48, fftSize: 1024, smoothing: 2, attack: .06, release: .18, minFrequency: 40, maxFrequency: 10000, barGap: .25 },
      { id: 'progress', type: 'progress', enabled: true, x: .065, y: .93, width: .87, height: .02, color: '#c0e4b4', trackColor: '#505c49', thickness: 3 }
    ] };
  }
  function normalize(value, fontSize = 44) {
    const result = defaults(fontSize);
    for (const card of result.cards) {
      const source = value?.cards?.find?.(c => c?.id === card.id) || {};
      for (const [key, fallback] of Object.entries(card)) {
        const candidate = source[key];
        if (['id', 'type'].includes(key) || candidate === undefined) continue;
        if (typeof fallback === 'boolean') card[key] = typeof candidate === 'boolean' ? candidate : fallback;
        else if (typeof fallback === 'number') card[key] = Number.isFinite(candidate) ? candidate : fallback;
        else if (key.toLowerCase().endsWith('color')) card[key] = /^#[\da-f]{6}$/i.test(candidate) ? candidate : fallback;
        else if (['title', 'artist'].includes(key)) card[key] = String(candidate).slice(0, 500);
        else {
          const allowed = { align: ['left', 'center', 'right'], format: ['elapsed-total', 'elapsed', 'remaining-total', 'total', 'hours'], style: ['plain', 'pill'], visualization: ['curve', 'mirror', 'bars'] };
          card[key] = allowed[key]?.includes(candidate) ? candidate : fallback;
        }
      }
      card.width = Math.max(.03, Math.min(1, card.width)); card.height = Math.max(.01, Math.min(1, card.height));
      if (card.type === 'record') {
        card.width = Math.min(.5625, card.width); card.height = card.width * 16 / 9;
        card.coverRatio = Math.max(.1, Math.min(.95, card.coverRatio)); card.spinSeconds = Math.max(2, Math.min(120, card.spinSeconds));
      }
      for (const [key, low, high] of [['fontSize', 8, 200], ['thickness', .5, 30], ['gain', .1, 4], ['lineSpacing', 1.5, 5]]) if (key in card) card[key] = Math.max(low, Math.min(high, card[key]));
      if (card.type === 'spectrum') {
        for (const [key, low, high] of [['bandCount', 16, 192], ['smoothing', 0, 4], ['attack', .01, .5], ['release', .03, 1], ['minFrequency', 20, 1000], ['maxFrequency', 1100, 12000], ['barGap', 0, .9]]) card[key] = Math.max(low, Math.min(high, card[key]));
        card.bandCount = Math.round(card.bandCount); card.smoothing = Math.round(card.smoothing);
        if (![512, 1024, 2048, 4096].includes(card.fftSize)) card.fftSize = 1024;
      }
      card.x = Math.max(0, Math.min(1 - card.width, card.x)); card.y = Math.max(0, Math.min(1 - card.height, card.y));
    }
    const spectrum = get(result, 'spectrum'), bar = get(result, 'progress');
    if (spectrum.linked) Object.assign(spectrum, { x: bar.x, width: bar.width, y: bar.y + bar.height / 2 - spectrum.height * (spectrum.visualization === 'mirror' ? 1 : .85) });
    return result;
  }
  function get(layout, id) { return layout.cards.find(c => c.id === id); }
  function rect(element, card) {
    Object.assign(element.style, { left: `${card.x * 100}%`, top: `${card.y * 100}%`, width: `${card.width * 100}%`, height: `${card.height * 100}%`, right: 'auto', bottom: 'auto' });
    element.toggleAttribute('hidden', !card.enabled);
  }
  function spacing(card) { return Math.max(card.fontSize * card.lineSpacing, 1080 * card.height * .156); }
  function formatTime(seconds, duration, format = 'elapsed-total') {
    const stamp = (value, hours = false) => {
      value = Math.max(0, Math.floor(value || 0));
      return (hours ? `${String(Math.floor(value / 3600)).padStart(2, '0')}:` : '') + `${String(Math.floor(value / 60) % (hours ? 60 : Infinity)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    };
    if (format === 'elapsed') return stamp(seconds);
    if (format === 'total') return stamp(duration);
    if (format === 'remaining-total') return `-${stamp(Math.ceil(Math.max(0, duration - seconds)))} / ${stamp(Math.ceil(duration))}`;
    return `${stamp(seconds, format === 'hours')} / ${stamp(duration, format === 'hours')}`;
  }
  function apply(preview, layout, audio = {}) {
    preview.classList.add('custom-composition');
    const find = id => preview.querySelector('#' + id);
    const record = get(layout, 'record'), caption = get(layout, 'caption'), lyrics = get(layout, 'lyrics'), time = get(layout, 'clock'), spectrum = get(layout, 'spectrum'), bar = get(layout, 'progress');
    rect(find('vinyl'), record);
    const shadow = preview.querySelector('.record-shadow'); rect(shadow, record);
    find('recordLabel').style.width = find('recordLabel').style.height = `${record.coverRatio * 100}%`;
    find('vinyl').style.animationDuration = `${record.spinSeconds}s`;
    rect(preview.querySelector('.song-caption'), caption);
    find('previewTitle').textContent = caption.title || audio.title || '你的音乐，即将响起';
    find('previewArtist').textContent = caption.artist || audio.artist || '未知歌手';
    find('previewTitle').style.fontSize = `${caption.fontSize / 19.2}cqw`; find('previewTitle').style.color = caption.color;
    find('previewArtist').style.fontSize = `${caption.fontSize * 22 / 38 / 19.2}cqw`; find('previewArtist').style.color = caption.artistColor;
    const context = document.createElement('canvas').getContext('2d');
    for (const [id, original, weight] of [['previewTitle', caption.fontSize, 700], ['previewArtist', caption.fontSize * 22 / 38, 400]]) {
      let size = original;
      while (size > .5) { context.font = `${weight} ${size}px "Microsoft YaHei"`; if (context.measureText(find(id).textContent).width <= caption.width * 1920 * .97) break; size *= .95; }
      find(id).style.fontSize = `${size / 19.2}cqw`;
    }
    rect(find('lyricWindow'), lyrics);
    find('lyricLines').style.setProperty('--line-gap', `${spacing(lyrics) / 19.2}cqw`);
    find('lyricWindow').style.setProperty('--lyric-color', lyrics.color); find('lyricWindow').style.setProperty('--near-color', lyrics.nearColor); find('lyricWindow').style.setProperty('--dim-color', lyrics.dimColor);
    find('lyricWindow').style.setProperty('--active-weight', lyrics.bold ? 700 : 400);
    find('lyricLines').style.textAlign = lyrics.align;
    rect(find('previewClock'), time);
    Object.assign(find('previewClock').style, { fontSize: `${time.fontSize / 19.2}cqw`, color: time.color, justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[time.align], background: time.style === 'pill' ? time.backgroundColor + 'bf' : 'transparent', borderRadius: time.style === 'pill' ? '.7cqw' : '0' });
    const progress = preview.querySelector('.video-progress'); rect(progress, bar);
    progress.style.background = 'transparent';
    progress.style.setProperty('--bar-height', `${bar.thickness / 19.2}cqw`); progress.style.setProperty('--track-color', bar.trackColor);
    find('videoProgressFill').style.background = bar.color;
    rect(find('audioSpectrum'), spectrum);
    find('audioSpectrum').setAttribute('viewBox', `0 0 ${spectrum.width * 1920} ${spectrum.height * 1080}`);
    find('spectrumPath').style.stroke = spectrum.visualization === 'bars' ? 'none' : spectrum.color;
    find('spectrumPath').style.fill = spectrum.visualization === 'bars' ? spectrum.color : 'none'; find('spectrumPath').style.fillOpacity = .906; find('spectrumPath').style.strokeWidth = spectrum.thickness;
  }
  // Compare the lower contrast percentile, so small highlights do not dominate a scene.
  function autoPalette(pixels, brightness = 100) {
    const samples = [], mean = [0, 0, 0], factor = Math.max(0, Math.min(100, brightness)) / 100 * .76;
    const luminance = rgb => rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    for (let i = 0; i + 2 < pixels.length; i += 4) {
      const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]].map(v => v / 255), gray = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      const adjusted = rgb.map((v, index) => { const value = (gray + (v - gray) * .8) * factor; mean[index] += value; return value; });
      samples.push(luminance(adjusted));
    }
    if (!samples.length) return { color: '#edf4ee', nearColor: '#b8c9bf', dimColor: '#91a69a', outline: '#101810' };
    mean.forEach((_, i) => { mean[i] /= samples.length; });
    const max = Math.max(...mean), min = Math.min(...mean), delta = max - min;
    let hue = delta < .015 ? 120 : max === mean[0] ? ((mean[1] - mean[2]) / delta) * 60 : max === mean[1] ? ((mean[2] - mean[0]) / delta + 2) * 60 : ((mean[0] - mean[1]) / delta + 4) * 60;
    hue = Math.floor(((hue + 540) % 360) / 30 + .5) * 30 % 360;
    function tint(lightness) {
      const chroma = (1 - Math.abs(2 * lightness - 1)) * .22, x = chroma * (1 - Math.abs(hue / 60 % 2 - 1)), m = lightness - chroma / 2;
      return [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue / 60)].map(v => v + m);
    }
    const score = rgb => { const l = luminance(rgb); const ratios = samples.map(v => (Math.max(v, l) + .05) / (Math.min(v, l) + .05)).sort((a, b) => a - b); return ratios[Math.floor((ratios.length - 1) * .2)]; };
    const dark = score(tint(.075)) > score(tint(.95));
    const hex = lightness => '#' + tint(lightness).map(v => Math.floor(v * 255 + .5).toString(16).padStart(2, '0')).join('');
    return { color: hex(dark ? .075 : .95), nearColor: hex(dark ? .15 : .83), dimColor: hex(dark ? .22 : .72), outline: dark ? '#f3f5ef' : '#101810' };
  }
  const colorCache = new WeakMap();
  function updateLyricColors(preview, layout, brightness) {
    const lyric = get(layout, 'lyrics'), element = preview.querySelector('#lyricWindow'), video = preview.querySelector('#backgroundVideo');
    element.style.setProperty('--lyric-outline', '#101810');
    if (!lyric.autoColor) {
      for (const [key, variable] of [['color', '--lyric-color'], ['nearColor', '--near-color'], ['dimColor', '--dim-color']]) element.style.setProperty(variable, lyric[key]);
      return;
    }
    const key = JSON.stringify([video.currentSrc, Math.floor(video.currentTime * 2), brightness, lyric.x, lyric.y, lyric.width, lyric.height]);
    let cached = colorCache.get(preview);
    if (cached?.key !== key) {
      let pixels = new Uint8ClampedArray([25, 37, 31, 255]);
      if (video.readyState >= 2 && !video.seeking && video.videoWidth) {
        const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 27;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }), scale = Math.max(1920 / video.videoWidth, 1080 / video.videoHeight);
        try {
          ctx.drawImage(video, ((video.videoWidth * scale - 1920) / 2 + lyric.x * 1920) / scale, ((video.videoHeight * scale - 1080) / 2 + lyric.y * 1080) / scale, lyric.width * 1920 / scale, lyric.height * 1080 / scale, 0, 0, 48, 27);
          pixels = ctx.getImageData(0, 0, 48, 27).data;
        } catch { return; }
      } else if (video.currentSrc) return;
      cached = { key, palette: autoPalette(pixels, brightness) }; colorCache.set(preview, cached);
    }
    const palette = cached.palette;
    for (const [key, variable] of [['color', '--lyric-color'], ['nearColor', '--near-color'], ['dimColor', '--dim-color'], ['outline', '--lyric-outline']]) element.style.setProperty(variable, palette[key]);
  }
  const api = { names, defaults, normalize, get, rect, spacing, formatTime, apply, autoPalette, updateLyricColors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Composition = api;
})(typeof window !== 'undefined' ? window : globalThis);
