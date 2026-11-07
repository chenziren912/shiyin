// Only observe a GUID-isolated app importing prepare_import_progress.py's fixtures.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
let browser;
for (let i = 0; i < 100; i++) {
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.VINYLMV_TEST_PORT); break; }
  catch (error) { if (i === 99) throw error; await new Promise(r => setTimeout(r, 100)); }
}
let page;
for (let i = 0; i < 100; i++) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/index.html')); if (page) break; await new Promise(r => setTimeout(r, 50)); }
assert(page);
const errors = []; page.on('pageerror', error => errors.push(error.message));
await page.evaluate(() => {
  if (window.importQa) return;
  window.importQa = [];
  window.chrome.webview.addEventListener('message', ({ data }) => {
    if (data.event !== 'mediaImport') return;
    queueMicrotask(() => {
      const bar = document.getElementById('mediaImportProgress');
      window.importQa.push({ ...data.data, position: bar.position, value: bar.getAttribute('value'), max: bar.max, count: document.getElementById('mediaImportCount').textContent, open: document.getElementById('mediaImportDialog').open });
    });
  });
});
const directory = path.resolve(import.meta.dirname, '../.test-output/导入进度界面', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const cancelling = process.argv.includes('--cancel');
await page.waitForFunction(() => window.importQa.some(e => e.active && e.total === 30 && e.completed > 0 && e.completed < 28), null, { timeout: 120000 });
assert(await page.evaluate(() => window.importQa.some(e => e.message?.includes('合成进度验证'))));
if (cancelling) {
  await page.waitForFunction(() => window.importQa.some(e => e.total === 30 && e.completed > 0 && e.message.includes('兼容的音乐预览')), null, { timeout: 120000 });
  await page.locator('#cancelMediaImport').click();
} else {
  await page.waitForFunction(() => window.importQa.some(e => e.total === 30 && e.completed >= 12), null, { timeout: 120000 });
  if (await page.locator('#mediaImportDialog').isVisible()) await page.locator('#mediaImportDialog').screenshot({ path: path.join(directory, '已处理数量与进度.png') });
}
await page.waitForFunction(() => document.querySelectorAll('#batchRows tr').length > 0 && !document.getElementById('mediaImportDialog').open && !document.getElementById('batchAssign').disabled, null, { timeout: 600000 });
const events = await page.evaluate(() => window.importQa);
const music = events.filter(e => e.active && e.total === 30);
assert(music.length > 2);
for (let i = 0; i < music.length; i++) {
  const e = music[i];
  assert.equal(e.max, 30);
  assert(Math.abs(e.position - e.completed / 30) < 1e-6, JSON.stringify(e));
  assert.match(e.count, new RegExp(`已处理 ${e.completed} / 30`));
  if (i) assert(e.completed >= music[i - 1].completed, '同一批文件进度不回退');
}
assert(music.some(e => e.message.includes('兼容的音乐预览') && e.completed > 0), '转换预览时保留已处理数量与总进度');
const rowCount = await page.locator('#batchRows tr').count();
if (cancelling) {
  assert(music.at(-1).completed < 30, '取消不伪造100%');
  assert(rowCount > 0 && rowCount < 29, '取消保留已读项目');
} else {
  assert.equal(music.at(-1).completed, 30, '失败文件计入已处理数量，重复输入不扩大总数');
  assert.equal(rowCount, 29);
  assert.match(await page.locator('#batchNotice').textContent(), /损坏样例/);
  const videos = events.filter(e => e.active && e.total === 2);
  assert(videos.length && videos.at(-1).completed === 2, '视频库使用自己的文件计数');
}
await page.locator('#batchDialog > .modal-heading [data-close]').click();
// Exercise the no-total fallback separately; these are UI states, not simulated native work.
await page.evaluate(() => updateMediaImport({ active: true, message: '单文件处理中' }));
assert.equal(await page.locator('#mediaImportProgress').evaluate(e => e.position), -1);
const first = await page.locator('.media-import-busy').evaluate(e => getComputedStyle(e).transform);
await page.waitForTimeout(180);
assert.notEqual(await page.locator('.media-import-busy').evaluate(e => getComputedStyle(e).transform), first, '未知总进度有实际加载动画');
await page.screenshot({ path: path.join(directory, '单文件加载动画.png') });
await page.emulateMedia({ reducedMotion: 'reduce' });
assert.equal(await page.locator('.media-import-busy').evaluate(e => getComputedStyle(e).animationName), 'none');
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.evaluate(() => { updateMediaImport({ active: false, message: '' }); updateMediaImport({ active: true, message: '新一批', total: 3, completed: 0 }); });
assert.equal(await page.locator('#mediaImportProgress').evaluate(e => e.value), 0, '下一批从零开始');
assert.equal(await page.locator('#cancelMediaImport').isEnabled(), true);
await page.evaluate(() => updateMediaImport({ active: false, message: '' }));
assert.deepEqual(errors, []);
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, cancelling, rowCount, events, errors }, null, 2));
console.log('真实批量导入进度、预览转换、去重、失败、取消及加载动画验证通过：' + directory);
process.exit(0);
