const { contextBridge, ipcRenderer } = require('electron');

function readOptionalEpisodeBound(id, payloadValue) {
  const input = document.getElementById(id);
  if (input && input.value.trim() === '') return undefined;
  return payloadValue;
}

function ensureHiddenPastedUrlsInput() {
  if (document.getElementById('pasted-urls')) return;
  const hiddenInput = document.createElement('textarea');
  hiddenInput.id = 'pasted-urls';
  hiddenInput.hidden = true;
  hiddenInput.value = '';
  document.body.appendChild(hiddenInput);
}

function rewriteRequestedUiText() {
  const pageTitle = document.getElementById('page-title');
  if (pageTitle?.textContent.trim() === '세로 스크롤 리더') pageTitle.textContent = '리더';
}

function injectLibraryDeleteButtons() {
  for (const card of document.querySelectorAll('.library-card')) {
    if (card.querySelector('.delete-series')) continue;

    const sourceButton = card.querySelector('.open-series-folder') || card.querySelector('.read-series');
    if (!sourceButton?.dataset.slug) continue;

    const title = card.querySelector('h3')?.textContent.trim() || sourceButton.dataset.slug;
    const button = document.createElement('button');
    button.className = 'button danger delete-series';
    button.dataset.slug = sourceButton.dataset.slug;
    button.dataset.title = title;
    button.textContent = '삭제';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = await ipcRenderer.invoke('library:delete-series', button.dataset.slug, button.dataset.title);
      if (result?.deleted) document.getElementById('refresh-library')?.click();
    });

    const buttons = card.querySelector('.library-buttons');
    if (buttons) {
      buttons.style.gridTemplateColumns = '1fr auto auto';
      buttons.appendChild(button);
    }
  }
}

function setPdfProgress(percent, status, detail = '') {
  const panel = document.getElementById('pdf-progress-panel');
  if (!panel) return;

  panel.hidden = false;
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const bar = document.getElementById('pdf-progress-bar');
  const percentText = document.getElementById('pdf-progress-percent');
  const statusText = document.getElementById('pdf-progress-status');
  const detailText = document.getElementById('pdf-progress-detail');

  if (bar) bar.style.width = `${safe}%`;
  if (percentText) percentText.textContent = `${Math.round(safe)}%`;
  if (statusText) statusText.textContent = status || 'PDF 준비 중';
  if (detailText) detailText.textContent = detail;
}

function setPdfExportRunning(running) {
  const exportButton = document.getElementById('export-button');
  const cancelButton = document.getElementById('pdf-cancel-button');
  const qualitySelect = document.getElementById('pdf-quality');
  if (exportButton) exportButton.disabled = running;
  if (cancelButton) cancelButton.disabled = !running;
  if (qualitySelect) qualitySelect.disabled = running;
}

