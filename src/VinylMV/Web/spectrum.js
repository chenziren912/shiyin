/* Shared audio analysis and smooth curve / mirrored curve / bar geometry. */
(function (root) {
  'use strict';
  const BAND_COUNT = 48;
  const LOW_FREQUENCY = 40;
  const HIGH_FREQUENCY = 10000;
  const MIN_DB = -72;
  const MAX_DB = -12;

  function frequencyBands(decibels, sampleRate, fftSize, options = {}) {
    const count = options.bandCount || BAND_COUNT, minimum = options.minFrequency || LOW_FREQUENCY;
    const bands = new Float64Array(count);
    const maximum = Math.min(options.maxFrequency || HIGH_FREQUENCY, sampleRate / 2);
    for (let index = 0; index < count; index++) {
      const low = minimum * (maximum / minimum) ** (index / count);
      const high = minimum * (maximum / minimum) ** ((index + 1) / count);
      const first = Math.min(decibels.length - 1, Math.max(1, Math.floor(low * fftSize / sampleRate)));
      const last = Math.min(decibels.length, Math.max(first + 1, Math.ceil(high * fftSize / sampleRate)));
      let peak = -Infinity;
      for (let bin = first; bin < last; bin++) peak = Math.max(peak, decibels[bin]);
      bands[index] = Number.isFinite(peak) ? Math.max(0, Math.min(1, (peak - MIN_DB) / (MAX_DB - MIN_DB))) : 0;
    }
    return bands;
  }

  function smoothBands(bands, previous, seconds, options = {}) {
    let values = Float64Array.from(bands);
    // Spatial smoothing removes narrow FFT spikes before cubic interpolation.
    for (let pass = 0; pass < (options.smoothing ?? 2); pass++) {
      const next = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const at = offset => values[Math.max(0, Math.min(values.length - 1, i + offset))];
        next[i] = (at(-2) + 4 * at(-1) + 6 * at(0) + 4 * at(1) + at(2)) / 16;
      }
      values = next;
    }
    const elapsed = Math.max(0, Math.min(.25, seconds));
    for (let i = 0; i < values.length; i++) {
      const alpha = 1 - Math.exp(-elapsed / (values[i] > previous[i] ? (options.attack || .06) : (options.release || .18)));
      previous[i] += (values[i] - previous[i]) * alpha;
    }
    return previous;
  }

  function curvePoints(values, width, height) {
    const baseline = height * .85;
    return Array.from(values, (value, i) => {
      const position = i / (values.length - 1);
      const taper = i === 0 || i === values.length - 1 ? 0 : Math.sin(Math.PI * position) ** .4;
      return [position * width, baseline - Math.max(0, Math.min(1, value)) * taper * height * .72];
    });
  }

  function curveSegments(points) {
    const differences = points.slice(1).map((point, i) => point[1] - points[i][1]);
    const slopes = points.map((_, i) => {
      if (i === 0 || i === points.length - 1) return 0;
      const before = differences[i - 1], after = differences[i];
      return before * after <= 0 ? 0 : 2 * before * after / (before + after);
    });
    return points.slice(1).map((point, i) => {
      const previous = points[i], third = (point[0] - previous[0]) / 3;
      return [previous[0] + third, previous[1] + slopes[i] / 3, point[0] - third, point[1] - slopes[i + 1] / 3, point[0], point[1]];
    });
  }

  function path(values, width = 1000, height = 80, options = {}) {
    const number = value => Number(value.toFixed(3));
    if (options.visualization === 'bars') {
      const step = width / values.length, gap = step * (options.barGap ?? .25), baseline = height * .85;
      return Array.from(values, (value, i) => {
        const x = number(i * step + gap / 2), right = number((i + 1) * step - gap / 2), y = number(baseline - Math.max(0, Math.min(1, value)) * height * .72);
        return `M ${x} ${number(baseline)} L ${x} ${y} L ${right} ${y} L ${right} ${number(baseline)} Z`;
      }).join(' ');
    }
    const points = curvePoints(values, width, height), mirrored = options.visualization === 'mirror';
    if (mirrored) for (const point of points) point[1] = height / 2 - (height * .85 - point[1]) * .5 / .72 * .88;
    const draw = points => `M ${points[0].map(number).join(' ')} ` + curveSegments(points).map(segment => `C ${segment.map(number).join(' ')}`).join(' ');
    return draw(points) + (mirrored ? ' ' + draw(points.map(([x, y]) => [x, height - y])) : '');
  }

  function analyzeSamples(samples, options = {}) {
    const size = options.fftSize || 1024, bits = Math.log2(size), previous = new Float64Array(options.bandCount || BAND_COUNT);
    const reverse = Array.from({ length: size }, (_, i) => parseInt(i.toString(2).padStart(bits, '0').split('').reverse().join(''), 2));
    const window = Array.from({ length: size }, (_, i) => .42 - .5 * Math.cos(2 * Math.PI * i / size) + .08 * Math.cos(4 * Math.PI * i / size));
    for (let end = Math.min(400, samples.length); end <= samples.length && end > 0; end = Math.min(samples.length, end + 400)) {
      const real = new Float64Array(size), imaginary = new Float64Array(size);
      for (let i = 0; i < size; i++) { const index = end - size + reverse[i]; real[i] = (index >= 0 ? samples[index] : 0) * window[reverse[i]]; }
      for (let step = 2; step <= size; step *= 2) {
        const half = step / 2;
        for (let start = 0; start < size; start += step) for (let offset = 0; offset < half; offset++) {
          const angle = -2 * Math.PI * offset / step, cosine = Math.cos(angle), sine = Math.sin(angle);
          const a = start + offset, b = a + half;
          const r = real[b] * cosine - imaginary[b] * sine, im = real[b] * sine + imaginary[b] * cosine;
          real[b] = real[a] - r; imaginary[b] = imaginary[a] - im; real[a] += r; imaginary[a] += im;
        }
      }
      const db = Array.from({ length: size / 2 }, (_, i) => 20 * Math.log10(Math.max(Math.hypot(real[i], imaginary[i]) / size, 1e-12)));
      smoothBands(frequencyBands(db, 24000, size, options), previous, 1 / 60, options);
      if (end === samples.length) break;
    }
    return previous;
  }

  const api = { BAND_COUNT, frequencyBands, smoothBands, curvePoints, curveSegments, path, analyzeSamples };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioSpectrum = api;
})(typeof window !== 'undefined' ? window : globalThis);
