// Run only against an isolated start_ui_test.ps1 instance with the synthetic batch fixture.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const port = Number(process.env.VINYLMV_TEST_PORT), app = path.resolve(process.env.VINYLMV_TEST_APP || '');
const root = path.resolve(import.meta.dirname, '..');
assert(port && app.startsWith(path.join(root, '.test-output', '界面验证-')));
const fixture = JSON.parse(await fs.readFile(path.join(root, '.test-output/ai-fixture-current.json'), 'utf8'));
const directory = path.join(root, '.test-output/AI背景界面', String(Date.now())); await fs.mkdir(directory, { recursive: true });
const control = async (scenario, reset = true) => { const result = await fetch(fixture.control, { method: 'POST', body: JSON.stringify({ scenario, reset }) }); assert(result.ok); };
const status = async () => (await fetch(fixture.status)).json();
let browser, page;
for (let attempt = 0; attempt < 120; attempt++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch (error) { if (attempt === 119) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); } }
for (let attempt = 0; attempt < 300; attempt++) { page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
assert(page); page.setDefaultTimeout(60000);
await page.waitForFunction(() => typeof state !== 'undefined' && state.dependencies?.ready && window.Startup?.phase === 'ready' && document.querySelectorAll('#batchRows tr').length === 4);
assert(await page.evaluate(() => !state.rendering && !batchExporter.isRunning()));
const errors = [], events = []; page.on('pageerror', error => errors.push(error.message));
await page.evaluate(() => {
  window.aiQa = { events: [], totals: [] };
  chrome.webview.addEventListener('message', ({ data }) => { if (data.event === 'batchProgress') { aiQa.events.push(data.data); aiQa.totals.push(document.getElementById('batchTotalProgress').value); } });
  const send = chrome.webview.postMessage.bind(chrome.webview);
  chrome.webview.postMessage = message => { if (message.action === 'planBatch') window.aiQa.audio = message.payload.rows.map(row => row.audio); send(message); };
});
await page.locator('#batchAssign').click(); await page.waitForFunction(() => window.aiQa.audio?.length === 4);
const imported = await page.evaluate(() => aiQa.audio); assert(imported.every(item => item.path.includes('批量素材')));
const row = index => page.locator('#batchRows tr').nth(index);
const input = key => page.locator(`[data-ai-field="${key}"]`);
const tab = name => page.locator(`[data-ai-tab="${name}"]`).click();
const idle = () => page.waitForFunction(() => !batchExporter.isRunning() && !document.getElementById('batchAssign').disabled, null, { timeout: 240000 });
await control('async');
await page.locator('#batchAiSettings').click(); await page.locator('#aiVideoDialog').waitFor({ state: 'visible' });
assert.equal(await page.locator('[data-ai-tab]').count(), 6);
assert.equal(await input('enabled').isChecked(), false);
await input('enabled').check(); await input('baseUrl').fill(fixture.baseUrl); await input('apiKey').fill('fixture-key'); await input('model').fill('fixture-video');
await page.locator('#aiReadModels').click(); await page.waitForFunction(() => document.querySelectorAll('#aiVideoModels option').length === 2);
await page.screenshot({ path: path.join(directory, '接口与策略.png') });
await tab('picture'); await input('seconds').fill('4'); await input('scene').fill('安静的月光湖畔，远处森林倒影和缓慢漂移的薄雾');
await tab('runtime'); await input('pollSeconds').fill('1'); await input('directory').evaluate((element, value) => { element.value = value; }, path.join(path.dirname(app), 'generated-backgrounds'));
await tab('optimizer'); await input('optimize').check(); await input('optimizerModel').fill('fixture-text');
await tab('prompt'); await page.locator('#aiPreviewDraft').click(); await page.locator('#aiPromptDialog').waitFor({ state: 'visible' });
await page.waitForFunction(() => document.getElementById('aiPromptText').value.length > 100 && !document.getElementById('aiPromptText').disabled);
assert.match(await page.locator('#aiPromptText').inputValue(), /negative space|Reserve/);
assert.equal((await status()).creates, 0, '预览不创建视频任务');
await page.locator('#aiPromptOptimize').click(); await page.waitForFunction(() => !document.getElementById('aiPromptText').disabled && document.getElementById('aiPromptStatus').textContent.includes('优化完成'));
assert.match(await page.locator('#aiPromptText').inputValue(), /quiet moonlit/);
await page.screenshot({ path: path.join(directory, '提示词预览.png') });
await page.locator('#aiPromptDialog [data-prompt-close]').first().click();
await page.locator('#aiVideoSave').click(); await page.locator('#aiVideoDialog').waitFor({ state: 'hidden' });
assert.equal((await page.evaluate(() => rpc('getAiVideoSettings'))).hasApiKey, true);
assert(!(await fs.readFile(path.join(path.dirname(app), 'ai-video-settings.dat'))).includes(Buffer.from('fixture-key')));
assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('fixture-key'));
await page.locator('#batchAiSettings').click(); await tab('runtime'); await input('maxConcurrent').fill('7');
await page.locator('#aiVideoDialog [data-ai-close]').first().click();
await page.locator('#batchAiSettings').click(); assert.equal(await input('maxConcurrent').inputValue(), '2', '取消不保存草稿');
await tab('advanced'); await page.screenshot({ path: path.join(directory, '高级接口.png') });
await page.locator('#aiVideoDialog [data-ai-close]').first().click();
// Reload the real WebView, restore the synthetic queue, and verify native encrypted settings remain active.
await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && state.dependencies?.ready && window.Startup?.phase === 'ready');
await page.evaluate(items => batchExporter.open({ items, errors: [] }), imported); await idle();
await page.locator('#batchAiSettings').click(); assert.equal(await input('enabled').isChecked(), true); assert.equal(await input('apiKey').inputValue(), ''); assert.match(await input('apiKey').getAttribute('placeholder'), /已保存/);
await page.locator('#aiVideoDialog [data-ai-close]').first().click();
await page.locator('#batchExportSettings').click(); await page.locator('#batchSearchLyrics').uncheck(); await page.locator('#batchAutoEncoder').uncheck(); await page.locator('#batchSettingsApply').click(); await idle();
for (let index = 2; index < 4; index++) await row(index).locator('td:first-child input').uncheck();
await page.locator('#batchResolution').selectOption('480'); await page.locator('#batchFps').selectOption('24'); await page.locator('#batchApplySettings').click(); await idle();
await page.locator('#batchOutputDirectory').evaluate((element, value) => { element.value = value; }, directory);
async function exportSelected() {
  await page.locator('#batchStart').click();
  await page.waitForFunction(() => batchExporter.isRunning());
  await idle();
  assert.equal(await page.locator('#batchError').innerText(), '');
}
await control('async'); await exportSelected();
assert.equal(await page.locator('.batch-status[data-status=completed]').count(), 2);
let remote = await status(); assert.equal(remote.creates, 2); assert.equal(remote.optimized, 2); assert(remote.peak <= 2); assert.equal(remote.cdnAuth, false);
await page.screenshot({ path: path.join(directory, 'AI背景批量完成.png') });
const outputs = (await fs.readdir(directory)).filter(name => name.endsWith('.mp4'));
assert.equal(outputs.length, 2);
for (const file of outputs) { const info = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,width,height','-show_entries','format=duration','-of','json',path.join(directory,file)], { encoding: 'utf8' })); assert(info.streams.some(stream => stream.codec_name === 'h264' && stream.height === 480)); assert(Math.abs(Number(info.format.duration) - 2) < .2); }
const library = await page.evaluate(() => rpc('getVideoLibrary')); assert(library.filter(video => video.id.startsWith('ai-')).length === 2);
await page.locator('#batchRemove').click(); await page.evaluate(items => batchExporter.open({ items, errors: [] }), imported.slice(0, 2)); await idle();
await exportSelected(); remote = await status(); assert.equal(remote.creates, 2, '重复导出复用背景'); assert.equal(remote.optimized, 2, '复用时不重新调用文字模型');
// Cancellation and continuation use new song context to avoid the completed cache.
await page.locator('#batchAiSettings').click(); await tab('runtime'); await input('reuseCache').uncheck(); await page.locator('#aiVideoSave').click(); await page.locator('#aiVideoDialog').waitFor({ state: 'hidden' });
await page.locator('#batchRemove').click(); await page.evaluate(items => batchExporter.open({ items, errors: [] }), imported.slice(0, 2)); await idle();
await control('pending'); await page.locator('#batchStart').click();
await page.waitForFunction(() => document.querySelectorAll('.batch-status[data-status=ai_generating]').length > 0);
await new Promise(resolve => setTimeout(resolve, 1000));
await page.locator('#batchStop').click(); await idle();
assert.equal(await page.locator('.batch-status[data-status=cancelled]').count(), 2);
const beforeResume = await status(); assert(beforeResume.creates > 0);
await control('async', false); await exportSelected(); remote = await status(); assert.equal(remote.creates, 2, '已提交任务继续查询，未提交的歌曲各创建一次');
assert.equal(await page.locator('.batch-status[data-status=completed]').count(), 2);
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, remote, outputs, errors }, null, 2));
console.log('AI 配置、提示词预览与优化、密钥保存、真实批量 MV、缓存、取消及继续查询验证通过：' + directory);
await browser.close();
