(function (root) {
  'use strict';
  function mount({ rpc, toast, getTemplate, editEncoding, isBusy, onBusy }) {
    const $ = id => document.getElementById(id), dialog = $('deviceDialog');
    const labels = { software: 'CPU · 软件编码', nvenc: 'GPU · 英伟达 NVENC', qsv: 'GPU · 英特尔 QSV', amf: 'GPU · AMD AMF' };
    let running = false, loading = false, offered = false, deciding = false, stopRequested = false, encoding, layout, showSpectrum = true, reports = [];
    function attempt(fn) { return async () => { try { $('deviceError').textContent = ''; await fn(); } catch (e) { $('deviceError').textContent = e.cancelled ? '已停止测速，原有测速记录保留。' : e.message; } }; }
    function controls() {
      for (const id of ['deviceContainer','deviceResolution','deviceFps','deviceParallel','deviceEncoding','deviceHistory','deviceRun']) $(id).disabled = running || loading;
      $('deviceClose').disabled = running; $('deviceStop').hidden = !running; $('deviceStop').disabled = stopRequested;
      $('deviceRun').textContent = reports.length ? '重新测速当前参数' : '同意并开始测速';
    }
    function spectrumText(p) {
      const card = Composition.get(Composition.normalize(p.layout), 'spectrum');
      return p.showSpectrum === false || !card.enabled ? '音频曲线关闭' : `${{curve:'平滑曲线',mirror:'上下镜像曲线',bars:'柱状图'}[card.visualization]} · ${card.bandCount} 频段 · FFT ${card.fftSize}`;
    }
    function summary() {
      $('deviceEncodingSummary').textContent = EncodingSettings.summary(encoding, $('deviceContainer').value);
      $('deviceSpectrumSummary').textContent = '本次音频可视化：' + spectrumText({ layout, showSpectrum }) + '。使用打开窗口时的画面配置，可在“更多设置”中修改后重开测速。';
    }
    function profile() {
      const maximum = Number($('deviceParallel').value);
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw new Error('并发上限应为 1–16 的整数。');
      const height = Number($('deviceResolution').value);
      return { container: $('deviceContainer').value, width: { 480:854,720:1280,1080:1920 }[height], height, fps: Number($('deviceFps').value), maxParallel: maximum, encoding: EncodingSettings.validate(encoding, $('deviceContainer').value), showSpectrum, layout };
    }
    function profileText(p) { return `${p.container.toUpperCase()} · ${p.height}P · ${p.fps} 帧 · ${EncodingSettings.summary(EncodingSettings.normalize(p.encoding), p.container)} · ${spectrumText(p)}`; }
    function showReport(report) {
      $('deviceResults').replaceChildren();
      if (!report) { $('deviceRecommendation').textContent = ''; $('deviceResultTitle').textContent = '选择参数后开始测速。'; return; }
      $('deviceResultTitle').textContent = profileText(report.profile) + ' · ' + new Date(report.testedAt).toLocaleString('zh-CN');
      for (const result of report.results) {
        const tr = document.createElement('tr');
        for (const text of [labels[result.encoder] || result.encoder, result.available ? '通过' : result.detail, result.available ? result.analysisSeconds.toFixed(2) + ' 秒' : '—', result.available ? result.fps.toFixed(1) + ' 帧 / 秒' : '—', result.available ? result.seconds.toFixed(2) + ' 秒' : '—']) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
        $('deviceResults').append(tr);
      }
      const fastest = report.results.filter(r => r.available).sort((a,b) => b.fps - a.fps)[0];
      $('deviceRecommendation').textContent = fastest ? `此参数单任务最快：${labels[fastest.encoder]}。批量导出会结合实时占用选择设备。` : '此参数没有编码器通过测速，请调整编码参数后重试。';
    }
    function history(status) {
      reports = status.reports || []; $('deviceHistory').replaceChildren();
      if (!reports.length) $('deviceHistory').add(new Option('尚无当前设备的测速记录', ''));
      for (let i = reports.length - 1; i >= 0; i--) $('deviceHistory').add(new Option(profileText(reports[i].profile), String(i)));
      showReport(reports.at(-1)); controls();
    }
    async function offer(ready) {
      if (!ready || offered) return; offered = true;
      try { if ((await rpc('getDeviceStatus')).decision === 'pending') $('devicePrompt').showModal(); }
      catch (e) { offered = false; toast(e.message); }
    }
    async function decide(allowed) {
      if (deciding) return; deciding = true; $('deviceAccept').disabled = $('deviceDefer').disabled = true;
      try {
        await rpc('setDeviceDecision', { decision: allowed ? 'allowed' : 'declined' });
        $('devicePrompt').close(); if (allowed) await open(undefined, true);
      } catch (e) { $(dialog.open ? 'deviceError' : 'devicePromptError').textContent = e.cancelled ? '已停止测速，原有测速记录保留。' : e.message; }
      finally { deciding = false; $('deviceAccept').disabled = $('deviceDefer').disabled = false; }
    }
    async function open(value, autoRun = false) {
      if (isBusy() || running || loading) { toast('请先等待当前任务完成，或停止当前任务。'); return; }
      const template = { ...getTemplate(), ...value };
      $('deviceContainer').value = template.container || 'mp4'; $('deviceResolution').value = String(template.resolution || 1080);
      $('deviceFps').value = String(template.fps || 30); $('deviceParallel').value = template.maxParallel || 3;
      layout = Composition.normalize(template.layout); showSpectrum = template.showSpectrum !== false;
      encoding = EncodingSettings.forContainer(template.encoding, $('deviceContainer').value); summary();
      $('deviceError').textContent = ''; $('deviceMessage').textContent = '正在识别设备与可用编码器…';
      $('deviceHardware').textContent = '正在读取 CPU 和 GPU 信息…'; $('deviceSupported').textContent = ''; showReport(null);
      if (!dialog.open) dialog.showModal(); loading = true; controls();
      try {
        const [status, capabilities] = await Promise.all([rpc('getDeviceStatus'), rpc('getEncodingCapabilities')]);
        const device = status.device;
        $('deviceHardware').textContent = device ? `${device.cpu} · ${device.logicalProcessors} 个逻辑处理器\n${device.gpus.length ? device.gpus.join('；') : '未获取到显卡型号，以编码实测结果为准'}` : '同意检测后识别 CPU、GPU，并测量编码性能。';
        const enabled = Object.entries(capabilities.encoders || {}).filter(([,v]) => v.available).map(([name]) => name);
        $('deviceSupported').textContent = '本机已提供或短帧验证通过的编码器：' + enabled.join('、');
        history(status); $('deviceMessage').textContent = status.decision === 'allowed' ? '已有记录会按对应输出参数用于批量自动选择。' : '点击下方按钮同意检测，暂不检测时使用手动编码。';
      } finally { loading = false; controls(); }
      if (autoRun && dialog.open) await run();
    }
    async function run() {
      if (running || loading || isBusy()) return;
      const selected = profile();
      stopRequested = false; running = true; onBusy(true); controls(); $('deviceError').textContent = '';
      $('deviceProgress').removeAttribute('value'); $('deviceMessage').textContent = '正在准备对应参数的 CPU / GPU 编码测试…';
      try {
        await rpc('setDeviceDecision', { decision: 'allowed' });
        if (stopRequested) throw Object.assign(new Error('已停止测速'), { cancelled: true });
        await rpc('benchmarkDevice', { profile: selected });
        const status = await rpc('getDeviceStatus'); history(status);
        $('deviceHardware').textContent = `${status.device.cpu} · ${status.device.logicalProcessors} 个逻辑处理器\n${status.device.gpus.join('；') || '未获取到显卡型号'}`;
        $('deviceMessage').textContent = status.reports.at(-1)?.results.some(r => r.available) ? '测速完成。批量自动优化已可使用这组参数的实测结果。' : '测速完成，但此参数没有可用的编码器，请调整参数后重试。';
        $('deviceProgress').max = 1; $('deviceProgress').value = 1;
      } finally { running = false; onBusy(false); controls(); }
    }
    function progress(data) {
      if (data.event === 'progress') { $('deviceProgress').max = data.total; $('deviceProgress').value = data.completed; $('deviceMessage').textContent = `${data.completed} / ${data.total} · ${data.message.replace(/software|nvenc|qsv|amf/g, word => labels[word])}`; }
    }
    for (const id of ['deviceResolution','deviceFps','deviceParallel']) $(id).addEventListener('change', () => { $('deviceMessage').textContent = '参数已修改，请测速此组参数。'; });
    $('deviceContainer').addEventListener('change', () => { encoding = EncodingSettings.forContainer(encoding, $('deviceContainer').value); summary(); $('deviceMessage').textContent = '参数已修改，请测速此组参数。'; });
    $('deviceHistory').addEventListener('change', () => {
      const report = reports[Number($('deviceHistory').value)]; if (!report) return;
      const p = report.profile; $('deviceContainer').value = p.container; $('deviceResolution').value = String(p.height);
      $('deviceFps').value = String(p.fps); $('deviceParallel').value = p.maxParallel;
      layout = Composition.normalize(p.layout); showSpectrum = p.showSpectrum !== false;
      encoding = EncodingSettings.normalize(p.encoding); summary(); showReport(report);
      $('deviceMessage').textContent = '已载入这组参数，可以直接重新测速。';
    });
    $('deviceEncoding').addEventListener('click', () => editEncoding(encoding, (value, container) => { encoding = value; $('deviceContainer').value = container; summary(); $('deviceMessage').textContent = '编码参数已修改，请重新测速。'; }, '设置用于测速的编码格式、码率、速度等参数；此处只修改测速样本，不修改作品。', { container: $('deviceContainer').value }));
    $('deviceRun').addEventListener('click', attempt(run));
    $('deviceStop').addEventListener('click', attempt(async () => { stopRequested = true; controls(); await rpc('cancelDeviceBenchmark'); }));
    $('deviceClose').addEventListener('click', () => { if (!running) dialog.close(); });
    dialog.addEventListener('cancel', e => { if (running) e.preventDefault(); });
    $('deviceAccept').addEventListener('click', () => decide(true)); $('deviceDefer').addEventListener('click', () => decide(false));
    $('devicePrompt').addEventListener('cancel', e => { e.preventDefault(); decide(false); });
    return { offer, open: value => open(value), progress, isRunning: () => running };
  }
  root.DeviceOptimizer = { mount };
})(window);
