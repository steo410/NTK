const { BrowserWindow } = require('electron');

let workerWindow = null;

function isUsable(window) {
  return Boolean(window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed());
}

function looksLikeLegacyWorker(window) {
  if (!isUsable(window)) return false;
  const url = String(window.webContents.getURL() || '');
  if (url.startsWith('file:')) return false;
  const title = String(window.getTitle?.() || '');
  return /(?:NTK|Toki Reader Studio)/i.test(title)
    && /(?:작업 브라우저|회차 검색|작품 검색|문자열 작품|소설 다운로드|다운로드)/i.test(title);
}

function adoptExistingWorker() {
  const candidates = BrowserWindow.getAllWindows().filter(looksLikeLegacyWorker);
  return candidates[0] || null;
}

async function ensureWorker(show = true) {
  if (!isUsable(workerWindow)) {
    workerWindow = adoptExistingWorker();
  }

  if (!isUsable(workerWindow)) {
    workerWindow = new BrowserWindow({
      width: 1280,
      height: 920,
      show: Boolean(show),
      title: 'NTK 작업 브라우저',
      backgroundColor: '#111319',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    workerWindow.webContents.setBackgroundThrottling(false);
    workerWindow.on('closed', () => {
      workerWindow = null;
    });
  }

  try { workerWindow.setTitle('NTK 작업 브라우저'); } catch {}

  if (show) {
    try { workerWindow.show(); } catch {}
    try { workerWindow.focus(); } catch {}
  } else {
    try { workerWindow.hide(); } catch {}
  }

  return workerWindow;
}

function getWorker() {
  if (!isUsable(workerWindow)) workerWindow = adoptExistingWorker();
  return isUsable(workerWindow) ? workerWindow : null;
}

module.exports = { ensureWorker, getWorker };