function injectPdfExportControls() {
  const exportPanel = document.getElementById('tab-export');
  const exportButton = document.getElementById('export-button');
  const resultBox = document.getElementById('export-result');
  if (!exportPanel || !exportButton || !resultBox) return;

  const eyebrow = exportPanel.querySelector('.eyebrow');
  const heading = exportPanel.querySelector('h2');
  const description = exportPanel.querySelector('p');
  if (eyebrow) eyebrow.textContent = 'PDF EXPORT';
  if (heading) heading.textContent = '회차별 PDF 내보내기';
  if (description) description.textContent = '화질을 선택한 뒤 저장한 이미지를 회차별 PDF로 내보냅니다.';
  exportButton.textContent = 'PDF 내보내기';

  if (!document.getElementById('pdf-quality')) {
    const field = document.createElement('label');
    field.className = 'field';
    field.innerHTML = `
      <span>PDF 화질</span>
      <select id="pdf-quality">
        <option value="high">고화질 · 선명함 우선</option>
        <option value="standard" selected>표준 · 권장</option>
        <option value="low">저화질 · 작은 용량</option>
      </select>
    `;
    exportButton.parentElement?.insertBefore(field, exportButton);
  }

  if (!document.getElementById('pdf-progress-panel')) {
    const panel = document.createElement('div');
    panel.id = 'pdf-progress-panel';
    panel.className = 'result-box';
    panel.hidden = true;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;">
        <strong id="pdf-progress-status">PDF 준비 중</strong>
        <strong id="pdf-progress-percent">0%</strong>
      </div>
      <div style="height:9px;border-radius:999px;background:#252a36;overflow:hidden;">
        <div id="pdf-progress-bar" style="width:0%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#7c5cff,#36d2ff);transition:width .2s ease;"></div>
      </div>
      <div id="pdf-progress-detail" style="margin-top:9px;color:#969dad;font-size:12px;">대기 중</div>
      <button id="pdf-cancel-button" class="button danger" style="margin-top:12px;" disabled>PDF 내보내기 취소</button>
    `;
    resultBox.insertAdjacentElement('afterend', panel);
    panel.querySelector('#pdf-cancel-button')?.addEventListener('click', async () => {
      await ipcRenderer.invoke('export:pdf-cancel');
      setPdfProgress(
        Number(document.getElementById('pdf-progress-percent')?.textContent.replace('%', '')) || 0,
        '취소 요청 중',
        '현재 처리 중인 페이지가 끝나면 중지됩니다.',
      );
    });
  }
}

function handlePdfProgress(event) {
  switch (event.type) {
    case 'pdf-start':
      setPdfExportRunning(true);
      setPdfProgress(0, `${event.seriesTitle} PDF 내보내는 중`, `${event.qualityLabel} · 총 ${event.totalEpisodes}개 회차`);
      break;
    case 'pdf-episode-start':
      setPdfProgress(((event.episodeIndex - 1) / event.episodeTotal) * 100, `${event.episode}화 처리 중`, `회차 ${event.episodeIndex}/${event.episodeTotal} · 페이지 0/${event.pageTotal}`);
      break;
    case 'pdf-page-progress': {
      const percent = (((event.episodeIndex - 1) / event.episodeTotal) + ((event.page / event.pageTotal) / event.episodeTotal)) * 100;
      setPdfProgress(percent, `${event.episode}화 이미지 압축 중`, `회차 ${event.episodeIndex}/${event.episodeTotal} · 페이지 ${event.page}/${event.pageTotal}`);
      break;
    }
    case 'pdf-episode-complete':
      setPdfProgress((event.episodeIndex / event.episodeTotal) * 100, `${event.episode}화 PDF 저장 완료`, `회차 ${event.episodeIndex}/${event.episodeTotal}`);
      break;
    case 'pdf-complete':
      setPdfExportRunning(false);
      setPdfProgress(100, 'PDF 내보내기 완료', `${event.exportedCount}/${event.totalEpisodes}개 회차 저장 완료`);
      break;
    case 'pdf-cancelled':
      setPdfExportRunning(false);
      setPdfProgress(0, 'PDF 내보내기 중지됨', `${event.exportedCount}개 회차까지 저장되었습니다.`);
      break;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  ensureHiddenPastedUrlsInput();
  rewriteRequestedUiText();
  injectLibraryDeleteButtons();
  injectPdfExportControls();

  const minInput = document.getElementById('min-episode');
  const maxInput = document.getElementById('max-episode');
  if (minInput) {
    minInput.value = '';
    minInput.placeholder = '비워두면 첫 회차부터';
  }
  if (maxInput) {
    maxInput.value = '';
    maxInput.placeholder = '비워두면 최신 회차까지';
  }

  ipcRenderer.on('crawler:progress', (_event, payload) => handlePdfProgress(payload || {}));

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      rewriteRequestedUiText();
      injectLibraryDeleteButtons();
      injectPdfExportControls();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

contextBridge.exposeInMainWorld('tokiAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseLibrary: () => ipcRenderer.invoke('settings:choose-library'),
  openLibrary: () => ipcRenderer.invoke('settings:open-library'),

  scanSource: (payload) => ipcRenderer.invoke('crawler:scan', {
    ...payload,
    minEpisode: readOptionalEpisodeBound('min-episode', payload.minEpisode),
    maxEpisode: readOptionalEpisodeBound('max-episode', payload.maxEpisode),
  }),
  startDownload: (payload) => ipcRenderer.invoke('crawler:start', payload),
  cancelDownload: () => ipcRenderer.invoke('crawler:cancel'),
  toggleWorkerWindow: (show) => ipcRenderer.invoke('crawler:toggle-window', show),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  getEpisodeImages: (seriesSlug, episodeNumber) => ipcRenderer.invoke('library:episode-images', seriesSlug, episodeNumber),
  openSeriesFolder: (seriesSlug) => ipcRenderer.invoke('library:open-series', seriesSlug),
  deleteSeries: (seriesSlug, seriesTitle) => ipcRenderer.invoke('library:delete-series', seriesSlug, seriesTitle),

  exportStaticReader: (seriesSlug) => ipcRenderer.invoke('export:pdf', {
    seriesSlug,
    quality: document.getElementById('pdf-quality')?.value || 'standard',
  }),
  cancelPdfExport: () => ipcRenderer.invoke('export:pdf-cancel'),

  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('crawler:progress', listener);
    return () => ipcRenderer.removeListener('crawler:progress', listener);
  },
});
