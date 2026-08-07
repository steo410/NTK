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

      function cleanNovelUiTail(value) {
        const lines = String(value || '')
          .replace(/\\r\\n?/g, '\\n')
          .replace(/\\u00a0/g, ' ')
          .split('\\n');

        const isTail = (raw) => {
          const line = String(raw || '').trim();
          if (!line) return false;
          if (/^(?:🔊|⚙️?|💬|🔈|🔉|🔇)+$/u.test(line.replace(/\\s+/g, ''))) return true;
          const noIcons = line.replace(/[🔊⚙️💬🔈🔉🔇]/gu, '').trim();
          if (/^댓글\\s*\\d+\\s*개(?:\\s+(?:등록순|최신순))*$/u.test(noIcons)) return true;
          if (/^(?:등록순|최신순)(?:\\s+(?:등록순|최신순))*$/u.test(noIcons)) return true;
          if (/^(?:댓글\\s*\\d+\\s*개\\s*)?(?:등록순\\s*)?(?:최신순\\s*)?$/u.test(noIcons) && /(?:댓글|등록순|최신순)/u.test(noIcons)) return true;
          return false;
        };

        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        let cutoff = lines.length;
        for (let index = Math.max(0, lines.length - 18); index < lines.length; index += 1) {
          if (isTail(lines[index])) {
            cutoff = index;
            break;
          }
        }
        return lines.slice(0, cutoff).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      }

      const originalLoadReaderEpisode = window.loadReaderEpisode;
      if (typeof originalLoadReaderEpisode === 'function') {
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
          article.textContent = cleanNovelUiTail(textItem.text || '');
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
      }

      let catalog = new Map();
      let catalogRefreshTimer = null;

      function typeLabel(type) {
        if (type === 'novel') return 'NOVEL';
        if (type === 'manhwa') return 'MANHWA';
        return 'WEBTOON';
      }

      function inferTypeFromSlug(slug) {
        const value = String(slug || '').toLowerCase();
        if (value.startsWith('novel-')) return 'novel';
        if (value.startsWith('manhwa-')) return 'manhwa';
        return 'webtoon';
      }

      function ensureLibraryTools() {
        const panel = document.getElementById('tab-library');
        const heading = panel?.querySelector('.section-heading');
        if (!panel || !heading || document.getElementById('library-filter-tools')) return;

        const tools = document.createElement('div');
        tools.id = 'library-filter-tools';
        tools.style.cssText = [
          'display:grid',
          'grid-template-columns:180px minmax(220px,1fr)',
          'gap:12px',
          'margin:-6px 0 22px',
          'max-width:680px'
        ].join(';');
        tools.innerHTML = [
          '<select id="library-type-filter" aria-label="보관함 카테고리">',
          '<option value="all">전체</option>',
          '<option value="webtoon">Webtoon</option>',
          '<option value="manhwa">Manhwa</option>',
          '<option value="novel">Novel</option>',
          '</select>',
          '<input id="library-title-search" type="search" placeholder="제목으로 검색" aria-label="보관함 제목 검색">'
        ].join('');
        heading.insertAdjacentElement('afterend', tools);
        tools.querySelector('#library-type-filter')?.addEventListener('change', applyLibraryFilter);
        tools.querySelector('#library-title-search')?.addEventListener('input', applyLibraryFilter);
      }

      function applyLibraryFilter() {
        const filter = document.getElementById('library-type-filter')?.value || 'all';
        const query = String(document.getElementById('library-title-search')?.value || '').trim().toLocaleLowerCase('ko');
        const cards = [...document.querySelectorAll('#library-grid .library-card')];

        for (const card of cards) {
          const sourceButton = card.querySelector('.read-series,.open-series-folder');
          const slug = sourceButton?.dataset.slug || '';
          const item = catalog.get(slug);
          const type = item?.contentType || inferTypeFromSlug(slug);
          const title = String(card.querySelector('h3')?.textContent || item?.title || '').toLocaleLowerCase('ko');
          const visible = (filter === 'all' || filter === type) && (!query || title.includes(query));
          card.style.display = visible ? '' : 'none';

          const meta = card.querySelector('.library-meta');
          if (meta) {
            let badge = meta.querySelector('.ntk-content-type-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'ntk-content-type-badge';
              badge.style.cssText = 'display:inline-block;margin-right:8px;padding:2px 7px;border:1px solid rgba(124,92,255,.35);border-radius:999px;color:#b9abff;font-size:9px;font-weight:800;letter-spacing:.08em;';
              meta.prepend(badge);
            }
            badge.textContent = typeLabel(type);
          }
        }

        const empty = document.getElementById('library-filter-empty');
        const visibleCount = cards.filter((card) => card.style.display !== 'none').length;
        if (empty) empty.remove();
        if (cards.length && visibleCount === 0) {
          const message = document.createElement('article');
          message.id = 'library-filter-empty';
          message.className = 'card';
          message.innerHTML = '<h3>검색 결과가 없습니다.</h3><p>카테고리나 제목 검색어를 변경해 보세요.</p>';
          document.getElementById('library-grid')?.appendChild(message);
        }
      }

      async function refreshCatalog() {
        try {
          const result = await window.tokiAPI.listLibrary();
          catalog = new Map((result?.series || []).map((item) => [item.slug, item]));
          applyLibraryFilter();
          updateExportMode();
        } catch {}
      }

      function scheduleCatalogRefresh() {
        clearTimeout(catalogRefreshTimer);
        catalogRefreshTimer = setTimeout(refreshCatalog, 100);
      }

      function selectedExportSeries() {
        const slug = document.getElementById('export-series')?.value || '';
        return catalog.get(slug) || null;
      }

      function updateExportMode() {
        const panel = document.getElementById('tab-export');
        const selected = selectedExportSeries();
        if (!panel) return;
        const type = selected?.contentType || (selected ? inferTypeFromSlug(selected.slug) : 'webtoon');
        const novel = type === 'novel';
        const eyebrow = panel.querySelector('.eyebrow');
        const heading = panel.querySelector('h2');
        const description = panel.querySelector('p');
        const button = document.getElementById('export-button');
        const quality = document.getElementById('pdf-quality')?.closest('.field');
        const progressPanel = document.getElementById('pdf-progress-panel');

        if (novel) {
          if (eyebrow) eyebrow.textContent = 'TXT EXPORT';
          if (heading) heading.textContent = '소설 TXT 내보내기';
          if (description) description.textContent = '다운로드한 모든 회차를 순서대로 하나의 TXT 파일로 저장합니다.';
          if (button) button.textContent = 'TXT 내보내기';
          if (quality) quality.style.display = 'none';
          if (progressPanel) progressPanel.hidden = true;
        } else {
          if (eyebrow) eyebrow.textContent = 'PDF EXPORT';
          if (heading) heading.textContent = '회차별 PDF 내보내기';
          if (description) description.textContent = '화질을 선택한 뒤 저장한 이미지를 회차별 PDF로 내보냅니다.';
          if (button) button.textContent = 'PDF 내보내기';
          if (quality) quality.style.display = '';
        }
      }

      ensureLibraryTools();
      refreshCatalog();

      const exportSelect = document.getElementById('export-series');
      if (exportSelect) {
        exportSelect.addEventListener('change', () => {
          updateExportMode();
        });
      }

      const exportButton = document.getElementById('export-button');
      if (exportButton) {
        exportButton.addEventListener('click', async (event) => {
          const selected = selectedExportSeries();
          if (!selected || selected.contentType !== 'novel') return;

          // app.js의 PDF용 클릭 핸들러보다 먼저 novel TXT 내보내기를 처리합니다.
          event.preventDefault();
          event.stopImmediatePropagation();
          const resultBox = document.getElementById('export-result');
          exportButton.disabled = true;
          try {
            const result = await window.tokiAPI.exportStaticReader(selected.slug);
            if (result?.cancelled) {
              if (resultBox) resultBox.textContent = 'TXT 내보내기를 취소했습니다.';
            } else if (resultBox) {
              resultBox.innerHTML = '<strong>' + Number(result?.episodeCount || 0) + '개 회차 TXT 내보내기 완료</strong><br>' + String(result?.destination || '');
            }
          } catch (error) {
            if (resultBox) resultBox.textContent = String(error?.message || error);
          } finally {
            exportButton.disabled = false;
          }
        }, true);
      }

      const libraryGrid = document.getElementById('library-grid');
      if (libraryGrid) {
        const observer = new MutationObserver(() => {
          ensureLibraryTools();
          scheduleCatalogRefresh();
        });
        observer.observe(libraryGrid, { childList: true, subtree: true });
      }
    })()
  `).catch(() => undefined);
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => installUiPatch(window));
});

module.exports = { installUiPatch };
