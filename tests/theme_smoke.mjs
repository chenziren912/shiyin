// Only use a fresh, isolated copy created by start_ui_test.ps1.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = Number(process.env.VINYLMV_TEST_PORT), app = path.resolve(process.env.VINYLMV_TEST_APP || '');
const testRoot = path.resolve(import.meta.dirname, '../.test-output');
assert(port && app.startsWith(testRoot + path.sep) && path.basename(path.dirname(app)).startsWith('界面验证-') && path.basename(app) === 'VinylMV.exe', '必须提供独立测试程序路径与端口');
const directory = path.join(testRoot, '主题界面', String(Date.now())); await fs.mkdir(directory, { recursive: true });
const errors = [];
let browser, main;
async function connect() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }); break; }
    catch (error) { if (attempt === 119) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  for (let attempt = 0; attempt < 300; attempt++) {
    main = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html'));
    if (main) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(main); main.setDefaultTimeout(60000); main.on('pageerror', error => errors.push(error.message));
  await main.waitForFunction(() => typeof state !== 'undefined' && state.audio?.title === '湖畔来信' && state.dependencies?.ready && window.Startup?.phase === 'ready', null, { timeout: 120000 });
  assert(await main.evaluate(() => !state.rendering && !batchExporter.isRunning() && !deviceOptimizer.isRunning()));
}
const rgb = hex => `rgb(${[1,3,5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
function contrast(first, second) {
  const luminance = text => text.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
const videoStyle = () => main.evaluate(() => ({
  layout: JSON.stringify(composition),
  preview: ['.vinyl', '.record-label', '.song-caption strong', '.song-caption span', '#previewClock', '.video-progress', '.video-progress span', '#audioSpectrum path'].map(selector => {
    const value = getComputedStyle(document.querySelector(selector)); return [selector, value.color, value.backgroundColor, value.backgroundImage, value.stroke];
  })
}));
await connect();
const media = await main.evaluate(() => ({ audio: state.audio.path, background: state.background.path }));
await main.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
await main.locator('#openSettings').click();
assert.equal(await main.locator('#themeChoices [role=radio]').count(), 10);
const catalog = await main.evaluate(() => SoftwareThemes.catalog), before = await videoStyle(), themes = [];
for (const theme of catalog) {
  await main.locator(`#themeChoices [data-theme=${theme.id}]`).click();
  const saved = await main.evaluate(() => themeSaveTask);
  assert.equal(saved.id, theme.id); assert.equal(saved.accent, theme.accent);
  await main.waitForFunction(({ accent, background }) => getComputedStyle(document.querySelector('#generateButton')).backgroundColor === accent && getComputedStyle(document.documentElement).backgroundColor === background,
    { accent: rgb(theme.accent), background: rgb(saved.background) });
  assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(app), 'software-theme.json'), 'utf8')).theme, theme.id);
  assert.equal(await main.locator('#themeChoices [aria-checked=true]').count(), 1);
  assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), theme.id);
  const style = await main.evaluate(() => {
    const read = selector => { const value = getComputedStyle(document.querySelector(selector)); return { color: value.color, background: value.backgroundColor }; };
    return { id: document.documentElement.dataset.theme, accent: SoftwareThemes.current.accent, bg: getComputedStyle(document.documentElement).backgroundColor,
      button: read('#generateButton'), modal: read('#settingsDialog'), hint: read('.theme-settings>p'), sidebar: read('.sidebar') };
  });
  assert.equal(style.id, theme.id); assert.equal(style.button.background, rgb(theme.accent)); assert.equal(style.bg, rgb(saved.background));
  assert(contrast(style.button.color, style.button.background) >= 4.5, theme.name + ' 主按钮文字对比');
  assert(contrast(style.modal.color, style.modal.background) >= 4.5, theme.name + ' 弹窗文字对比');
  assert(contrast(style.hint.color, style.modal.background) >= 4.5, theme.name + ' 设置说明文字对比');
  assert.deepEqual(await videoStyle(), before, '软件主题保持视频画面与卡片配置');
  themes.push(style);
  if (['moss','blue','purple','orange','slate'].includes(theme.id)) await main.screenshot({ path: path.join(directory, theme.name + '.png') });
}
assert.equal(new Set(themes.map(theme => theme.button.background)).size, 10);
await main.locator('#themeChoices [aria-checked=true]').focus(); await main.keyboard.press('ArrowRight');
assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), catalog[0].id);
await main.keyboard.press('ArrowDown'); assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), catalog[5].id);
await main.keyboard.press('Home'); await main.keyboard.press('End');
assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), catalog[9].id);
await main.locator('#themeChoices [data-theme=purple]').click(); await main.evaluate(() => themeSaveTask);
await main.locator('#settingsDialog .modal-actions [data-close]').click();
await main.locator('#openEncodingPanel').click();
assert.equal(await main.locator('#encodingDialog').evaluate(element => getComputedStyle(element).backgroundColor), themes[4].modal.background);
await main.locator('#encodingDialog button[data-close]').last().click();
await main.locator('#openBatch').click(); await main.locator('#batchExportSettings').click();
assert.equal(await main.locator('#batchSettingsDialog').evaluate(element => getComputedStyle(element).backgroundColor), themes[4].modal.background);
await main.locator('#batchSettingsDialog button[data-close]').last().click(); await main.locator('#batchDialog > .modal-heading [data-close]').click();
await main.locator('#moreSettings').click();
let editor;
for (let attempt = 0; attempt < 100; attempt++) { editor = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/editor.html')); if (editor) break; await new Promise(resolve => setTimeout(resolve, 100)); }
assert(editor); editor.on('pageerror', error => errors.push(error.message));
await editor.waitForFunction(() => document.querySelectorAll('#cardList .card-list-row').length === 6);
assert.equal(await editor.evaluate(() => document.documentElement.dataset.theme), 'purple');
assert.equal(await editor.locator('#applyEditor').evaluate(element => getComputedStyle(element).backgroundColor), rgb(catalog[4].accent));
await editor.screenshot({ path: path.join(directory, '更多设置继承主题.png') });
await editor.locator('#cancelEditor').click();
const rejected = await main.evaluate(async () => { try { await rpc('setSoftwareTheme', { theme: 'invalid' }); return false; } catch (error) { return error.message; } });
assert.match(rejected, /主题/);
// A broken browser cache falls back safely; native preferences restore the saved theme.
await main.evaluate(() => localStorage.setItem('software-theme', 'broken-cache'));
await main.reload(); await main.waitForFunction(() => Startup.phase === 'ready' && state.dependencies?.ready);
assert.equal(await main.evaluate(() => SoftwareThemes.current.id), 'purple');
await main.locator('#openSettings').click(); assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), 'purple');
await main.locator('#settingsDialog .modal-actions [data-close]').click();

