const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const consoleLogs = new Map();
let lastDiagnosticFolder = '';

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function findScanWindow() {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());

  return (
    windows.find((window) => /NTK 회차 검색|작업 브라우저/.test(window.getTitle())) ||
    windows.find((window) => /^https?:\/\//.test(window.webContents.getURL())) ||
    null
  );
}

async function openDiagnosticFolder() {
  const folder = lastDiagnosticFolder || path.join(app.getPath('userData'), 'diagnostics');
  await fsp.mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  return { folder, error };
}

function openScanDevTools() {
  const window = findScanWindow();

  if (!window) {
    return { opened: false, error: '작업 브라우저를 찾지 못했습니다.' };
  }

  window.show();
  window.focus();
  window.webContents.openDevTools({ mode: 'detach', activate: true });
  return { opened: true, url: window.webContents.getURL() };
}

function attachWindow(window) {
  if (!window || window.isDestroyed()) return;
  const id = window.webContents.id;

  if (!consoleLogs.has(id)) {
    consoleLogs.set(id, []);

    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const entries = consoleLogs.get(id) || [];
      entries.push({
        time: new Date().toISOString(),
        level,
        message,
        line,
        sourceId,
      });

      if (entries.length > 500) entries.splice(0, entries.length - 500);
      consoleLogs.set(id, entries);
    });

    window.on('closed', () => consoleLogs.delete(id));
  }

  window.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();

    if (key === 'f12') {
      event.preventDefault();
      openScanDevTools();
      return;
    }

    if (input.control && input.shift && key === 'd') {
      event.preventDefault();
      openDiagnosticFolder();
    }
  });
}

app.on('browser-window-created', (_event, window) => attachWindow(window));
for (const window of BrowserWindow.getAllWindows()) attachWindow(window);

async function inspectPage(window, sourceUrl) {
  const seriesMatch = String(sourceUrl || '').match(/\/webtoon\/(\d+)/);
  const seriesId = seriesMatch ? seriesMatch[1] : '';

  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const matchingAnchors = [];
      const allAnchors = [...document.querySelectorAll('a[href]')];

      for (const anchor of allAnchors) {
        let href = '';

        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }

        if (seriesId && !href.includes('/webtoon/' + seriesId + '/')) continue;

        const row = anchor.closest(
          "li, article, tr, [class*='episode'], [class*='list-item'], " +
          "[class*='webtoon-item'], [class*='item'], [class*='row'], [class*='card']"
        ) || anchor.parentElement || anchor;
        const image = row.querySelector('img');
        const rect = row.getBoundingClientRect();

        matchingAnchors.push({
          href,
          anchorText: clean(anchor.innerText || anchor.textContent),
          parentText: clean(anchor.parentElement?.innerText || anchor.parentElement?.textContent),
          rowText: clean(row.innerText || row.textContent),
          rowTag: row.tagName,
          rowClass: typeof row.className === 'string' ? row.className : '',
          imageAlt: clean(image?.alt),
          imageTitle: clean(image?.title),
          imageSrc: image?.currentSrc || image?.src || '',
          visible: rect.width > 0 && rect.height > 0,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }

      const scrollContainers = [];
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...document.querySelectorAll('body *'),
      ].filter(Boolean);
      const seen = new Set();

      for (const element of candidates) {
        if (seen.has(element)) continue;
        seen.add(element);

        const scrollHeight = Number(element.scrollHeight || 0);
        const clientHeight = Number(element.clientHeight || 0);
        if (scrollHeight <= clientHeight + 20) continue;

        const style = getComputedStyle(element);
        scrollContainers.push({
          tag: element.tagName,
          id: element.id || '',
          className: typeof element.className === 'string' ? element.className : '',
          overflowY: style.overflowY,
          scrollTop: Number(element.scrollTop || 0),
          scrollHeight,
          clientHeight,
          maxScroll: scrollHeight - clientHeight,
        });
      }

      scrollContainers.sort((a, b) => b.maxScroll - a.maxScroll);

      const bodyText = clean(document.body?.innerText || '');
      const episodeTextSamples = [...new Set(
        bodyText
          .split(/\\n+/)
          .map(clean)
          .filter((value) => /\\d+(?:\\.\\d+)?\\s*화/.test(value))
      )].slice(0, 300);

      return {
        capturedAt: new Date().toISOString(),
        location: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: bodyText.length,
        anchorCount: allAnchors.length,
        matchingAnchorCount: matchingAnchors.length,
        matchingAnchors: matchingAnchors.slice(0, 400),
        scrollContainers: scrollContainers.slice(0, 80),
        episodeTextSamples,
        bodyTextPreview: bodyText.slice(0, 20000),
      };
    })()
  `);
}

async function captureDiagnostics(payload = {}) {
  const root = path.join(app.getPath('userData'), 'diagnostics');
  const folder = path.join(root, timestamp());
  await fsp.mkdir(folder, { recursive: true });
  lastDiagnosticFolder = folder;

  const window = findScanWindow();
  const report = {
    capturedAt: new Date().toISOString(),
    sourceUrl: payload.sourceUrl || '',
    error: payload.error || '',
    appVersion: app.getVersion(),
    scanWindowFound: Boolean(window),
    diagnosticFolder: folder,
  };

  if (window) {
    attachWindow(window);
    report.windowTitle = window.getTitle();
    report.currentUrl = window.webContents.getURL();
    report.consoleLogs = consoleLogs.get(window.webContents.id) || [];

    try {
      Object.assign(report, await inspectPage(window, payload.sourceUrl || ''));
    } catch (error) {
      report.inspectionError = String(error?.stack || error);
    }

    try {
      const html = await window.webContents.executeJavaScript('document.documentElement.outerHTML');
      await fsp.writeFile(path.join(folder, 'page.html'), html, 'utf-8');
    } catch (error) {
      report.htmlSaveError = String(error?.stack || error);
    }

    try {
      const image = await window.webContents.capturePage();
      await fsp.writeFile(path.join(folder, 'visible-page.png'), image.toPNG());
    } catch (error) {
      report.screenshotError = String(error?.stack || error);
    }
  }

  await fsp.writeFile(
    path.join(folder, 'diagnostic.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );

  await fsp.writeFile(
    path.join(folder, 'console.log'),
    (report.consoleLogs || [])
      .map((entry) =>
        `[${entry.time}] level=${entry.level} ${entry.message} (${entry.sourceId}:${entry.line})`
      )
      .join('\n'),
    'utf-8',
  );

  return { folder, report };
}

ipcMain.removeHandler('diagnostics:capture');
ipcMain.handle('diagnostics:capture', (_event, payload) => captureDiagnostics(payload || {}));

ipcMain.removeHandler('diagnostics:open-folder');
ipcMain.handle('diagnostics:open-folder', () => openDiagnosticFolder());

ipcMain.removeHandler('diagnostics:open-devtools');
ipcMain.handle('diagnostics:open-devtools', () => openScanDevTools());

module.exports = {
  captureDiagnostics,
  openDiagnosticFolder,
  openScanDevTools,
};
