(function (root) {
  'use strict';
  function mount({ rpc, toast, getSong, onChange }) {
    const $ = id => document.getElementById(id);
    let view, ready, busy = false, previewing = false, activeSong, activeSettings, applyPrompt, promptRevision = 0;
    const fields = () => [...document.querySelectorAll('[data-ai-field]')];
    async function load() { view = await rpc('getAiVideoSettings'); onChange?.(view.settings); return view.settings; }
    function fill(settings) {
      for (const field of fields()) { const value = settings[field.dataset.aiField]; if (field.type === 'checkbox') field.checked = !!value; else field.value = value ?? ''; }
      $('aiClearKey').checked = false; $('aiClearOptimizerKey').checked = false;
      document.querySelector('[data-ai-field=apiKey]').placeholder = view?.hasApiKey ? '已保存，留空保留' : '填写 API 密钥';
      document.querySelector('[data-ai-field=optimizerKey]').placeholder = view?.hasOptimizerKey ? '已保存，留空保留' : '填写独立密钥';
      $('aiLoadWarning').textContent = view?.loadError || ''; $('aiVideoError').textContent = ''; $('aiVideoSaveStatus').textContent = ''; $('aiModelsStatus').textContent = '';
    }
    function read() {
      const draft = { ...view.settings };
      for (const field of fields()) {
        if (field.type !== 'checkbox' && field.type !== 'number' && field.value.length > 30000) throw new Error('配置内容过长。');
        if (field.type === 'number') {
          if (field.dataset.aiField === 'temperature' && field.value === '') draft.temperature = null;
          else { if (!field.value || !field.checkValidity()) { field.focus(); throw new Error('请检查数值范围和步长。'); } draft[field.dataset.aiField] = Number(field.value); }
        } else draft[field.dataset.aiField] = field.type === 'checkbox' ? field.checked : field.dataset.aiField === 'authPrefix' ? field.value : field.value.trim();
      }
      for (const name of ['headersJson','requestJson','extraJson']) { try { const parsed = JSON.parse(draft[name]); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); } catch { throw new Error('高级接口中的 JSON 配置无效。'); } }
      return draft;
    }
    function setBusy(value) {
      busy = value;
      for (const field of $('aiVideoDialog').querySelectorAll('input,select,textarea,button:not([data-ai-tab]):not([data-ai-close])')) field.disabled = value;
    }
    function attempt(fn, errorId = 'aiVideoError') { return async () => { $(errorId).textContent = ''; try { await fn(); } catch (error) { if (!error.cancelled) $(errorId).textContent = error.message; } }; }
    async function ensure() {
      if (!ready) ready = (async () => {
        const response = await fetch('ai-video-dialog.html'); if (!response.ok) throw new Error('AI 设置窗口资源缺失，请重新安装程序。');
        const host = document.createElement('div'); host.innerHTML = await response.text(); document.body.append(host);
        for (const button of host.querySelectorAll('[data-ai-close]')) button.addEventListener('click', () => { if (!busy) $('aiVideoDialog').close(); });
        $('aiVideoDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        for (const button of host.querySelectorAll('[data-ai-tab]')) button.addEventListener('click', () => {
          for (const tab of host.querySelectorAll('[data-ai-tab]')) { const selected = tab === button; tab.classList.toggle('active', selected); tab.setAttribute('aria-current', selected ? 'page' : 'false'); }
          for (const pane of host.querySelectorAll('[data-ai-pane]')) pane.hidden = pane.dataset.aiPane !== button.dataset.aiTab;
        });
        $('aiVideoSave').addEventListener('click', attempt(async () => {
          const settings = read(); setBusy(true); $('aiVideoSaveStatus').textContent = '正在保存…';
          try { view = await rpc('saveAiVideoSettings', { settings, clearKey: $('aiClearKey').checked, clearOptimizerKey: $('aiClearOptimizerKey').checked }); onChange?.(view.settings); $('aiVideoDialog').close(); toast('AI 背景设置已保存。'); }
          finally { setBusy(false); $('aiVideoSaveStatus').textContent = ''; for (const field of fields().filter(field => field.type === 'password')) field.value = ''; }
        }));
        $('aiVideoDefaults').addEventListener('click', attempt(async () => fill(await rpc('getAiVideoDefaults'))));
        $('aiPickDirectory').addEventListener('click', attempt(async () => { const field = document.querySelector('[data-ai-field=directory]'); const directory = await rpc('pickOutput', { current: field.value }); if (directory) field.value = directory; }));
        $('aiReadModels').addEventListener('click', attempt(async () => {
          const settings = read(); setBusy(true); $('aiModelsStatus').textContent = '正在读取…';
          try { const models = await rpc('aiVideoModels', { settings }); $('aiVideoModels').replaceChildren(...models.map(id => { const option = document.createElement('option'); option.value = id; return option; })); $('aiModelsStatus').textContent = `已读取 ${models.length} 个模型，可输入或从列表选择。`; }
          finally { setBusy(false); }
        }));
        $('aiPreviewDraft').addEventListener('click', attempt(() => editSong(getSong?.() || { title: '示例歌曲', genres: '氛围' }, null, read())));
        for (const button of host.querySelectorAll('[data-prompt-close]')) button.addEventListener('click', () => $('aiPromptDialog').close());
        $('aiPromptDialog').addEventListener('close', () => { ++promptRevision; if (previewing) rpc('cancelAiVideoPreview').catch(() => {}); });
        $('aiPromptRebuild').addEventListener('click', attempt(() => build(false), 'aiPromptError'));
        $('aiPromptOptimize').addEventListener('click', attempt(() => build(true), 'aiPromptError'));
        $('aiPromptCancelRequest').addEventListener('click', attempt(async () => { await rpc('cancelAiVideoPreview'); }, 'aiPromptError'));
        $('aiPromptApply').addEventListener('click', attempt(async () => { const prompt = $('aiPromptText').value.trim(); if (!prompt) throw new Error('提示词不能为空。'); applyPrompt?.(prompt); $('aiPromptDialog').close(); }, 'aiPromptError'));
      })().catch(error => { ready = null; throw error; });
      await ready;
    }
    function previewControls(value) {
      previewing = value; $('aiPromptText').disabled = value;
      for (const id of ['aiPromptRebuild','aiPromptOptimize','aiPromptApply']) $(id).disabled = value;
      $('aiPromptCancelRequest').hidden = !value;
    }
    async function build(optimize) {
      if (previewing) return;
      const revision = ++promptRevision;
      const song = { ...activeSong, prompt: optimize ? $('aiPromptText').value : '' };
      previewControls(true); $('aiPromptStatus').textContent = optimize ? '正在调用文字模型优化…' : '正在整理场景与布局…';
      try {
        const result = await rpc('previewAiVideoPrompt', { song, settings: activeSettings, optimize });
        if (revision !== promptRevision) return;
        $('aiPromptText').value = result.prompt; $('aiPromptStatus').textContent = result.warning || (optimize ? '优化完成，可继续修改后用于这首音乐。' : '已生成内置提示词。此操作没有提交视频生成任务。');
      } finally { previewControls(false); }
    }
    async function editSong(song, apply, settings) {
      await ensure(); if (!view) await load();
      activeSong = { ...song }; activeSettings = settings || view.settings; applyPrompt = apply;
      $('aiPromptTitle').textContent = apply ? '这首音乐的背景提示词' : '背景提示词预览';
      $('aiPromptSong').textContent = [song.title, song.artist, song.genres].filter(Boolean).join(' · ');
      $('aiPromptError').textContent = ''; $('aiPromptApply').hidden = !apply;
      $('aiPromptText').value = song.prompt || ''; $('aiPromptStatus').textContent = '';
      if (!$('aiPromptDialog').open) $('aiPromptDialog').showModal();
      if (!song.prompt) await build(false);
    }
    async function open() { await ensure(); await load(); fill(view.settings); if (!$('aiVideoDialog').open) $('aiVideoDialog').showModal(); }
    return { open, load, editSong, get settings() { return view?.settings; } };
  }
  root.AiVideoUI = { mount };
})(window);