// Restart exactly this isolated test executable to verify disk persistence as well as page reload.
const closed = main.waitForEvent('close'); await main.evaluate(() => chrome.webview.postMessage({ id: 'theme-test-close', action: 'windowClose', payload: {} })); await closed;
await browser.close();
for (let attempt = 0; attempt < 100; attempt++) { try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); await new Promise(resolve => setTimeout(resolve, 100)); } catch { break; } }
const child = spawn(app, [media.audio, '--background', media.background], { cwd: path.dirname(app), windowsHide: true, stdio: 'ignore', detached: true, env: { ...process.env,
  VINYLMV_TEST_MODE: '1', VINYLMV_DEVTOOLS: '1', WEBVIEW2_USER_DATA_FOLDER: path.join(path.dirname(app), 'webview-test-profile'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` } });
child.on('error', error => { throw error; }); child.unref();
await connect(); assert.equal(await main.evaluate(() => SoftwareThemes.current.id), 'purple');
await main.locator('#openSettings').click(); assert.equal(await main.locator('#themeChoices [aria-checked=true]').getAttribute('data-theme'), 'purple');
await main.screenshot({ path: path.join(directory, '重启保留主题.png') });
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, themes, restartedPid: child.pid, errors }, null, 2));
console.log('十种主题、即时应用、键盘、文字对比、弹窗与编辑器、原画面保留、重载及真实重启验证通过：' + directory);
await browser.close();
