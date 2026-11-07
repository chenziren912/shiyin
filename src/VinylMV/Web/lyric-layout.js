(function (root) {
  'use strict';
  const eastAsian = '\\u1100-\\u115f\\u2329\\u232a\\u2e80-\\ua4cf\\uac00-\\ud7a3\\uf900-\\ufaff\\ufe10-\\ufe6f\\uff01-\\uff60\\uffe0-\\uffe6\\u{1f000}-\\u{1faff}';
  const tokens = new RegExp(`\\s+|[${eastAsian}]|[^\\s${eastAsian}]+`, 'gu');

  function wrapWords(text, maximum, measure) {
    return text.split('\n').flatMap(original => {
      const output = [];
      let current = '', separator = '';
      for (const token of original.match(tokens) || []) {
        if (/^\s+$/u.test(token)) { separator = current ? ' ' : ''; continue; }
        const candidate = current + separator + token;
        if (current && measure(candidate) > maximum) { output.push(current); current = token; }
        else current = candidate;
        separator = '';
      }
      output.push(current);
      return output;
    }).join('\n');
  }

  function fitLyric(text, size, maximum, maximumHeight, measure) {
    maximum *= .97;
    const maximumLines = Math.max(2, text.split('\n').length);
    let wrapped = text;
    for (let attempt = 0; attempt < 160; attempt++) {
      wrapped = wrapWords(text, maximum, value => measure(value, size));
      const lines = wrapped.split('\n');
      if (lines.length <= maximumLines && lines.length * size * 1.4 <= maximumHeight && lines.every(line => measure(line, size) <= maximum)) return { text: wrapped, fontSize: size };
      size *= .94;
    }
    return { text: wrapped, fontSize: size };
  }

  const api = { wrapWords, fitLyric };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LyricLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
