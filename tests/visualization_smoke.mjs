// Only use an isolated start_ui_test.ps1 instance with the generated 明暗背景.mp4.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import { openEditor, finishEditor } from './encoding_ui_helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
let browser;
for (let i = 0; i < 100; i++) {
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.VINYLMV_TEST_PORT); break; }
  catch (error) { if (i === 99) throw error; await new Promise(r => setTimeout(r, 300)); }
}
let main;
for (let i = 0; i < 100; i++) { main = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/index.html')); if (main) break; await new Promise(r => setTimeout(r, 200)); }
await main.waitForFunction(() => state.audio?.title === '湖畔来信' && state.dependencies?.ready && state.background?.path.includes('明暗背景'));
assert(await main.evaluate(() => !state.rendering && document.getElementById('audio').paused));
const directory = path.resolve(import.meta.dirname, '../.test-output/自动配色与样式界面', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const errors = []; main.on('pageerror', e => errors.push(e.message));
await main.locator('#brightness').fill('100'); await main.locator('#brightness').dispatchEvent('input');
let editor = await openEditor(main, browser);
editor.on('pageerror', e => errors.push(e.message));
async function details(name) { await editor.getByRole('button', { name, exact: true }).dblclick(); }
async function property(key, value) {
  const input = editor.locator(`#propertyFields [data-property="${key}"]`);
  const kind = await input.evaluate(e => e.tagName === 'SELECT' ? 'select' : e.type);
  if (kind === 'select') await input.selectOption(String(value));
  else if (kind === 'checkbox') await input.setChecked(value);
  else if (kind === 'color') await input.evaluate((e, value) => { e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  else { await input.fill(String(value)); await input.dispatchEvent('change'); }
}
async function seek(value) {
  await editor.locator('#frameSeek').fill(String(value)); await editor.locator('#frameSeek').dispatchEvent('input');
  await editor.waitForFunction(value => Math.abs(document.getElementById('backgroundVideo').currentTime - value) < .02 && !document.getElementById('backgroundVideo').seeking && document.getElementById('backgroundVideo').readyState >= 2 && document.getElementById('frameStatus').textContent.includes('当前为静态单帧'), value);
}
const palette = () => editor.locator('#lyricWindow').evaluate(e => ({ color: e.style.getPropertyValue('--lyric-color'), outline: e.style.getPropertyValue('--lyric-outline') }));
await seek(1); const darkBackground = await palette();
assert(parseInt(darkBackground.color.slice(1, 3), 16) > 220);
await seek(3); const lightBackground = await palette();
assert(parseInt(lightBackground.color.slice(1, 3), 16) < 40);
assert.notEqual(lightBackground.outline, darkBackground.outline);
await editor.screenshot({ path: path.join(directory, '自动识别亮背景.png') });
await details('歌词');
assert(await editor.locator('[data-property="color"]').isDisabled());
await property('autoColor', false); await property('color', '#abcdef');
assert.equal((await palette()).color, '#abcdef');
await property('autoColor', true);
assert.equal((await palette()).color, lightBackground.color);
await editor.locator('#doneProperties').click();
await details('音频曲线');
await property('bandCount', 64); await property('fftSize', 4096); await property('smoothing', 0);
await property('attack', .04); await property('release', .5); await property('minFrequency', 80); await property('maxFrequency', 8000);
for (const [kind, moves, curves] of [['curve', 1, 63], ['mirror', 2, 126], ['bars', 64, 0]]) {
  await property('visualization', kind);
  await editor.waitForFunction(() => document.getElementById('frameStatus').textContent.includes('当前为静态单帧'));
  const drawing = await editor.locator('#spectrumPath').getAttribute('d');
  assert.equal((drawing.match(/M /g) || []).length, moves);
  assert.equal((drawing.match(/C /g) || []).length, curves);
  assert(await editor.evaluate(() => Math.max(...levels) > .1));
}
await property('barGap', 40);
assert.equal(await editor.evaluate(() => card('spectrum').barGap), .4);
assert(await editor.locator('[data-property="thickness"]').isHidden());
await editor.screenshot({ path: path.join(directory, '音频详细参数.png') });
await editor.locator('#doneProperties').click();
const frozen = await editor.evaluate(() => ({ seconds, video: document.getElementById('backgroundVideo').currentTime, path: document.getElementById('spectrumPath').getAttribute('d') }));
await editor.waitForTimeout(450);
assert.deepEqual(await editor.evaluate(() => ({ seconds, video: document.getElementById('backgroundVideo').currentTime, path: document.getElementById('spectrumPath').getAttribute('d') })), frozen);
assert(await editor.evaluate(() => document.getElementById('backgroundVideo').paused && !document.querySelector('audio')));
await finishEditor(editor);
await main.waitForFunction(() => Composition.get(composition, 'spectrum').visualization === 'bars');
assert.equal(await main.evaluate(() => JSON.parse(localStorage.getItem('preferences')).layout.cards.find(c => c.id === 'spectrum').fftSize), 4096);
await main.locator('#playButton').click();
await main.waitForFunction(() => Math.max(...state.spectrumLevels) > .1);
assert.equal(await main.evaluate(() => state.spectrumLevels.length), 64);
assert.equal(await main.evaluate(() => state.analyser.fftSize), 4096);
await main.locator('#playButton').click();
editor = await openEditor(main, browser);
assert.equal(await editor.evaluate(() => card('spectrum').barGap), .4);
assert(await editor.evaluate(() => card('lyrics').autoColor));
await editor.locator('#resetLayout').click(); await finishEditor(editor, false);
assert.equal(await main.evaluate(() => Composition.get(composition, 'spectrum').visualization), 'bars');
await main.locator('#resolution').selectOption('480'); await main.locator('#fps').selectOption('24');
await main.locator('#outputDirectory').evaluate((e, d) => { e.value = d; }, directory);
await main.locator('#fileName').fill('自动配色与柱状图.mp4');
await main.locator('#generateButton').click();
await main.waitForFunction(() => document.getElementById('renderTitle').textContent !== '正在生成作品', null, { timeout: 120000 });
assert.equal(await main.locator('#renderTitle').innerText(), '你的作品，完成了', await main.locator('#renderMessage').innerText());
const output = await main.locator('#renderPath').innerText();
const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
assert.equal(metadata.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
assert(Math.abs(+metadata.format.duration - 8) < .15);
await main.locator('#renderDialog [data-close]').first().click();
editor = await openEditor(main, browser); await editor.locator('#resetLayout').click(); await finishEditor(editor);
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, darkBackground, lightBackground, output, errors }, null, 2));
console.log('自动配色、三种音频样式、参数保存与真实导出通过：' + directory);
process.exit(0);
