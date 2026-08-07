const electron = require('electron');
const OriginalBrowserWindow = electron.BrowserWindow;

let workerWindow = null;
let installed = false;

function isUsable(window) {
  return Boolean(window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed());
}

function isWorkerTitle(value) {
  return /(?:작업 브라우저|회차 검색|작품 검색|문자열 작품|소설 다운로드|다운로드)/i.test(String(value || ''));
}

function looksLikeLegacyWorker(window) {
  if (!isUsable(window)) return false;
  const url = String(window.webContents.getURL() || '');
  if (url.startsWith('file:')) return false;
  return isWorkerTitle(window.getTitle?.());
}

function adoptExistingWorker() {
  return OriginalBrowserWindow.getAllWindows().find(looksLikeLegacyWorker) || null;
}

function installCaptureUiSuppression(window) {
  if (!isUsable(window) || window.webContents.__ntkCaptureSuppressionInstalled) return;
  window.webContents.__ntkCaptureSuppressionInstalled = true;

  const debuggerApi = window.webContents.debugger;
  const originalSendCommand = debuggerApi.sendCommand.bind(debuggerApi);

  debuggerApi.sendCommand = async function ntkSendCommand(method, params = {}) {
    if (method !== 'Page.captureScreenshot') {
      return originalSendCommand(method, params);
    }

    await window.webContents.executeJavaScript(`
      (() => {
        document.getElementById('ntk-capture-hide-fixed-ui')?.remove();
        const hidden = [];
        const stage = document.getElementById('ntk-string-capture-stage');
        for (const element of document.querySelectorAll('body *')) {
          if (stage && (element === stage || stage.contains(element))) continue;
          const style = getComputedStyle(element);
          if (style.position !== 'fixed' && style.position !== 'sticky') continue;
          element.dataset.ntkCaptureVisibility = element.style.visibility || '';
          element.style.setProperty('visibility', 'hidden', 'important');
          hidden.push(element);
        }
        window.__ntkCaptureHiddenElements = hidden;
        return hidden.length;
      })()
    `).catch(() => 0);

    try {
      return await originalSendCommand(method, params);
    } finally {
      await window.webContents.executeJavaScript(`
        (() => {
          const hidden = window.__ntkCaptureHiddenElements || [];
          for (const element of hidden) {
            if (!element?.isConnected) continue;
            const previous = element.dataset.ntkCaptureVisibility || '';
            if (previous) element.style.visibility = previous;
            else element.style.removeProperty('visibility');
            delete element.dataset.ntkCaptureVisibility;
          }
          window.__ntkCaptureHiddenElements = [];
        })()
      `).catch(() => undefined);
    }
  };
}

function registerWorker(window) {
  if (!isUsable(window)) return window;
  workerWindow = window;
  try { workerWindow.setTitle('NTK 작업 브라우저'); } catch {}
  try { workerWindow.webContents.setBackgroundThrottling(false); } catch {}
  installCaptureUiSuppression(workerWindow);
  workerWindow.once('closed', () => {
    if (workerWindow === window) workerWindow = null;
  });
  return workerWindow;
}

function installSharedWorkerBrowser() {
  if (installed) return;
  installed = true;

  const SharedBrowserWindow = new Proxy(OriginalBrowserWindow, {
    construct(Target, args, NewTarget) {
      const options = args?.[0] || {};
      if (!isWorkerTitle(options.title)) {
        return Reflect.construct(Target, args, NewTarget);
      }

      if (!isUsable(workerWindow)) workerWindow = adoptExistingWorker();
      if (isUsable(workerWindow)) {
        try {
          if (options.show === false) workerWindow.hide();
          else workerWindow.show();
        } catch {}
        return registerWorker(workerWindow);
      }

      const merged = {
        ...options,
        title: 'NTK 작업 브라우저',
      };
      return registerWorker(Reflect.construct(Target, [merged], NewTarget));
    },
  });

  electron.BrowserWindow = SharedBrowserWindow;
}

async function ensureWorker(show = true) {
  installSharedWorkerBrowser();
  if (!isUsable(workerWindow)) workerWindow = adoptExistingWorker();
  if (!isUsable(workerWindow)) {
    workerWindow = registerWorker(new OriginalBrowserWindow({
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
    }));
  }
  if (show) workerWindow.show(); else workerWindow.hide();
  return workerWindow;
}

function getWorker() {
  if (!isUsable(workerWindow)) workerWindow = adoptExistingWorker();
  return isUsable(workerWindow) ? workerWindow : null;
}

module.exports = { installSharedWorkerBrowser, ensureWorker, getWorker };
