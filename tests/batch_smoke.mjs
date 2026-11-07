// Runs only in a separate app/profile started with start_ui_test.ps1 -BatchFixture.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openEncoding } from './encoding_ui_helpers.mjs';

let browser;
for (let attempt = 0; attempt < 100; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT || 9235}`); break; }
  catch (error) { if (attempt === 99) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
}
let page;
for (let attempt = 0; attempt < 100; attempt++) {
  page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html'));
  if (page) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
assert(page);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const directory = path.resolve(import.meta.dirname, '../.test-output/批量界面', Date.now().toString());
await fs.mkdir(directory, { recursive: true });
const idle = () => page.waitForFunction(() => document.querySelectorAll('#batchRows tr').length === 4 && !document.getElementById('batchAssign').disabled, null, { timeout: 60000 });
await idle();
assert(await page.locator('#batchDialog').isVisible());
const fixturePaths = await page.evaluate(async () => (await rpc('getVideoLibrary')).map(video => video.path));
assert(fixturePaths.length === 2 && fixturePaths.every(file => file.includes('批量素材')), '隔离的合成视频库');
await page.locator('#batchLibraryTab').click();
const videoNames = await page.locator('#libraryRows tr td:nth-child(2) b').allInnerTexts();
const genres = ['Rock, 电子', 'Pop'];
for (let index = 0; index < 2; index++) {
  const input = page.locator('#libraryRows tr').nth(index).locator('input[list]');
  await input.fill(genres[index]); await input.dispatchEvent('change'); await idle();
}
const library = await page.evaluate(() => rpc('getVideoLibrary'));
assert.deepEqual(library[0].genres, ['摇滚', '电子']); assert.deepEqual(library[1].genres, ['流行']);
await page.locator('#batchQueueTab').click();
const row = index => page.locator('#batchRows tr').nth(index);
assert.equal(await row(0).locator('.batch-genre').inputValue(), 'Rock', '自动读取歌曲风格标签');
assert.equal(await row(0).locator('.batch-background b').innerText(), videoNames[0]);
assert.equal(await row(1).locator('.batch-background b').innerText(), videoNames[1]);
assert.match(await row(0).locator('.batch-background small').innerText(), /风格匹配/);
assert.match(await row(2).locator('.batch-background small').innerText(), /全库随机/);
assert.match(await row(3).locator('.batch-background small').innerText(), /全库随机/);

await page.locator('#batchResolution').selectOption('480'); await page.locator('#batchFps').selectOption('24');
await page.locator('#batchPattern').fill('{序号} - {歌名} - {风格}');
await page.locator('#batchExportSettings').click();
await page.locator('#batchSearchLyrics').uncheck();
await page.locator('#batchSettingsApply').click();
await page.locator('#batchEncoding').click();
await page.locator('#encPreset').selectOption('ultrafast'); await page.locator('#encCrf').fill('28'); await page.locator('#encThreads').fill('2');
await page.locator('#applyEncoding').click();
assert.equal(await page.evaluate(() => prefs.encoding.preset), 'veryfast', '批量编码草稿独立于单首设置');
await page.locator('#batchApplySettings').click(); await idle();
const formats = ['mp4','mkv','mov','webm'];
for (let index = 0; index < 4; index++) {
  await row(index).locator('td:nth-child(4) select').selectOption(formats[index]); await idle();
  assert((await row(index).locator('td:nth-child(4) input').inputValue()).startsWith(String(index + 1).padStart(3, '0')), '改单首格式后序号保持稳定');
  assert((await row(index).locator('td:nth-child(4) input').inputValue()).endsWith('.' + formats[index]));
}
await page.locator('#batchOutputDirectory').evaluate((element, value) => { element.value = value; }, directory);
await page.screenshot({ path: path.join(directory, '批量设置.png') });
await page.locator('#batchStart').click();
await page.waitForFunction(() => document.getElementById('batchStop').hidden, null, { timeout: 300000 });
const statuses = await page.locator('#batchRows .batch-status').allInnerTexts();
assert(statuses.every(text => text.includes('已完成')), statuses.join('\n'));
assert.match(statuses[3], /无歌词画面/, '缺歌词可以继续输出');
const files = (await fs.readdir(directory)).filter(file => formats.includes(path.extname(file).slice(1)));
assert.equal(files.length, 4);
const media = [];
for (const file of files) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path.join(directory,file)], { encoding:'utf8' }));
  const video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.width, 854); assert.equal(video.height, 480); assert.equal(video.r_frame_rate, '24/1');
  assert.equal(video.codec_name, file.endsWith('.webm') ? 'vp9' : 'h264');
  assert.equal(audio.codec_name, file.endsWith('.webm') ? 'opus' : 'aac');
  assert(Math.abs(Number(probe.format.duration) - 2) < .2);
  media.push({ file, codec: video.codec_name, audio: audio.codec_name });
}
assert(!(await fs.readdir(directory)).some(file => file.startsWith('.vinyl-')), '无遗留临时视频');
await page.screenshot({ path: path.join(directory, '批量完成.png') });
await page.locator('#batchDialog > .modal-heading [data-close]').click();
const editor = await openEncoding(page, browser);
assert.equal(await editor.locator('#encPreset').inputValue(), 'veryfast', '标题栏编码入口仍读取单首偏好');
assert.match(await editor.locator('#encodingDialog .modal-description').innerText(), /选择文件格式/);
await editor.locator('#encodingDialog button[data-close]').last().click();
await page.locator('#openBatch').click(); await idle();
assert.equal((await page.locator('#batchRows .batch-status').allInnerTexts()).filter(text => text.includes('已完成')).length, 4, '收起后可重新查看批量结果');
assert.equal((await page.evaluate(() => rpc('getVideoLibrary')))[0].genres[0], '摇滚');
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, library, media, statuses, errors }, null, 2));
console.log('批量导入、风格匹配与回退、库保存、单首格式、独立编码和四种容器真实导出通过：' + directory);
await browser.close();
