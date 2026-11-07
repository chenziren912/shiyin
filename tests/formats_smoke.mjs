// Real WebView2 preview and export from synthetic format fixtures only.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let browser;
for (let attempt = 0; attempt < 100; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT || 9231}`); break; }
  catch (error) { if (attempt === 99) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
}
let page;
for (let attempt = 0; attempt < 100; attempt++) {
  page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html'));
  if (page) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
assert(page);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.waitForFunction(() => typeof state !== 'undefined' && state.audio && state.background && !document.getElementById('mediaImportDialog').open, null, { timeout: 60000 });
const info = await page.evaluate(() => ({ audio: state.audio, video: state.background }));
assert(info.audio.path.includes('多格式素材') && info.video.path.includes('多格式素材'), '仅使用独立的合成素材');
const expectedAudio = process.argv[2] || 'WMA';
assert.equal(info.audio.format, expectedAudio);
assert.match(await page.locator('#audioMeta').innerText(), new RegExp(expectedAudio));
assert.equal(info.audio.duration > 7.8 && info.audio.duration < 8.5, true);
assert.equal(info.audio.localLyrics.includes('月光'), true);
await page.waitForFunction(() => document.getElementById('audio').readyState >= 2 && document.getElementById('backgroundVideo').readyState >= 2, null, { timeout: 30000 });
assert.deepEqual(await page.evaluate(() => ({ audio: document.getElementById('audio').error?.message, video: document.getElementById('backgroundVideo').error?.message })), { audio: undefined, video: undefined });
await page.locator('#volume').fill('0'); await page.locator('#volume').dispatchEvent('input');
await page.locator('#playButton').click();
await page.waitForFunction(() => document.getElementById('audio').currentTime > .6 && Math.max(...state.spectrumLevels) > .1);
await page.locator('#playButton').click();
await page.locator('#seek').fill('4.8'); await page.locator('#seek').dispatchEvent('input'); await page.locator('#seek').dispatchEvent('change');
await page.waitForFunction(() => document.getElementById('previewClock').textContent.startsWith('00:04'));
const directory = path.resolve(import.meta.dirname, '../.test-output/多格式界面', Date.now().toString());
await fs.mkdir(directory, { recursive: true });
await page.screenshot({ path: path.join(directory, '格式预览.png') });

if (process.argv.includes('--editor')) {
  await page.locator('#moreSettings').click();
  let editor;
  for (let attempt = 0; attempt < 100; attempt++) {
    editor = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/editor.html'));
    if (editor) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(editor);
  editor.on('pageerror', error => errors.push(error.message));
  await editor.waitForFunction(() => document.getElementById('backgroundVideo').readyState >= 2);
  await editor.locator('#frameSeek').fill('3'); await editor.locator('#frameSeek').dispatchEvent('input');
  await editor.waitForFunction(() => document.getElementById('backgroundVideo').paused && document.getElementById('backgroundVideo').currentTime > .5);
  await Promise.all([editor.waitForEvent('close'), editor.locator('#cancelEditor').click()]);
}

let output;
if (!process.argv.includes('--preview-only')) {
  await page.locator('#volume').fill('100'); await page.locator('#volume').dispatchEvent('input');
  await page.locator('#resolution').selectOption('480'); await page.locator('#fps').selectOption('24');
  await page.locator('#fileName').fill('多格式界面导出.mp4');
  await page.locator('#outputDirectory').evaluate((element, value) => { element.value = value; }, directory);
  await page.evaluate(() => { const original = rpc; rpc = (action, payload) => { if (action === 'render') window.testRenderRequest = structuredClone(payload); return original(action, payload); }; });
  await page.locator('#generateButton').click();
  await page.waitForFunction(() => document.getElementById('renderTitle').textContent !== '正在生成作品', null, { timeout: 120000 });
  assert.equal(await page.locator('#renderTitle').innerText(), '你的作品，完成了', await page.locator('#renderMessage').innerText());
  output = await page.locator('#renderPath').innerText();
  const request = await page.evaluate(() => window.testRenderRequest);
  assert.equal(request.audioPath, info.audio.path); assert.equal(request.backgroundPath, info.video.path);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
  assert.equal(probe.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
  assert.equal(probe.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
  assert(Math.abs(Number(probe.format.duration) - info.audio.duration) < .2);
}
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, info, output, errors }, null, 2));
console.log(`${info.audio.format} / ${info.video.format} 原生预览、播放、拖动、真实频谱${output ? '与原始素材导出' : ''}通过：${directory}`);
await browser.close();
