// Uses a fresh isolated native app started with -BatchFixture and -TestDevicePrompt.
import { chromium } from '../.tools/ui-test/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let browser;
for (let i=0;i<3;i++) {
  try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VINYLMV_TEST_PORT}`,{timeout:60000});break; }
  catch(e){if(i===2)throw e;}
}
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().endsWith('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}
assert(page);page.setDefaultTimeout(60000);
const errors=[];page.on('pageerror', e=>errors.push(e.message));
const directory=path.resolve(import.meta.dirname,'../.test-output/设备优化界面',String(Date.now()));await fs.mkdir(directory,{recursive:true});
const idle=()=>page.waitForFunction(()=>document.querySelectorAll('#batchRows tr').length===4&&!document.getElementById('batchAssign').disabled,null,{timeout:120000});
await idle();
if(!await page.evaluate(()=>state.dependencies.ready)){
  await page.evaluate(async()=>showDependencies(await rpc('detectDependencies')));
  if(await page.locator('#dependenciesDialog').isVisible())await page.locator('#dependenciesDialog [data-close]').click();
  await page.evaluate(()=>deviceOptimizer.offer(true));
}
await page.locator('#devicePrompt').waitFor({state:'visible'});
await page.screenshot({path:path.join(directory,'首次设备检测提示.png')});
if(process.argv.includes('--accept')){
  await page.locator('#deviceAccept').click();
  await page.locator('#deviceStop').waitFor({state:'visible',timeout:120000});
  await page.keyboard.press('Escape');assert(await page.locator('#deviceDialog').isVisible(),'测速时 Esc 不会意外隐藏停止入口');
  await page.locator('#deviceStop').click();
  await page.waitForFunction(()=>!deviceOptimizer.isRunning(),null,{timeout:120000});
  const status=await page.evaluate(()=>rpc('getDeviceStatus'));
  assert.equal(status.decision,'allowed');assert(status.device.cpu.length>1);
  assert.match(await page.locator('#deviceError').innerText(),/停止/);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,branch:'accept-and-cancel',status,errors},null,2));
  console.log('首次同意设备检测、识别设备、停止测速和保留状态通过：'+directory);
  await browser.close();process.exit(0);
}
await page.locator('#deviceDefer').click();
assert.equal((await page.evaluate(()=>rpc('getDeviceStatus'))).decision,'declined');
await page.evaluate(()=>{
  window.qaEvents=[];
  window.chrome.webview.addEventListener('message',({data})=>{if(data.event==='batchProgress')window.qaEvents.push(data.data);});
  const send=window.chrome.webview.postMessage.bind(window.chrome.webview);
  window.chrome.webview.postMessage=message=>{if(message.action==='planBatch')window.qaAudio=message.payload.rows.map(r=>r.audio);send(message);};
});
await page.locator('#batchAssign').click();await idle();
const fixture=await page.evaluate(()=>window.qaAudio);assert.equal(fixture.length,4);
await page.reload();
await page.waitForFunction(()=>!!state.dependencies&&!!deviceOptimizer&&!!batchExporter,null,{timeout:120000});
if(!await page.evaluate(()=>state.dependencies.ready))await page.evaluate(async()=>showDependencies(await rpc('detectDependencies')));
if(await page.locator('#dependenciesDialog').isVisible())await page.locator('#dependenciesDialog [data-close]').click();
assert.equal(await page.locator('#devicePrompt').isVisible(),false,'拒绝决定保存后重开不再重复询问');
await page.evaluate(items=>batchExporter.open({items,errors:[]}),fixture);await idle();
await page.evaluate(()=>{
  window.qaEvents=[];
  window.chrome.webview.addEventListener('message',({data})=>{if(data.event==='batchProgress')window.qaEvents.push(data.data);});
  Object.assign(Composition.get(composition,'spectrum'),{enabled:true,visualization:'mirror',bandCount:96,fftSize:2048});
  composition=Composition.normalize(composition);prefs.showSpectrum=true;
});
await page.locator('#batchResolution').selectOption('480');await page.locator('#batchFps').selectOption('24');
await page.locator('#batchEncoding').click();
await page.locator('#encMode').selectOption('vbr');await page.locator('#encBitrate').fill('2');
await page.locator('#encPreset').selectOption('ultrafast');await page.locator('#encThreads').fill('2');
await page.locator('#applyEncoding').click();
await page.locator('#batchApplySettings').click();await idle();
await page.locator('#batchExportSettings').click();
assert.equal(await page.locator('#batchMaxParallel').inputValue(),'3');
await page.locator('#batchMaxParallel').fill('0');await page.locator('#batchSettingsApply').click();
assert.match(await page.locator('#batchSettingsError').innerText(),/1–16/);
await page.locator('#batchMaxParallel').fill('2');await page.locator('#batchSearchLyrics').uncheck();await page.locator('#batchAutoEncoder').check();
await page.locator('#batchSettingsApply').click();await idle();
await page.locator('#batchExportSettings').click();await page.locator('#batchDeviceTest').click();
await page.locator('#deviceRun').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('deviceRun').disabled,null,{timeout:120000});
assert.equal(await page.locator('#deviceResolution').inputValue(),'480');assert.equal(await page.locator('#deviceParallel').inputValue(),'2');
assert.match(await page.locator('#deviceSpectrumSummary').innerText(),/上下镜像曲线.*96 频段.*FFT 2048/);
await page.locator('#deviceRun').click();await page.waitForFunction(()=>!deviceOptimizer.isRunning(),null,{timeout:240000});
assert.equal(await page.locator('#deviceError').innerText(),'');
let status=await page.evaluate(()=>rpc('getDeviceStatus'));
assert.equal(status.decision,'allowed');assert(status.device.cpu.length>1);
assert.equal(status.reports.length,1);
const report=status.reports[0];assert.equal(report.profile.height,480);assert.equal(report.profile.encoding.bitrateMbps,2);
assert(report.results.find(r=>r.encoder==='software').available);
const curve=report.profile.layout.cards.find(c=>c.id==='spectrum');assert.equal(curve.visualization,'mirror');assert.equal(curve.fftSize,2048);assert.equal(curve.bandCount,96);
assert.equal(report.profile.showSpectrum,true);
for(const result of report.results.filter(r=>r.available)){
  assert.equal(result.spectrumFrames,72);assert(result.analysisSeconds>0);assert(result.encodeSeconds>0);
  assert(Math.abs(result.seconds-result.analysisSeconds-result.encodeSeconds)<.0002);
}
assert.equal(await page.locator('#deviceResults tr').count(),4);
assert.match(await page.locator('#deviceRecommendation').innerText(),/单任务最快/);
await page.screenshot({path:path.join(directory,'设备测速结果.png')});
await page.locator('#deviceClose').click();await page.locator('#batchSettingsDialog [data-close]').last().click();
await page.locator('#batchOutputDirectory').evaluate((e,value)=>{e.value=value;},directory);
await page.locator('#batchStart').click();
await page.waitForFunction(()=>document.getElementById('batchStop').hidden,null,{timeout:240000});
const statuses=await page.locator('#batchRows .batch-status').allInnerTexts();assert(statuses.every(s=>s.includes('已完成')),statuses.join('\n'));
const events=await page.evaluate(()=>window.qaEvents), schedules=events.filter(e=>e.event==='scheduler');
assert(schedules.length>0&&schedules.every(e=>e.active<=2),'遵守设置的并发上限');
const first=events.find(e=>e.encoder);const fastest=[...report.results].filter(r=>r.available).sort((a,b)=>b.fps-a.fps)[0];
assert(first.encoder.includes({software:'CPU',nvenc:'NVENC',qsv:'QSV',amf:'AMF'}[fastest.encoder]),'首个任务使用当前参数测速最快的设备');
assert.equal((await page.evaluate(()=>rpc('getDeviceStatus'))).reports.length,1,'同参数批量导出复用测速缓存');
const videos=(await fs.readdir(directory)).filter(f=>f.endsWith('.mp4'));assert.equal(videos.length,4);
for(const file of videos){const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',path.join(directory,file)],{encoding:'utf8'}));const v=probe.streams.find(s=>s.codec_type==='video');assert.equal(v.codec_name,'h264');assert.equal(v.height,480);}
await page.screenshot({path:path.join(directory,'自动设备批量导出完成.png')});
// Force a different profile, cancel it, and verify existing successful measurements survive.
await page.locator('#batchExportSettings').click();await page.locator('#batchDeviceTest').click();
await page.waitForFunction(()=>!document.getElementById('deviceRun').disabled,null,{timeout:120000});
await page.locator('#deviceResolution').selectOption('1080');await page.locator('#deviceFps').selectOption('60');
await page.locator('#deviceRun').click();await page.locator('#deviceStop').click();
await page.waitForFunction(()=>!deviceOptimizer.isRunning(),null,{timeout:120000});
assert.match(await page.locator('#deviceError').innerText(),/停止/);
status=await page.evaluate(()=>rpc('getDeviceStatus'));assert.equal(status.reports.length,1,'停止测速保留原记录');
assert.deepEqual(errors,[]);
await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,status,statuses,peak:Math.max(...schedules.map(e=>e.active)),first,events,videos,errors},null,2));
console.log('首次询问/拒绝保存、对应参数测速、自动设备选择、真实并发批量输出、停止测速通过：'+directory);
await browser.close();
