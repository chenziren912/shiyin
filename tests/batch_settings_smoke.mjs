// Only run against an isolated app/profile launched with start_ui_test.ps1 -BatchFixture.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let browser;
for (let attempt = 0; attempt < 3; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT || 9258}`, { timeout: 60000 }); break; }
  catch (error) { if (attempt === 2) throw error; }
}
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/index.html'));
assert(page);
page.setDefaultTimeout(60000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const directory = path.resolve(import.meta.dirname, '../.test-output/批量策略界面', Date.now().toString());
await fs.mkdir(directory, { recursive: true });
const idle = () => page.waitForFunction(() => document.querySelectorAll('#batchRows tr').length === 4 && !document.getElementById('batchAssign').disabled, null, { timeout: 60000 });
const row = i => page.locator('#batchRows tr').nth(i);
const backgrounds = () => page.locator('#batchRows .batch-background b').allInnerTexts();
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('batchPreferences')));
const open = () => page.locator('#batchExportSettings').click();
const apply = async () => { await page.locator('#batchSettingsApply').click(); await idle(); };
async function ensureEnvironment() {
  for (let i = 0; i < 3 && !await page.evaluate(() => !!state.dependencies?.ready); i++)
    await page.evaluate(async () => showDependencies(await rpc('detectDependencies')));
  assert(await page.evaluate(() => state.dependencies.ready), '真实依赖检测通过');
  if (await page.locator('#dependenciesDialog').isVisible()) await page.locator('#dependenciesDialog [data-close]').click();
}
await idle();
await ensureEnvironment();
await page.evaluate(() => {
  const send = window.chrome.webview.postMessage.bind(window.chrome.webview);
  window.chrome.webview.postMessage = message => {
    if (message.action === 'planBatch') window.qaImportedAudio = message.payload.rows.map(r => r.audio);
    send(message);
  };
});
const library = await page.evaluate(() => rpc('getVideoLibrary'));
assert(library.length === 2 && library.every(v => v.path.includes('批量素材')));
await page.locator('#batchLibraryTab').click();
for (let i = 0; i < 2; i++) {
  const input = page.locator('#libraryRows tr').nth(i).locator('input[list]');
  await input.fill(i === 0 ? 'Rock' : 'Pop'); await input.dispatchEvent('change'); await idle();
}
await page.locator('#batchQueueTab').click();
const fixtureAudio = await page.evaluate(() => window.qaImportedAudio);
assert.equal(fixtureAudio.length, 4);
async function reloadQueue() {
  await page.reload();
  await page.waitForFunction(() => !!state.dependencies && !!batchExporter, null, { timeout: 60000 });
  await ensureEnvironment();
  // Command-line inputs are consumed once per native process; restore the captured synthetic import.
  await page.evaluate(items => batchExporter.open({ items, errors: [] }), fixtureAudio);
  await idle();
}
const original = await saved();
await open();
assert.equal(await page.locator('#batchMissingTextField').isVisible(), false);
await page.locator('#batchMissingLyrics').selectOption('message');
await page.locator('#batchMissingText').fill('  ');
await page.locator('#batchSettingsApply').click();
assert.match(await page.locator('#batchSettingsError').innerText(), /不能只有空白/);
assert.deepEqual(await saved(), original, '无效固定文字不保存');
await page.locator('#batchBackgroundScope').selectOption('all');
assert.equal(await page.locator('#batchNoMatchField').isVisible(), false);
await page.locator('#batchSettingsDialog [data-close]').last().click();
assert.deepEqual(await saved(), original, '取消丢弃草稿');
await open(); await page.locator('#batchSettingsDefaults').click(); await page.keyboard.press('Escape');
assert.deepEqual(await saved(), original, '恢复默认后按 Escape 不保存');
await open();
await page.locator('#batchBackgroundScope').selectOption('all');
await page.locator('#batchBackgroundOrder').selectOption('sequence');
await page.locator('#batchAvoidRepeat').check();
await page.locator('#batchSearchLyrics').uncheck();
await page.locator('#batchMissingLyrics').selectOption('message');
const fixedText = '该歌曲暂无可用歌词\n请欣赏音乐';
await page.locator('#batchMissingText').fill(fixedText);
await page.locator('#batchContinueOnError').uncheck();
await page.screenshot({ path: path.join(directory, '批量导出设置.png') });
await apply();
assert.deepEqual(await backgrounds(), [library[0].name, library[1].name, library[0].name, library[1].name]);
const persisted = await saved();
assert.equal(persisted.missingText, fixedText); assert.equal(persisted.continue, false);
assert.match(await page.locator('#batchPolicySummary').innerText(), /顺序循环.*减少重复.*固定文字/);
const beforeFormat = await backgrounds();
await row(1).locator('td:nth-child(4) select').selectOption('mkv'); await idle();
assert.deepEqual(await backgrounds(), beforeFormat, '改单首格式保留背景');
const pattern = await page.locator('#batchPattern').inputValue();
await page.locator('#batchPattern').fill('{未知占位符}'); await page.locator('#batchAssign').click(); await idle();
assert.match(await page.locator('#batchError').innerText(), /不支持的占位符/);
assert((await backgrounds()).every(text => text === '等待分配背景'), '分配失败不会沿用不符合新设置的旧背景');
await page.locator('#batchPattern').fill(pattern); await page.locator('#batchAssign').click(); await idle();
assert.deepEqual(await backgrounds(), beforeFormat);
await open();
await page.locator('#batchBackgroundScope').selectOption('genre');
await page.locator('#batchBackgroundNoMatch').selectOption('unassigned'); await apply();
assert.deepEqual(await backgrounds(), [library[0].name, library[1].name, '等待分配背景', '等待分配背景']);
await page.locator('#batchOutputDirectory').evaluate((e, value) => { e.value = value; }, directory);
await page.locator('#batchStart').click(); await idle();
assert.match(await page.locator('#batchError').innerText(), /没有匹配风格/);
assert.equal(await page.locator('#batchStop').isVisible(), false);
await open(); await page.locator('#batchBackgroundScope').selectOption('all'); await apply();
await page.locator('#batchResolution').selectOption('480'); await page.locator('#batchFps').selectOption('24');
await page.locator('#batchEncoding').click();
await page.locator('#encPreset').selectOption('ultrafast'); await page.locator('#encThreads').fill('2');
await page.locator('#applyEncoding').click();
await page.locator('#batchApplySettings').click(); await idle();
async function onlyMissing() {
  await page.locator('#batchSelectAll').uncheck(); await row(3).locator('td:first-child input').check();
}
async function run() {
  await page.locator('#batchStart').click();
  await page.waitForFunction(() => document.getElementById('batchStop').hidden, null, { timeout: 120000 });
}
await onlyMissing(); await run();
assert.match(await row(3).locator('.batch-status').innerText(), /已完成.*自定义固定文字/s);
const completedBackground = (await backgrounds())[3];
const messageFile = (await fs.readdir(directory)).find(f => f.endsWith('.mp4')); assert(messageFile);
execFileSync('ffmpeg', ['-v','error','-i',path.join(directory,messageFile),'-ss','0.5','-frames:v','1',path.join(directory,'固定文字成片.png')]);
await open(); await page.locator('#batchBackgroundScope').selectOption('genre'); await page.locator('#batchBackgroundNoMatch').selectOption('unassigned'); await apply();
assert.equal((await backgrounds())[3], completedBackground, '已完成任务保留背景');
assert.match(await row(3).locator('.batch-status').innerText(), /已完成/);

// Reload tests persisted preferences with a fresh queue from the same synthetic inputs.
await reloadQueue();
assert.equal((await saved()).missingText, fixedText);
await open();
assert.equal(await page.locator('#batchMissingText').inputValue(), fixedText);
assert.equal(await page.locator('#batchBackgroundNoMatch').inputValue(), 'unassigned');
assert.equal(await page.locator('#batchSearchLyrics').isChecked(), false);
await page.locator('#batchBackgroundScope').selectOption('all'); await page.locator('#batchMissingLyrics').selectOption('skip'); await apply();
await onlyMissing(); await run();
assert.match(await row(3).locator('.batch-status').innerText(), /已跳过.*没有时间轴歌词/s);
assert.equal((await fs.readdir(directory)).filter(f => f.endsWith('.mp4')).length, 1, '跳过不创建视频');
await open(); await page.locator('#batchMissingLyrics').selectOption('instrumental'); await apply();
await run();
assert.match(await row(3).locator('.batch-status').innerText(), /已完成.*无歌词画面/s);
const videos = (await fs.readdir(directory)).filter(f => f.endsWith('.mp4')); assert.equal(videos.length, 2);
const blankFile = videos.find(f => f !== messageFile);
execFileSync('ffmpeg', ['-v','error','-i',path.join(directory,blankFile),'-ss','0.5','-frames:v','1',path.join(directory,'歌词留空成片.png')]);
for (const file of videos) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path.join(directory,file)], { encoding:'utf8' }));
  assert.equal(probe.streams.find(s => s.codec_type === 'video').height, 480);
  assert(Math.abs(Number(probe.format.duration) - 2) < .2);
}
// Migrate the previously saved preference shape without changing its lyric policy.
await page.evaluate(() => localStorage.setItem('batchPreferences', JSON.stringify({ missing: 'skip', search: false, continue: false, resolution: '480', fps: '24' })));
await reloadQueue(); await open();
assert.equal(await page.locator('#batchMissingLyrics').inputValue(), 'skip');
assert.equal(await page.locator('#batchSearchLyrics').isChecked(), false);
assert.equal(await page.locator('#batchContinueOnError').isChecked(), false);
assert.equal(await page.locator('#batchBackgroundScope').inputValue(), 'genre');
await page.locator('#batchSettingsDefaults').click(); await apply(); await open();
assert.equal(await page.locator('#batchMissingLyrics').inputValue(), 'instrumental');
assert.equal(await page.locator('#batchMissingText').inputValue(), '该歌曲暂无可用歌词');
assert.equal(await page.locator('#batchSearchLyrics').isChecked(), true);
await page.locator('#batchSettingsDialog [data-close]').last().click();
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, persisted, videos, errors }, null, 2));
console.log('批量设置保存/取消、迁移、顺序/严格匹配、保留完成任务、固定文字/留空/跳过的真实导出通过：' + directory);
await browser.close();
