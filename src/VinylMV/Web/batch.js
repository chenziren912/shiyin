(function (root) {
  'use strict';
  function mount({ rpc, toast, getTemplate, editEncoding, openDevice, onRunning }) {
    const $ = id => document.getElementById(id), dialog = $('batchDialog');
    const rows = [], selectedVideos = new Set();
    let library = [], running = false, working = false, planning = 0, encoding, options, serial = 0;
    const ai = AiVideoUI.mount({ rpc, toast, getSong: () => song(rows.find(row => row.selected) || rows[0]), onChange: () => { if (options) saveOptions(); paintRows(); } });
    function song(row) { return row ? { title: row.audio.title, artist: row.audio.artist, genres: row.genres, lyrics: row.audio.localLyrics || '', duration: row.audio.duration,
      layout: getTemplate().layout, prompt: row.aiPrompt || row.aiActualPrompt || '' } : { title: '示例歌曲', genres: '氛围', layout: getTemplate().layout }; }
    function normalizePolicy(value = {}) {
      const background = value.background || {};
      return { autoEncoder: value.autoEncoder !== false, maxParallel: Number.isInteger(value.maxParallel) && value.maxParallel >= 1 && value.maxParallel <= 16 ? value.maxParallel : 3,
        resourceThreshold: Number.isInteger(value.resourceThreshold) && value.resourceThreshold >= 50 && value.resourceThreshold <= 95 ? value.resourceThreshold : 85,
        search: value.search !== false, missing: ['instrumental','message','skip'].includes(value.missing) ? value.missing : 'instrumental',
        missingText: typeof value.missingText === 'string' ? value.missingText.slice(0, 300) : '该歌曲暂无可用歌词', continue: value.continue !== false,
        background: { scope: background.scope === 'all' ? 'all' : 'genre', order: background.order === 'sequence' ? 'sequence' : 'random',
          avoidRepeat: background.avoidRepeat === true, noMatch: background.noMatch === 'unassigned' ? 'unassigned' : 'library' } };
    }
    let policy = normalizePolicy();
    const statusNames = { waiting: '等待导出', optimizing: '设备测速', preparing: '准备歌词', ai_waiting: '等待 AI 名额', ai_prompting: '优化提示词', ai_generating: 'AI 生成背景', ai_downloading: '下载 AI 背景', ai_checking: '验证 AI 背景', ai_ready: '背景已就绪', ai_fallback: '使用视频库回退', rendering: '正在生成 MV', completed: '已完成', failed: '失败', cancelled: '已停止', skipped: '已跳过' };
    function attempt(fn) { return async () => { try { $('batchError').textContent = ''; await fn(); } catch (error) { $('batchError').textContent = error.message; } }; }
    function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
    function settings() { return { container: $('batchContainer').value, resolution: $('batchResolution').value, fps: $('batchFps').value, encoding: structuredClone(encoding) }; }
    function saveOptions() {
      encoding = EncodingSettings.forContainer(encoding, $('batchContainer').value);
      options = { ...settings(), pattern: $('batchPattern').value, directory: $('batchOutputDirectory').value, ...structuredClone(policy) };
      try { localStorage.setItem('batchPreferences', JSON.stringify(options)); } catch { }
      $('batchEncodingSummary').textContent = EncodingSettings.summary(encoding, $('batchContainer').value);
      const b = policy.background;
      const source = b.scope === 'all' ? '全部可用视频' : '优先匹配音乐风格';
      const fallback = b.scope === 'genre' ? (b.noMatch === 'library' ? '，无匹配时使用全库' : '，无匹配时暂不分配') : '';
      const missing = { instrumental: '歌词区域留空', message: '显示固定文字', skip: '跳过音乐' }[policy.missing];
      const aiSummary = ai.settings?.enabled ? `AI 背景：${ai.settings.mode === 'all' ? '每首自动生成' : '缺少视频库背景时生成'}，最多同时生成 ${ai.settings.maxConcurrent} 个；` : '';
      $('batchPolicySummary').textContent = `${aiSummary}${source} · ${b.order === 'sequence' ? '顺序循环' : '随机选择'}${b.avoidRepeat ? ' · 减少重复' : ''}${fallback}；缺歌词时${missing}。`;
    }
    function initOptions() {
      const template = getTemplate(); let saved = {};
      try { saved = JSON.parse(localStorage.getItem('batchPreferences') || '{}'); } catch { }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      encoding = EncodingSettings.normalize(saved.encoding || template.encoding);
      $('batchContainer').value = ['mp4','mkv','mov','webm'].includes(saved.container) ? saved.container : 'mp4';
      $('batchResolution').value = ['480','720','1080'].includes(saved.resolution) ? saved.resolution : String(template.resolution);
      $('batchFps').value = ['24','30','60'].includes(saved.fps) ? saved.fps : String(template.fps);
      $('batchPattern').value = typeof saved.pattern === 'string' ? saved.pattern : '{序号} - {歌名}';
      $('batchOutputDirectory').value = saved.directory || template.outputDirectory || '';
      policy = normalizePolicy(saved); saveOptions();
    }
    function policyFields() {
      $('batchMissingTextField').hidden = $('batchMissingLyrics').value !== 'message';
      $('batchNoMatchField').hidden = $('batchBackgroundScope').value !== 'genre';
    }
    function fillPolicy(value) {
      $('batchAutoEncoder').checked = value.autoEncoder; $('batchMaxParallel').value = value.maxParallel; $('batchResourceThreshold').value = value.resourceThreshold;
      $('batchBackgroundScope').value = value.background.scope; $('batchBackgroundOrder').value = value.background.order;
      $('batchBackgroundNoMatch').value = value.background.noMatch; $('batchAvoidRepeat').checked = value.background.avoidRepeat;
      $('batchSearchLyrics').checked = value.search; $('batchMissingLyrics').value = value.missing;
      $('batchMissingText').value = value.missingText; $('batchContinueOnError').checked = value.continue;
      policyFields();
    }
    function openPolicy() {
      if (running || working || planning) return;
      fillPolicy(policy); $('batchSettingsError').textContent = ''; $('batchSettingsDialog').showModal();
    }
    async function applyPolicy() {
      const maximum = Number($('batchMaxParallel').value), threshold = Number($('batchResourceThreshold').value);
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16 || !Number.isInteger(threshold) || threshold < 50 || threshold > 95) { $('batchSettingsError').textContent = '并发任务数应为 1–16，占用上限应为 50–95 的整数。'; return; }
      const draft = normalizePolicy({ autoEncoder: $('batchAutoEncoder').checked, maxParallel: maximum, resourceThreshold: threshold,
        search: $('batchSearchLyrics').checked, missing: $('batchMissingLyrics').value,
        missingText: $('batchMissingText').value.trim(), continue: $('batchContinueOnError').checked,
        background: { scope: $('batchBackgroundScope').value, order: $('batchBackgroundOrder').value,
          noMatch: $('batchBackgroundNoMatch').value, avoidRepeat: $('batchAvoidRepeat').checked } });
      if (draft.missing === 'message' && !draft.missingText) { $('batchSettingsError').textContent = '请填写固定文字，不能只有空白。'; $('batchMissingText').focus(); return; }
      const changed = JSON.stringify(policy.background) !== JSON.stringify(draft.background);
      policy = draft; saveOptions(); $('batchSettingsDialog').close();
      if (changed) await planRows();
      toast('批量导出设置已保存。');
    }
    function controls() {
      for (const input of dialog.querySelectorAll('[data-batch-edit]')) input.disabled = running || working || planning > 0;
      $('batchStop').hidden = !running; $('batchStart').hidden = running; $('batchRetryFailed').hidden = running;
    }
    function summary() {
      const finished = rows.filter(r => r.status === 'completed').length, failed = rows.filter(r => r.status === 'failed').length;
      const skipped = rows.filter(r => r.status === 'skipped').length, stopped = rows.filter(r => r.status === 'cancelled').length;
      $('batchCount').textContent = rows.length;
      $('batchSummary').textContent = rows.length ? `${rows.length} 首音乐 · 已完成 ${finished} · 失败 ${failed}${skipped ? ' · 跳过 ' + skipped : ''}${stopped ? ' · 已停止 ' + stopped : ''}${running ? ' · 批量处理中' : ''}` : '尚未添加音乐';
      $('batchTotalProgress').value = rows.length ? rows.reduce((sum, r) => sum + (['completed','failed','skipped','cancelled'].includes(r.status) ? 100 : r.percent || 0), 0) / rows.length : 0;
    }
    function statusCell(row) {
      const cell = dialog.querySelector(`[data-row-id="${row.id}"] .batch-status`); if (!cell) return;
      cell.replaceChildren(); cell.append(element('b', statusNames[row.status] || row.status));
      if (row.encoder) cell.append(element('small', row.encoder));
      if (row.status === 'rendering') { const bar = element('progress'); bar.max = 100; bar.value = row.percent || 0; cell.append(bar); }
      if (['ai_waiting','ai_prompting','ai_generating','ai_downloading','ai_checking'].includes(row.status)) { const bar = element('progress'); bar.max = 100; if (Number.isFinite(row.phasePercent)) bar.value = row.phasePercent; cell.append(bar); }
      if (row.message) cell.append(element('small', row.message));
      if (row.output) { const open = element('button', '打开位置', 'text-button'); open.addEventListener('click', attempt(() => rpc('showBatchOutput', { path: row.output }))); cell.append(open); }
      cell.dataset.status = row.status;
    }
    function paintRows() {
      $('batchRows').replaceChildren(); $('batchEmpty').hidden = rows.length > 0;
      for (const row of rows) {
        const tr = element('tr'); tr.dataset.rowId = row.id;
        const selectCell = element('td'), select = element('input'); select.type = 'checkbox'; select.checked = row.selected; select.dataset.batchEdit = ''; select.setAttribute('aria-label', '选择 ' + row.audio.title); select.addEventListener('change', () => { row.selected = select.checked; selectionHeaders(); }); selectCell.append(select);
        const music = element('td'); music.append(element('b', row.audio.title), element('small', `${row.audio.artist || '未知歌手'} · ${row.audio.format}`));
        const genre = element('input'); genre.value = row.genres; genre.placeholder = '填写音乐风格'; genre.setAttribute('list', 'genreSuggestions'); genre.setAttribute('aria-label', row.audio.title + ' 的音乐风格'); genre.dataset.batchEdit = ''; genre.className = 'batch-genre'; genre.addEventListener('change', attempt(async () => { row.genres = genre.value; row.status = 'waiting'; await planRows([row]); })); music.append(genre);
        const background = element('td');
        const chosen = policy.background.order === 'sequence' ? '顺序循环' : '随机选取';
        const source = policy.background.scope === 'all' ? `全库选择 · ${chosen}` : row.assignment?.matched ? `风格匹配 · ${chosen}` : policy.background.order === 'sequence' ? '无风格匹配 · 全库顺序循环' : '无风格匹配 · 全库随机';
        const willGenerate = ai.settings?.enabled && (ai.settings.mode === 'all' || !row.assignment);
        background.append(element('b', row.aiBackground?.name || (willGenerate ? '导出时生成 AI 背景' : row.assignment?.backgroundName || '等待分配背景')),
          element('small', row.aiBackground ? '本地 AI 背景' : willGenerate ? (row.assignment ? '已分配视频库背景可供失败回退' : '可直接生成，无需先导入视频库') : row.assignment ? source : row.assignmentReason || '请先导入视频库')); background.className = 'batch-background';
        if (ai.settings?.enabled || row.aiActualPrompt) {
          const prompt = element('button', row.aiPrompt ? '自定义 AI 提示词' : 'AI 提示词', 'text-button'); prompt.dataset.batchEdit = '';
          prompt.addEventListener('click', attempt(() => ai.editSong(song(row), row.status === 'completed' ? null : value => { row.aiPrompt = value; row.aiBackground = null; row.status = 'waiting'; paintRows(); })));
          background.append(prompt);
        }
        const output = element('td'), name = element('input'); name.value = row.fileName || ''; name.placeholder = '分配背景后生成文件名'; name.setAttribute('aria-label', row.audio.title + ' 的输出文件名'); name.dataset.batchEdit = ''; name.addEventListener('input', () => { row.fileName = name.value; row.customName = true; });
        const container = element('select'); container.setAttribute('aria-label', row.audio.title + ' 的导出格式'); container.dataset.batchEdit = '';
        for (const format of ['mp4','mkv','mov','webm']) { const option = element('option', format === 'webm' ? 'WebM' : format.toUpperCase()); option.value = format; container.append(option); }
        container.value = row.export.container; container.addEventListener('change', attempt(async () => { row.export.container = container.value; row.export.encoding = EncodingSettings.forContainer(row.export.encoding, container.value); row.customName = false; await planRows([row], false); })); output.append(name, container, element('small', `${row.export.resolution}P · ${row.export.fps} 帧 · ${EncodingSettings.summary(row.export.encoding, row.export.container)}`));
        const status = element('td', undefined, 'batch-status'); tr.append(selectCell, music, background, output, status); $('batchRows').append(tr); statusCell(row);
      }
      selectionHeaders(); controls(); summary();
    }
    function selectionHeaders() {
      $('batchSelectAll').checked = rows.length > 0 && rows.every(row => row.selected);
      $('batchSelectAll').indeterminate = rows.some(row => row.selected) && !rows.every(row => row.selected);
      $('librarySelectAll').checked = library.length > 0 && library.every(video => selectedVideos.has(video.id));
      $('librarySelectAll').indeterminate = library.some(video => selectedVideos.has(video.id)) && !library.every(video => selectedVideos.has(video.id));
    }
    function paintLibrary() {
      $('libraryRows').replaceChildren(); $('libraryEmpty').hidden = library.length > 0;
      for (const video of library) {
        const tr = element('tr'); tr.dataset.videoId = video.id;
        const cell = element('td'), check = element('input'); check.type = 'checkbox'; check.checked = selectedVideos.has(video.id); check.dataset.batchEdit = ''; check.setAttribute('aria-label', '选择视频 ' + video.name); check.addEventListener('change', () => { if (check.checked) selectedVideos.add(video.id); else selectedVideos.delete(video.id); selectionHeaders(); }); cell.append(check);
        const name = element('td'); name.append(element('b', video.name), element('small', video.path)); name.title = video.path;
        const genres = element('td'), input = element('input'); input.value = video.genres.join(', '); input.placeholder = '适合的风格，逗号分隔'; input.setAttribute('list', 'genreSuggestions'); input.setAttribute('aria-label', video.name + ' 适合的音乐风格'); input.dataset.batchEdit = ''; input.addEventListener('change', attempt(() => setVideoGenres([video.id], input.value))); genres.append(input);
        tr.append(cell, name, genres, element('td', video.available ? '可用' : '文件已缺失')); $('libraryRows').append(tr);
      }
      selectionHeaders(); controls();
    }
    async function planRows(target = rows.filter(r => r.status !== 'completed'), reroll = true) {
      if (!target.length) return;
      const targetIds = new Set(target.map(row => row.id));
      const revision = ++serial; planning++; controls();
      try {
        const result = await rpc('planBatch', { pattern: $('batchPattern').value, background: policy.background,
          rows: rows.map((row, index) => ({ id: row.id, audio: row.audio, genres: row.genres, container: row.export.container, sequence: index + 1,
            keepVideoId: !targetIds.has(row.id) || !reroll ? row.assignment?.videoId : undefined })) });
        if (revision !== serial) return;
        for (const assigned of result) {
          const row = rows.find(r => r.id === assigned.id); if (!row || !targetIds.has(row.id)) continue;
          row.assignment = assigned.backgroundPath ? assigned : null; row.assignmentReason = assigned.reason;
          if (!row.customName) row.fileName = assigned.fileName;
        }
      } catch (error) {
        if (revision === serial && reroll) for (const row of target) { row.assignment = null; row.assignmentReason = '分配失败，请检查设置后重新分配'; }
        throw error;
      } finally { planning--; paintRows(); }
    }
    function notice(result) {
      const messages = [...(result?.errors || [])]; if (result?.cancelled) messages.push('已取消剩余导入，已读取的素材保留。');
      $('batchNotice').textContent = messages.join('\n'); $('batchNoticeBox').hidden = !messages.length;
    }
    async function addMusic(result) {
      if (!result) return; notice(result);
      const added = [];
      for (const audio of result.items) {
        if (rows.some(row => row.audio.path.toLowerCase() === audio.path.toLowerCase())) continue;
        if (rows.length >= 500) throw new Error('本次队列最多添加 500 首音乐。');
        const row = { id: crypto.randomUUID(), audio, genres: audio.genre || '', selected: true, status: 'waiting', percent: 0, export: settings(), customName: false };
        rows.push(row); added.push(row);
      }
      paintRows(); await planRows(added);
    }
    async function setVideoGenres(ids, genres) {
      if (!ids.length) throw new Error('请先选择视频。');
      working = true; controls();
      try { library = await rpc('setLibraryGenres', { ids, genres }); paintLibrary(); await planRows(); }
      finally { working = false; controls(); }
    }
    async function open(imported) {
      if (!options) initOptions();
      if (!$('batchOutputDirectory').value) $('batchOutputDirectory').value = getTemplate().outputDirectory || '';
      if (!dialog.open) dialog.showModal();
      if (!running) await ai.load();
      if (!running) { library = await rpc('getVideoLibrary'); paintLibrary(); }
      if (imported) await addMusic(imported); else paintRows();
    }
    async function start(onlyFailed = false) {
      if (running || working || planning) return;
      if (onlyFailed) for (const row of rows) row.selected = row.status === 'failed';
      const target = rows.filter(row => row.selected && row.status !== 'completed');
      if (!target.length) throw new Error('请选择等待导出或需要重试的音乐。');
      if (!$('batchOutputDirectory').value) throw new Error('请选择批量输出目录。');
      if (!ai.settings) await ai.load();
      const useAiBackgrounds = ai.settings?.enabled === true;
      if (target.some(row => !row.assignment)) await planRows(target.filter(row => !row.assignment));
      if (!useAiBackgrounds && target.some(row => !row.assignment)) throw new Error(target.find(row => !row.assignment).assignmentReason || '请先导入可用的视频库并完成背景分配。');
      if (target.some(row => !row.fileName?.trim())) throw new Error('请填写每个任务的输出文件名。');
      const template = getTemplate(), layout = structuredClone(template.layout);
      const caption = layout.cards.find(card => card.id === 'caption'); if (caption) { caption.title = ''; caption.artist = ''; }
      const items = target.map(row => ({ id: row.id, album: row.audio.album, genres: row.genres, aiPrompt: row.aiPrompt || '', request: { audioPath: row.audio.path, backgroundPath: row.assignment?.backgroundPath || null, coverPath: row.audio.coverPath,
        title: row.audio.title, artist: row.audio.artist, lyrics: row.audio.localLyrics || '', duration: row.audio.duration,
        volume: template.volume, brightness: template.brightness, fontSize: template.fontSize, width: { '480':854,'720':1280,'1080':1920 }[row.export.resolution], height: Number(row.export.resolution), fps: Number(row.export.fps),
        outputDirectory: $('batchOutputDirectory').value, fileName: row.fileName, offset: 0, showSpectrum: template.showSpectrum, layout, encoding: row.export.encoding, container: row.export.container } }));
      for (const row of target) { row.status = 'waiting'; row.message = ''; row.encoder = ''; row.percent = 0; row.output = null; row.aiUsed = false; row.phasePercent = null; }
      $('batchResourceStatus').textContent = '正在准备设备与并发队列…';
      running = true; onRunning(true); paintRows(); saveOptions();
      try {
        const results = await rpc('batchRender', { items, searchLyrics: policy.search, missingLyrics: policy.missing, missingLyricsText: policy.missingText, continueOnError: policy.continue,
          autoEncoder: policy.autoEncoder, maxParallel: policy.maxParallel, resourceThreshold: policy.resourceThreshold, useAiBackgrounds });
        for (const result of results) progress(result);
        toast('批量任务已结束，可在队列中查看结果。');
      } catch (error) { for (const row of target.filter(r => !['completed','failed','skipped','cancelled'].includes(r.status))) { row.status = 'failed'; row.message = error.message; } throw error; }
      finally { running = false; onRunning(false); paintRows(); }
    }
    function progress(event) {
      if (event.event === 'scheduler') {
        const percent = value => Number.isFinite(value) ? Math.round(value) + '%' : '不可读取';
        $('batchResourceStatus').textContent = event.stopped ? '本次队列已结束' : `同时运行 ${event.active} / ${event.maximum} · 等待 ${event.pending} · CPU ${percent(event.cpu)} · GPU ${percent(event.gpu)}`;
        return;
      }
      const row = rows.find(r => r.id === event.id); if (!row) return;
      if (event.encoder) row.encoder = event.encoder;
      row.status = event.status; if (event.message) row.message = event.message;
      if (event.ai) {
        row.aiUsed = true; row.phasePercent = event.ai.percent;
        const percent = Number.isFinite(event.ai.percent) ? event.ai.percent : 0;
        row.percent = Math.max(row.percent || 0, event.status === 'ai_ready' ? 45 : event.status === 'ai_downloading' ? 35 + percent * .08 : event.status === 'ai_checking' ? 44 : event.status === 'ai_generating' ? 5 + percent * .3 : 2);
        if (event.ai.prompt) row.aiActualPrompt = event.ai.prompt;
        if (event.ai.backgroundPath) { row.aiBackground = { path: event.ai.backgroundPath, name: event.ai.backgroundName || 'AI 背景' }; const cell = dialog.querySelector(`[data-row-id="${row.id}"] .batch-background`); if (cell) { cell.querySelector('b').textContent = row.aiBackground.name; cell.querySelector('small').textContent = 'AI 背景已保存到本机'; } }
      }
      if (event.output) row.output = event.output;
      if (event.data?.event === 'progress') row.percent = Math.max(row.percent || 0, row.aiUsed ? 45 + event.data.percent * .55 : event.data.percent);
      if (event.data?.event === 'status') row.message = event.data.message;
      if (event.data?.event === 'analysisProgress') row.message = `${event.data.phase === 'background' ? '正在分析背景颜色' : '正在分析音频可视化'} ${Math.round(event.data.percent)}%`;
      if (row.status === 'optimizing' && event.data?.message) row.message = event.data.message;
      statusCell(row); summary();
    }
    $('openBatch').addEventListener('click', attempt(() => open()));
    $('batchAiSettings').addEventListener('click', attempt(() => ai.open()));
    $('batchQueueTab').addEventListener('click', () => { $('batchQueuePane').hidden = false; $('batchLibraryPane').hidden = true; $('batchQueueTab').classList.add('active'); $('batchLibraryTab').classList.remove('active'); });
    $('batchLibraryTab').addEventListener('click', () => { $('batchQueuePane').hidden = true; $('batchLibraryPane').hidden = false; $('batchLibraryTab').classList.add('active'); $('batchQueueTab').classList.remove('active'); });
    $('batchImportMusic').addEventListener('click', attempt(async () => { await addMusic(await rpc('pickBatchAudio')); }));
    $('batchImportVideos').addEventListener('click', attempt(async () => { const result = await rpc('pickLibraryVideos'); notice(result); library = await rpc('getVideoLibrary'); paintLibrary(); await planRows(); }));
    $('batchAssign').addEventListener('click', attempt(() => planRows(rows.filter(row => row.selected && row.status !== 'completed'))));
    $('batchRemove').addEventListener('click', () => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].selected) rows.splice(i, 1); paintRows(); });
    $('batchSelectAll').addEventListener('change', () => { for (const row of rows) row.selected = $('batchSelectAll').checked; paintRows(); });
    $('librarySelectAll').addEventListener('change', () => { for (const video of library) if ($('librarySelectAll').checked) selectedVideos.add(video.id); else selectedVideos.delete(video.id); paintLibrary(); });
    $('batchApplyMusicGenre').addEventListener('click', attempt(async () => { const target = rows.filter(r => r.selected && r.status !== 'completed'); if (!target.length) throw new Error('请先选择音乐。'); for (const row of target) { row.genres = $('batchMusicGenre').value; row.status = 'waiting'; } await planRows(target); }));
    $('batchApplyVideoGenre').addEventListener('click', attempt(() => setVideoGenres([...selectedVideos], $('batchVideoGenre').value)));
    $('batchRemoveVideos').addEventListener('click', attempt(async () => { if (!selectedVideos.size) throw new Error('请先选择视频。'); library = await rpc('removeLibraryVideos', { ids: [...selectedVideos] }); selectedVideos.clear(); paintLibrary(); await planRows(); }));
    $('batchPickOutput').addEventListener('click', attempt(async () => { const result = await rpc('pickOutput', { current: $('batchOutputDirectory').value }); if (result) { $('batchOutputDirectory').value = result; saveOptions(); } }));
    $('batchEncoding').addEventListener('click', () => editEncoding(encoding, (value, container) => { encoding = value; $('batchContainer').value = container; saveOptions(); }, '设置批量使用的文件格式、视频和音频编码，再点击“应用到选中任务”。逐首更换容器时会同步选择兼容的编码。', { container: $('batchContainer').value }));
    for (const id of ['batchContainer','batchResolution','batchFps','batchPattern']) $(id).addEventListener('change', saveOptions);
    $('batchExportSettings').addEventListener('click', openPolicy);
    $('batchBackgroundScope').addEventListener('change', policyFields); $('batchMissingLyrics').addEventListener('change', policyFields);
    $('batchSettingsDefaults').addEventListener('click', () => { fillPolicy(normalizePolicy()); $('batchSettingsError').textContent = ''; });
    $('batchSettingsApply').addEventListener('click', attempt(applyPolicy));
    $('batchDeviceTest').addEventListener('click', attempt(() => openDevice({ ...settings(), maxParallel: Number($('batchMaxParallel').value) || 3 })));
    $('batchApplySettings').addEventListener('click', attempt(async () => { const target = rows.filter(r => r.selected && r.status !== 'completed'); if (!target.length) throw new Error('请先选择音乐。'); for (const row of target) { row.export = settings(); row.customName = false; row.status = 'waiting'; } await planRows(target, false); saveOptions(); }));
    $('batchStart').addEventListener('click', attempt(() => start()));
    $('batchRetryFailed').addEventListener('click', attempt(() => start(true)));
    $('batchStop').addEventListener('click', attempt(async () => { $('batchStop').disabled = true; try { await rpc('cancelBatch'); } finally { $('batchStop').disabled = false; } }));
    return { open, progress, isRunning: () => running };
  }
  root.BatchExporter = { mount };
})(window);
