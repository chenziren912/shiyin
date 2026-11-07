(function () {
  'use strict';
  const root = document.documentElement, screen = document.getElementById('startupScreen');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const began = performance.now();
  let phase = 'starting', completion;
  const fallback = setTimeout(() => finish(), 5000);
  function finish() {
    if (completion) return completion;
    clearTimeout(fallback);
    phase = 'finishing';
    completion = new Promise(resolve => {
      setTimeout(() => {
        screen.classList.add('startup-leaving'); screen.setAttribute('aria-hidden', 'true');
        root.classList.remove('startup-pending'); root.classList.add('startup-entering');
        setTimeout(() => {
          screen.remove(); root.classList.remove('startup-entering'); phase = 'ready';
          document.dispatchEvent(new CustomEvent('startup-ready')); resolve();
        }, reduced ? 0 : 460);
      }, reduced ? 0 : Math.max(0, 540 - (performance.now() - began)));
    });
    return completion;
  }
  document.getElementById('startupClose').addEventListener('click', () => {
    window.chrome?.webview?.postMessage({ id: 'startup-close', action: 'windowClose', payload: {} });
  });
  screen.addEventListener('mousedown', event => {
    if (event.button === 0 && !event.target.closest('button'))
      window.chrome?.webview?.postMessage({ id: 'startup-drag', action: 'windowDrag', payload: {} });
  });
  window.Startup = { finish, get phase() { return phase; } };
})();
