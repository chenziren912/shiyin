// 开发机使用：先运行 tests/start_ui_test.ps1 -Port 9224，再设置
// VINYLMV_TEST_PORT=9224 运行本脚本。仅操作该独立测试窗口；依赖仅用于测试。
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

let browser;
for (let attempt = 0; attempt < 30; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT || 9223}`); break; }
  catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
}
let page;
for (let attempt = 0; attempt < 100; attempt++) {
  page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/index.html'));
  if (page) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
assert(page, 'WebView2 页面存在');
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.test-output', '界面导出');
await fs.mkdir(directory, { recursive: true });
let output;
if (!process.argv.includes('--resume-cancel')) {
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
await page.waitForFunction(() => document.getElementById('envTitle').textContent === '渲染环境已就绪', null, { timeout: 30000 });
await page.waitForFunction(() => document.getElementById('lyricStatus').textContent.includes('4 行时间轴'), null, { timeout: 15000 });
assert.equal(await page.locator('#audioName').innerText(), '湖畔来信');
assert.match(await page.locator('#backgroundName').innerText(), /短背景/);
await page.evaluate(() => { const audio = document.getElementById('audio'); audio.pause(); audio.currentTime = 0; });
await page.locator('#showSpectrum').check();
await page.locator('#volume').fill('0'); await page.locator('#volume').dispatchEvent('input');
await page.locator('#playButton').click();
await page.waitForFunction(() => document.getElementById('audio').currentTime > .5, null, { timeout: 15000 });
const spectrum = await page.evaluate(() => {
  const curve = document.getElementById('audioSpectrum'), bar = document.querySelector('.video-progress');
  const path = document.getElementById('spectrumPath');
  const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
  return { path: document.getElementById('spectrumPath').getAttribute('d'), count: curve.querySelectorAll('path').length, circles: curve.querySelectorAll('circle').length,
    curveStart: { x: start.x, y: start.y }, barStart: { x: bar.getBoundingClientRect().left, y: bar.getBoundingClientRect().top + bar.getBoundingClientRect().height / 2 }, levels: Array.from(state.spectrumLevels) };
});
assert.equal(spectrum.count, 1); assert.equal(spectrum.circles, 0);
assert.equal((spectrum.path.match(/C /g) || []).length, 47, '整条曲线使用三次贝塞尔段');
assert(Math.max(...spectrum.levels) > .1, '真实音频驱动曲线');
assert(Math.abs(spectrum.curveStart.x - spectrum.barStart.x) < .15 && Math.abs(spectrum.curveStart.y - spectrum.barStart.y) < .15, '曲线与进度条共用同一起点和基线');
assert.equal(await page.locator('.preview-brand').count(), 0, '预览移除左上角静态标语');
await page.locator('#playButton').click();
const frozenCurve = await page.locator('#spectrumPath').getAttribute('d');
await page.waitForTimeout(150);
assert.equal(await page.locator('#spectrumPath').getAttribute('d'), frozenCurve, '暂停后曲线停止');
await page.evaluate(() => { document.getElementById('audio').currentTime = 4.8; });
await page.waitForFunction(() => document.getElementById('previewClock').textContent.startsWith('00:04'));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(root, '.test-output', '主界面.png') });
await page.locator('#openSettings').click();
assert(await page.locator('#settingsDialog').isVisible());
await page.locator('#defaultFontSize').fill('48');
await page.locator('#defaultFontSize').dispatchEvent('change');
assert.equal(await page.locator('#fontSize').inputValue(), '48');
await page.locator('#settingsDialog [data-close]').first().click();
await page.locator('#editLyrics').click();
await page.locator('#lyricsEditor').fill('[00:00.00]I would still be holding you like this\n[00:02.00]Every extraordinary word belongs together\n[00:04.00]月光落在安静湖面让每一首歌都有自己的画面\n[00:06.00]The melody keeps all of these words together');
await page.locator('#lyricOffset').fill('0.2');
await page.locator('#saveLyrics').click();
await page.locator('#fontSize').fill('80'); await page.locator('#fontSize').dispatchEvent('change');
const layout = await page.evaluate(() => {
  const preview = document.getElementById('preview').getBoundingClientRect();
  const window = document.getElementById('lyricWindow').getBoundingClientRect();
  return { ratio: window.width / preview.width, words: [...document.querySelectorAll('.lyric-line')].map(line => line.textContent) };
});
assert(Math.abs(layout.ratio - .55) < .005, '歌词栏占画面宽度 55%');
assert.deepEqual(layout.words[0].split(/\s+/), 'I would still be holding you like this'.split(' '), '英文保持完整单词');
await page.locator('#showSpectrum').uncheck();
assert.equal(await page.locator('#audioSpectrum').isVisible(), false);
await page.locator('#showSpectrum').check();
assert.equal(await page.locator('#audioSpectrum').isVisible(), true);
await page.screenshot({ path: path.join(root, '.test-output', '加宽歌词与音频曲线.png') });
await page.locator('#volume').fill('1000'); await page.locator('#volume').dispatchEvent('input');
await page.locator('#brightness').fill('45'); await page.locator('#brightness').dispatchEvent('input');
await page.locator('#resolution').selectOption('480'); await page.locator('#fps').selectOption('24');
await page.locator('#fileName').fill('界面测试.mp4');
await page.locator('#outputDirectory').evaluate((element, directory) => { element.value = directory; }, directory);
await page.locator('#generateButton').click();
await page.waitForFunction(() => document.getElementById('renderTitle').textContent !== '正在生成作品', null, { timeout: 120000 });
assert.equal(await page.locator('#renderTitle').innerText(), '你的作品，完成了', await page.locator('#renderMessage').innerText());
output = await page.locator('#renderPath').innerText();
assert((await fs.stat(output)).size > 1000);
await page.screenshot({ path: path.join(root, '.test-output', '生成完成.png') });
} else { output = await page.locator('#renderPath').innerText(); }
await page.locator('#renderDialog [data-close]').first().click();
await page.locator('#generateButton').click();
await page.waitForTimeout(1200);
await page.locator('#cancelRender').click();
await page.waitForFunction(() => document.getElementById('renderTitle').textContent === '已停止生成', null, { timeout: 15000 });
assert(!(await fs.readdir(directory)).some(file => file.startsWith('.vinyl-')), '取消后清理临时视频');
await page.locator('#renderDialog [data-close]').first().click();
await page.locator('#navOutput').click();
assert.equal(await page.locator('#renderTitle').innerText(), '你的作品，完成了', '停止后仍可打开上一次完成的作品');
assert.deepEqual(errors, [], '没有未处理的页面异常');
await fs.writeFile(path.join(root, '.test-output', 'ui-result.json'), JSON.stringify({ passed: true, output, checks: ['真实 WebView2 桥接', '读取音频和同名歌词', '真实音频驱动的单条平滑曲线', '曲线与进度条起点和基线重合', '暂停曲线停止', '删除标语', '歌词栏加宽到55%', '英文不拆词', '曲线开关', '背景视频', '音频播放及拖动', '设置和歌词编辑', '完整 MP4 导出', '取消渲染清理', '取消后保留已完成作品入口'], errors }, null, 2));
console.log('WebView2 交互与真实导出检查通过：' + output);
process.exit(0);
