const { app } = require('electron');

function installGenericExportLabel(window) {
  if (!window || window.isDestroyed()) return;
  const url = String(window.webContents.getURL() || '');
  if (!url.startsWith('file:')) return;

  window.webContents.executeJavaScript(`
    (() => {
      if (window.__ntkGenericExportLabelInstalled) return;
      window.__ntkGenericExportLabelInstalled = true;

      function apply() {
        const panel = document.getElementById('tab-export');
        if (!panel) return;

        const eyebrow = panel.querySelector('.eyebrow');
        const heading = panel.querySelector('h2');
        const description = panel.querySelector('p');
        const button = document.getElementById('export-button');

        if (eyebrow && eyebrow.textContent !== 'EXPORT') eyebrow.textContent = 'EXPORT';
        if (heading && heading.textContent !== '내보내기') heading.textContent = '내보내기';
        if (description && description.textContent !== '선택한 작품의 형식에 맞게 저장합니다.') {
          description.textContent = '선택한 작품의 형식에 맞게 저장합니다.';
        }
        if (button && button.textContent !== '내보내기') button.textContent = '내보내기';
      }

      apply();
      document.getElementById('export-series')?.addEventListener('change', () => queueMicrotask(apply));

      let pending = false;
      const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          apply();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    })()
  `).catch(() => undefined);
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => installGenericExportLabel(window));
});

module.exports = { installGenericExportLabel };
