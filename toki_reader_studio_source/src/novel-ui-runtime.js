const { app } = require('electron');

function installUiPatch(window) {
  if (!window || window.isDestroyed()) return;
  const url = window.webContents.getURL();
  if (!url.startsWith('file:')) return;

  window.webContents.executeJavaScript(`
    (() => {
      if (window.__ntkNovelUiPatched) return;
      window.__ntkNovelUiPatched = true;

      const sourceInput = document.getElementById('source-url');
      const titleInput = document.getElementById('series-title');

      if (sourceInput && titleInput) {
        let previousUrl = sourceInput.value.trim();
        sourceInput.addEventListener('input', () => {
          const nextUrl = sourceInput.value.trim();
          if (nextUrl !== previousUrl) {
            titleInput.value = '';
            previousUrl = nextUrl;
          }
        });
      }

      const originalLoadReaderEpisode = window.loadReaderEpisode;
      if (typeof originalLoadReaderEpisode !== 'function') return;

      window.loadReaderEpisode = async function patchedLoadReaderEpisode(seriesSlug, episodeNumber) {
        await originalLoadReaderEpisode(seriesSlug, episodeNumber);

        let items = [];
        try {
          items = await window.tokiAPI.getEpisodeImages(seriesSlug, Number(episodeNumber));
        } catch {
          return;
        }

        const textItem = items.find((item) => item && item.type === 'text');
        if (!textItem) return;

        const canvas = document.getElementById('reader-canvas');
        const empty = document.getElementById('reader-empty');
        const status = document.getElementById('global-status');
        if (!canvas) return;

        canvas.innerHTML = '';
        const article = document.createElement('article');
        article.className = 'ntk-novel-reader';
        article.textContent = textItem.text || '';
        article.style.cssText = [
          'width:min(860px,calc(100% - 40px))',
          'margin:32px auto 80px',
          'padding:48px 56px',
          'box-sizing:border-box',
          'white-space:pre-wrap',
          'word-break:keep-all',
          'overflow-wrap:break-word',
          'font-size:18px',
          'line-height:2',
          'letter-spacing:.01em',
          'color:#e8eaf0',
          'background:#11141b',
          'border:1px solid #2a2f3b',
          'border-radius:18px'
        ].join(';');
        canvas.appendChild(article);
        canvas.classList.add('active');
        if (empty) empty.style.display = 'none';
        if (status) status.textContent = episodeNumber + '화 · 글';
        window.scrollTo({ top: 0, behavior: 'instant' });
      };
    })()
  `).catch(() => undefined);
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => installUiPatch(window));
});

module.exports = { installUiPatch };
