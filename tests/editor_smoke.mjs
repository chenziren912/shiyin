// Run only against an isolated test instance from start_ui_test.ps1.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), directory = path.join(root, '.test-output', '卡片编辑验证');
await fs.mkdir(directory, { recursive: true });
let browser;
for (let attempt = 0; attempt < 100; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT || 9225}`); break; }
  catch (error) { if (attempt === 99) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
}
const pages = () => browser.contexts().flatMap(c => c.pages());
let main;
for (let attempt = 0; attempt < 100; attempt++) { main = pages().find(p => p.url().endsWith('/index.html')); if (main) break; await new Promise(resolve => setTimeout(resolve, 200)); }
assert(main);
await main.waitForFunction(() => state.audio?.title === '湖畔来信' && state.dependencies?.ready, null, { timeout: 30000 });
assert(await main.evaluate(() => !state.rendering && state.audio?.title === '湖畔来信'), '仅测试独立合成素材窗口');
await main.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
const errors = [];
main.on('pageerror', e => errors.push(e.message));
async function getEditor() {
  for (let i = 0; i < 100; i++) { const page = pages().find(p => p.url().endsWith('/editor.html')); if (page) { page.on('pageerror', e => errors.push(e.message)); await page.waitForFunction(() => document.getElementById('cardList').children.length === 6); return page; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('没有打开独立编辑窗口');
}
let editor = pages().find(p => p.url().endsWith('/editor.html'));
if (!editor) await main.locator('#moreSettings').click();
editor = await getEditor();
const readCard = id => editor.evaluate(id => ({ ...card(id) }), id);
async function details(name) { await editor.getByRole('button', { name, exact: true }).dblclick(); await editor.locator('#cardDialog').waitFor({ state: 'visible' }); }
async function property(key, value) {
  const input = editor.locator(`#propertyFields [data-property="${key}"]`);
  if (await input.evaluate(e => e.tagName === 'SELECT')) await input.selectOption(value);
  else if (await input.evaluate(e => e.type === 'color')) await input.evaluate((e, value) => { e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  else if (await input.evaluate(e => e.type === 'checkbox')) await input.setChecked(value);
  else { await input.fill(String(value)); await input.dispatchEvent('change'); }
}
await editor.locator('#frameSeek').fill('4.8'); await editor.locator('#frameSeek').dispatchEvent('input');
await editor.waitForFunction(() => document.getElementById('frameStatus').textContent.includes('当前为静态单帧'), null, { timeout: 15000 });
const frozen = await editor.evaluate(() => ({ time: seconds, video: document.getElementById('backgroundVideo').currentTime, paused: document.getElementById('backgroundVideo').paused, spectrum: Math.max(...levels), audio: document.querySelectorAll('audio').length }));
await editor.waitForTimeout(400);
assert.equal(await editor.evaluate(() => seconds), frozen.time);
assert.equal(await editor.evaluate(() => document.getElementById('backgroundVideo').currentTime), frozen.video);
assert(frozen.paused && !frozen.audio && frozen.spectrum > .1, '静态帧可拖动，真实音频曲线可见，无播放');

const before = await readCard('record'), box = editor.locator('.card-box[data-card="record"]');
let bounds = await box.boundingBox();
await editor.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
await editor.mouse.down(); await editor.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 15, { steps: 5 }); await editor.mouse.up();
const moved = await readCard('record');
assert(moved.x > before.x && moved.y > before.y, '拖动改变位置');
await editor.locator('#undo').click(); assert(Math.abs((await readCard('record')).x - before.x) < .0001);
await editor.locator('#redo').click(); assert(Math.abs((await readCard('record')).x - moved.x) < .0001);
const handle = await box.locator('.resize-handle').boundingBox();
await editor.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await editor.mouse.down(); await editor.mouse.move(handle.x + 35, handle.y + 35, { steps: 5 }); await editor.mouse.up();
const resized = await readCard('record'); assert(resized.width > moved.width); assert(Math.abs(resized.height / resized.width - 16 / 9) < .0001, '黑胶保持正圆');
await details('黑胶'); await property('coverRatio', '80'); await property('spinSeconds', '12');
assert.equal((await readCard('record')).coverRatio, .8);
await editor.locator('#doneProperties').click();

