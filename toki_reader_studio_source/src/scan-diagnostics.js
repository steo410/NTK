const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const consoleLogs = new Map();
let lastDiagnosticFolder = '';

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function findScanWindow() {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());

  return (
    windows.find((window) => /NTK 회차 검색|작업 브라우저/.test(window.getTitle())) ||
    windows.find((window) => {
      try {
        return /^https?:\/\//.test(window.webContents.getURL());
      } catch {
        return false;
      }
    }) ||
    null
  );
}

function attachConsoleCapture(window) {
  if (!window || window.isDestroyed()) return;
  const id = window.webContents.id;
  if (consoleLogs.has(id)) return;

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

  window.on('closed', () => {
    consoleLogs.delete(id);
  });
}

app.on('browser-window-created', (_event, window) => {
  attachConsoleCapture(window);
});

for (const window of BrowserWindow.getAllWindows()) {
  attachConsoleCapture(window);
}

async function inspectPage(window, sourceUrl = '') {
  const seriesMatch = String(sourceUrl).match(/\/webtoon\/(\d+)/);
  const seriesId = seriesMatch ? seriesMatch[1] : '';

  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const anchors = [];
      const scrollContainers = [];
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

        anchors.push({
          href,
          anchorText: normalize(anchor.innerText || anchor.textContent),
          rowText: normalize(row.innerText || row.textContent),
          rowTag: row.tagName,
          rowClass: typeof row.className === 'string' ? row.className : '',
          imageAlt: normalize(image?.alt),
          imageTitle: normalize(image?.title),
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

        const style = getComputedStyle(element);
        const scrollHeight = Number(element.scrollHeight || 0);
        const clientHeight = Number(element.clientHeight || 0);

        if (scrollHeight <= clientHeight + 20) continue;

        scrollContainers.push({
          tag: element.tagName,
          id: element.id || '',
          className: typeof element.className === 'string' ? element.className : '',
          overflowY: style.overflowY,
          scrollTop: Number(element.scrollTop || 0),
          scrollHeight,
          clientHeight,
        });
      }

      scrollContainers.sort((a, b) =>
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
      );

      return {
        capturedAt: new Date().toISOString(),
        location: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: document.body?.innerText?.length || 0,
        bodyChildCount: document.body?.children?.length || 0,
        anchorCount: allAnchors.length,
        matchingAnchorCount: anchors.length,
        anchors: anchors.slice(0, 300),
        scrollContainers: scrollContainers.slice(0, 50),
        bodyTextPreview: normalize(document.body?.innerText).slice(0, 12000),
      };
    })()
  `);
}

async function captureDiagnostics(payload = {}) {
  const window = findScanWindow();
  const root = path.join(app.getPath('userData'), 'diagnostics');
  const folder = path.join(root, safeTimestamp());
  await fsp.mkdir(folder, { recursive: true });
  lastDiagnosticFolder = folder;

  const summary = {
    capturedAt: new Date().toISOString(),
    sourceUrl: payload.sourceUrl || '',
    error: payload.error || '',
    appVersion: app.getVersion(),
    scanWindowFound: Boolean(window),
    diagnosticFolder: folder,
  };

  if (!window) {
    await fsp.writeFile(
      path.join(folder, 'diagnostic.json'),
      JSON.stringify(summary, null, 2),
      'utf-8',
    );
    return { folder, summary };
  }

  attachConsoleCapture(window);
  summary.windowTitle = window.getTitle();
  summary.currentUrl = window.webContents.getURL();

  try {
    const pageInspection = await inspectPage(window, payload.sourceUrl || '');
    Object.assign(summary, pageInspection);
  } catch (error) {
    summary.inspectionError = String(error?.stack || error);
  }

  summary.consoleLogs = consoleLogs.get(window.webContents.id) || [];

  try {
    const html = await window.webContents.executeJavaScript(
      'document.documentElement.outerHTML',
    );
    await fsp.writeFile(path.join(folder, 'page.html'), html, 'utf-8');
  } catch (error) {
    summary.htmlSaveError = String(error?.stack || error);
  }

  try {
    const image = await window.webContents.capturePage();
    await fsp.writeFile(path.join(folder, 'visible-page.png'), image.toPNG());
  } catch (error) {
    summary.screenshotError = String(error?.stack || error);
  }

  await fsp.writeFile(
    path.join(folder, 'diagnostic.json'),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );

  await fsp.writeFile(
    path.join(folder, 'console.log'),
    summary.consoleLogs
      .map((entry) =>
        `[${entry.time}] level=${entry.level} ${entry.message} (${entry.sourceId}:${entry.line})`
      )
      .join('\n'),
    'utf-8',
  );

  return { folder, summary };
}

ipcMain.removeHandler('diagnostics:capture');
ipcMain.handle('diagnostics:capture', async (_event, payload) => {
  return captureDiagnostics(payload || {});
});

ipcMain.removeHandler('diagnostics:open-folder');
ipcMain.handle('diagnostics:open-folder', async () => {
  const folder = lastDiagnosticFolder || path.join(app.getPath('userData'), 'diagnostics');
  await fsp.mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  return { folder, error };
});

ipcMain.removeHandler('diagnostics:open-devtools');
ipcMain.handle('diagnostics:open-devtools', async () => {
  const window = findScanWindow();
  if (!window) return { opened: false, error: '작업 브라우저를 찾지 못했습니다.' };

  window.show();
  window.focus();
  window.webContents.openDevTools({ mode: 'detach', activate: true });
  return { opened: true, url: window.webContents.getURL() };
});

ipcMain.removeHandler('diagnostics:get-last-folder');
ipcMain.handle('diagnostics:get-last-folder', async () => ({
  folder: lastDiagnosticFolder,
}));
