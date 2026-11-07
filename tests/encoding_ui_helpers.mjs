// Helpers for the native card editor and the workbench encoding dialog.
export async function openEditor(main, browser) {
  await main.locator('#moreSettings').click();
  for (let i = 0; i < 100; i++) {
    const editor = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/editor.html'));
    if (editor) {
      await editor.waitForFunction(() => document.getElementById('cardList').children.length === 6);
      return editor;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('更多设置窗口没有打开');
}
export async function openEncoding(main) {
  await main.locator('#openEncodingPanel').click();
  await main.locator('#encodingDialog').waitFor({ state: 'visible' });
  return main;
}
export async function finishEditor(editor, apply = true) {
  await Promise.all([editor.waitForEvent('close'), editor.locator(apply ? '#applyEditor' : '#cancelEditor').click()]);
}