await details('时间'); await property('format', 'remaining-total'); await property('style', 'pill'); await property('color', '#ffcc66'); await property('backgroundColor', '#233344'); await property('fontSize', '30');
assert.match(await editor.locator('#previewClock').innerText(), /^-00:04 \/ 00:08$/);
await editor.locator('#doneProperties').click();
await editor.locator('#deleteSelected').click(); assert.equal((await readCard('clock')).enabled, false);
assert.equal(await editor.locator('#previewClock').isVisible(), false);
await editor.locator('#restoreCard').selectOption('clock'); await editor.locator('#restoreButton').click(); assert.equal((await readCard('clock')).enabled, true);

await details('歌词'); await property('autoColor', false); await property('fontSize', '52'); await property('color', '#ddeeff'); await property('nearColor', '#99aabb'); await property('align', 'left');
await property('lyrics', '[00:00]Every extraordinary word stays together\n[00:02]Words should never break in the middle\n[00:04]月光落在安静湖面\n[00:06]A new composition made with cards');
await editor.locator('#doneProperties').click();
await details('歌曲信息'); await property('title', '卡片编辑验证'); await property('fontSize', '42'); await editor.locator('#doneProperties').click();
await editor.locator('#deleteSelected').click(); assert.equal(await editor.locator('.song-caption').isVisible(), false);
await editor.locator('#undo').click(); assert.equal(await editor.locator('.song-caption').isVisible(), true);
await details('音频曲线'); await property('color', '#aadd88'); await property('gain', '1.3'); await property('thickness', '4'); await property('linked', false); await editor.locator('#doneProperties').click();
await editor.locator('#geometryFields [data-property="y"]').fill('80'); await editor.locator('#geometryFields [data-property="y"]').dispatchEvent('change');
assert.equal((await readCard('spectrum')).y, .8);
await details('音频曲线'); await property('linked', true); await editor.locator('#doneProperties').click();
const aligned = await editor.evaluate(() => { const curve = document.getElementById('spectrumPath'); const first = curve.getPointAtLength(0).matrixTransform(curve.getScreenCTM()); const bar = document.querySelector('.video-progress').getBoundingClientRect(); return Math.abs(first.y - (bar.top + bar.height / 2)); });
assert(aligned < .15, '重新关联后恢复共同基线');
await editor.screenshot({ path: path.join(directory, '更多设置.png') });
const expected = await editor.evaluate(() => JSON.parse(JSON.stringify({ layout, lyrics: data.lyrics, cover: data.cover, volume: data.volume })));
await fs.writeFile(path.join(directory, 'expected.json'), JSON.stringify(expected, null, 2));
await Promise.all([editor.waitForEvent('close'), editor.locator('#applyEditor').click()]);
await main.waitForFunction(() => Composition.get(composition, 'caption').title === '卡片编辑验证');
assert.equal(await main.locator('#previewTitle').innerText(), '卡片编辑验证');
assert.equal(await main.locator('#fontSize').inputValue(), '52');
const saved = await main.evaluate(() => JSON.parse(localStorage.getItem('preferences')).layout);
assert.deepEqual(saved, expected.layout, '已保存卡片配置');

await main.locator('#moreSettings').click(); editor = await getEditor();
assert.equal((await readCard('record')).coverRatio, .8, '重新打开保留配置');
await editor.locator('#resetLayout').click();
await Promise.all([editor.waitForEvent('close'), editor.locator('#cancelEditor').click()]);
assert.equal(await main.evaluate(() => Composition.get(composition, 'record').coverRatio), .8, '取消编辑不覆盖原配置');
await main.locator('#resolution').selectOption('480'); await main.locator('#fps').selectOption('24');
await main.locator('#fileName').fill('卡片布局验证.mp4');
await main.locator('#outputDirectory').evaluate((e, value) => { e.value = value; }, directory);
await main.locator('#generateButton').click();
await main.waitForFunction(() => document.getElementById('renderTitle').textContent !== '正在生成作品', null, { timeout: 120000 });
assert.equal(await main.locator('#renderTitle').innerText(), '你的作品，完成了', await main.locator('#renderMessage').innerText());
const output = await main.locator('#renderPath').innerText(); assert((await fs.stat(output)).size > 1000);
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, output, checks: ['独立窗口', '暂停的可拖动单帧预览', '真实音频频谱', '卡片移动和缩放', '撤销重做', '删除与恢复', '黑胶封面比例与旋转', '歌词样式与内容', '时间格式和底色', '曲线独立定位和基线关联', '应用并保存', '取消保留旧设置', '自定义卡片实际导出'], errors }, null, 2));
console.log('卡片编辑和实际 MP4 导出验证通过：' + output);
await browser.close(); process.exit(0);
