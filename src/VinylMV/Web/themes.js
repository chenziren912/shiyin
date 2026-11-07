(function (root) {
  'use strict';
  const key = 'software-theme';
  const catalog = Object.freeze([
    { id: 'moss', name: '青苔绿', accent: '#c2dfa2' },
    { id: 'teal', name: '湖水青', accent: '#88d6c6' },
    { id: 'blue', name: '晴空蓝', accent: '#9cc8ff' },
    { id: 'indigo', name: '靛青蓝', accent: '#b4b8ff' },
    { id: 'purple', name: '鸢尾紫', accent: '#ceb0f4' },
    { id: 'pink', name: '樱花粉', accent: '#f2b4d1' },
    { id: 'amber', name: '琥珀金', accent: '#f0ce83' },
    { id: 'orange', name: '珊瑚橙', accent: '#f0b08e' },
    { id: 'red', name: '朱砂红', accent: '#f0a2a4' },
    { id: 'slate', name: '石墨灰', accent: '#c4ccd6' }
  ].map(Object.freeze));
  const mix = (a, b, amount) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
  const alpha = (hex, opacity) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')},${opacity})`;
  let current = catalog[0];
  const listeners = new Set();
  function colors(theme) {
    const accent = theme.accent;
    return {
      accent, 'accent-hover': mix(accent, '#ffffff', .2), 'on-accent': '#18201b',
      bg: theme.id === 'moss' ? '#111412' : mix('#101214', accent, .035),
      panel: mix('#17191b', accent, .055), 'panel-light': mix('#202224', accent, .065),
      field: mix('#0e1114', accent, .03), hover: mix('#282b2e', accent, .095),
      selected: mix('#202428', accent, .14), border: mix('#2b2e31', accent, .11),
      'border-strong': mix('#3d4145', accent, .16), track: mix('#303439', accent, .12),
      text: mix('#f1f2f3', accent, .06), 'text-secondary': mix('#c2c6ca', accent, .09),
      muted: mix('#a4aab1', accent, .065), faint: mix('#939aa2', accent, .04),
      'accent-soft': alpha(accent, .16), 'accent-glow': alpha(accent, .25),
      'accent-line': alpha(accent, .45), 'accent-faint': alpha(accent, .06),
      backdrop: 'rgba(4,7,10,.75)', 'warning': '#e6ba8b', 'danger': '#edaaaa'
    };
  }
  function apply(id, persist = false) {
    current = catalog.find(theme => theme.id === id) || catalog[0];
    const palette = colors(current), element = document.documentElement;
    element.dataset.theme = current.id;
    for (const [name, value] of Object.entries(palette)) element.style.setProperty('--' + name, value);
    element.style.setProperty('--green', palette.accent); element.style.setProperty('--green-dark', palette.selected);
    if (persist) { try { localStorage.setItem(key, current.id); } catch { /* Native settings still persist the choice. */ } }
    for (const update of listeners) update(current);
    return current;
  }
  function mount(container, onChoose) {
    const buttons = catalog.map(theme => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'theme-choice';
      button.dataset.theme = theme.id; button.setAttribute('role', 'radio');
      const swatch = document.createElement('span'); swatch.className = 'theme-swatch'; swatch.style.backgroundColor = theme.accent; swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.textContent = theme.name;
      button.append(swatch, label); container.append(button);
      button.addEventListener('click', () => { apply(theme.id, true); onChoose?.(theme.id); });
      return button;
    });
    const update = theme => {
      for (const button of buttons) { const active = button.dataset.theme === theme.id; button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1; }
      const label = document.getElementById('themeSelection'); if (label) label.textContent = '当前主题：' + theme.name;
    };
    listeners.add(update); update(current);
    container.addEventListener('keydown', event => {
      const index = buttons.indexOf(document.activeElement); if (index < 0) return;
      const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 9 : offset === undefined ? null : (index + offset + 10) % 10;
      if (next === null) return; event.preventDefault(); buttons[next].focus(); buttons[next].click();
    });
  }
  root.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(event.newValue); });
  root.SoftwareThemes = Object.freeze({ catalog, apply, mount, colors, get current() { return current; } });
  let stored; try { stored = localStorage.getItem(key); } catch { /* Start with the default theme. */ }
  apply(stored);
})(window);
