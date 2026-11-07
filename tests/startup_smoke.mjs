// 仅连接 start_ui_test.ps1 创建的隔离窗口；不操作正式安装或用户窗口。
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = process.env.VINYLMV_TEST_PORT;
assert(port, '请设置独立测试窗口的 VINYLMV_TEST_PORT');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html'));
assert(page, '真实 WebView2 主页面存在');
await page.waitForFunction(() => window.Startup?.phase === 'ready');
assert(await page.evaluate(() => !state.rendering && !batchExporter.isRunning()), '测试窗口没有活动导出');
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const directory = path.resolve(import.meta.dirname, '../.test-output/启动动效验证', String(Date.now()));
await fs.mkdir(directory, { recursive: true });

await page.addInitScript(() => {
  const mode = sessionStorage.getItem('startup-qa-mode');
  const metrics = window.startupQa = { mode, readyEvents: 0 };
  const bridge = window.chrome.webview, original = bridge.postMessage.bind(bridge);
  let bootstrapId;
  bridge.postMessage = message => {
    if (message.action !== 'bootstrap') return original(message);
    bootstrapId = message.id;
    if (mode === 'fallback') return;
    if (mode === 'error') throw new Error('启动连接异常验证');
    if (mode === 'normal') setTimeout(() => original(message), 900);
    else original(message);
  };
  bridge.addEventListener('message', ({ data }) => {
    if (!data.event && data.id === bootstrapId) metrics.bootstrapAt = performance.now();
  });
  document.addEventListener('DOMContentLoaded', () => {
    metrics.initial = {
      animation: getComputedStyle(document.querySelector('.startup-record')).animationName,
      opacity: getComputedStyle(document.querySelector('.app-shell')).opacity,
      close: !!document.getElementById('startupClose')
    };
  });
  document.addEventListener('startup-ready', () => {
    metrics.readyEvents++; metrics.readyAt = performance.now();
  });
});

async function reload(mode, reduced = false) {
  await page.evaluate(mode => sessionStorage.setItem('startup-qa-mode', mode), mode);
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.reload({ waitUntil: 'domcontentloaded' });
}
async function ready() {
  await page.waitForFunction(() => window.Startup?.phase === 'ready', null, { timeout: 10000 });
  assert.equal(await page.locator('#startupScreen').count(), 0, '启动层在完成后移除');
  assert.equal(await page.locator('html').getAttribute('class'), '', '过渡状态清除');
  assert.equal(await page.locator('.app-shell').evaluate(element => getComputedStyle(element).opacity), '1');
  const metrics = await page.evaluate(() => window.startupQa);
  assert.equal(metrics.readyEvents, 1, '完成通知只触发一次');
  return metrics;
}

await reload('normal');
assert(await page.locator('#startupScreen').isVisible());
await page.waitForTimeout(220);
const before = await page.locator('.startup-record').evaluate(element => getComputedStyle(element).transform);
await page.waitForTimeout(140);
assert.notEqual(await page.locator('.startup-record').evaluate(element => getComputedStyle(element).transform), before, '黑胶实际旋转');
await page.screenshot({ path: path.join(directory, '启动画面.png') });
const normal = await ready();
assert.equal(normal.initial.animation, 'startup-spin');
assert.equal(normal.initial.opacity, '0');
assert(normal.initial.close);
await page.locator('#openSettings').click();
assert(await page.locator('#settingsDialog').isVisible(), '过渡后按钮可交互');
await page.locator('#settingsDialog [data-close]').first().click();
await page.screenshot({ path: path.join(directory, '进入工作台.png') });

await reload('reduced', true);
const reduced = await ready();
assert.equal(reduced.initial.animation, 'none', '减少动画时不旋转');
assert(reduced.readyAt - reduced.bootstrapAt < 250, '减少动画时不强制等待过渡');

await reload('fallback');
const fallback = await ready();
assert(fallback.readyAt >= 5000 && fallback.readyAt < 6500, '无启动响应时超时解除覆盖');
await page.locator('#helpButton').click();
assert(await page.locator('#helpDialog').isVisible(), '超时后可访问界面');
await page.locator('#helpDialog [data-close]').first().click();

await reload('error');
const error = await ready();
assert.equal(await page.locator('#envTitle').innerText(), '界面连接失败');
assert(error.readyAt < 1500, '连接失败时正常退出启动层');
assert.deepEqual(errors, [], '没有未处理页面异常');

// 恢复正常启动，避免留下人为设置的错误状态。
await reload('restored');
await ready();
await page.waitForFunction(() => document.getElementById('envTitle').textContent === '渲染环境已就绪');
await page.evaluate(() => sessionStorage.removeItem('startup-qa-mode'));
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, normal, reduced, fallback, error, errors }, null, 2));
if (process.argv.includes('--close')) {
  await reload('normal');
  const closed = page.waitForEvent('close', { timeout: 10000 });
  await page.locator('#startupClose').click();
  await closed;
}
console.log('真实 WebView2 启动、旋转、淡入、减少动画、超时和异常检查通过：' + directory);
process.exit(0);
