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

    const clip = params?.clip || null;

    // 캡처 시 사이트 UI를 종류별로 숨기는 대신 페이지 전체를 격리합니다.
    // 문자열 작품은 이미 존재하는 NTK 캡처 stage만 남기고,
    // 숫자형 작품은 clip과 가장 정확히 겹치는 원본 img를 복제한 stage만 남깁니다.
    await window.webContents.executeJavaScript(`
      (async () => {
        const clip = ${JSON.stringify(clip)};
        const existingStage = document.getElementById('ntk-string-capture-stage');
        let isolationStage = existingStage;
        let createdIsolationStage = false;

        if (!isolationStage && clip && Number(clip.width) > 0 && Number(clip.height) > 0) {
          const clipRect = {
            left: Number(clip.x || 0),
            top: Number(clip.y || 0),
            right: Number(clip.x || 0) + Number(clip.width || 0),
            bottom: Number(clip.y || 0) + Number(clip.height || 0),
            width: Number(clip.width || 0),
            height: Number(clip.height || 0),
          };

          let best = null;
          let bestScore = -1;

          for (const image of document.querySelectorAll('img')) {
            const rect = image.getBoundingClientRect();
            const docRect = {
              left: rect.left + window.scrollX,
              top: rect.top + window.scrollY,
              right: rect.right + window.scrollX,
              bottom: rect.bottom + window.scrollY,
              width: rect.width,
              height: rect.height,
            };
            if (docRect.width < 1 || docRect.height < 1) continue;

            const overlapWidth = Math.max(0, Math.min(docRect.right, clipRect.right) - Math.max(docRect.left, clipRect.left));
            const overlapHeight = Math.max(0, Math.min(docRect.bottom, clipRect.bottom) - Math.max(docRect.top, clipRect.top));
            const overlap = overlapWidth * overlapHeight;
            if (overlap <= 0) continue;

            const clipArea = Math.max(clipRect.width * clipRect.height, 1);
            const imageArea = Math.max(docRect.width * docRect.height, 1);
            const overlapRatio = overlap / Math.min(clipArea, imageArea);
            const widthDiff = Math.abs(docRect.width - clipRect.width) / Math.max(clipRect.width, 1);
            const heightDiff = Math.abs(docRect.height - clipRect.height) / Math.max(clipRect.height, 1);
            const score = overlapRatio * 100 - widthDiff * 20 - heightDiff * 20;

            if (score > bestScore) {
              bestScore = score;
              best = image;
            }
          }

          if (best) {
            isolationStage = document.createElement('div');
            isolationStage.id = 'ntk-capture-isolation-stage';
            Object.assign(isolationStage.style, {
              position: 'absolute',
              left: Number(clip.x || 0) + 'px',
              top: Number(clip.y || 0) + 'px',
              width: Number(clip.width || 1) + 'px',
              height: Number(clip.height || 1) + 'px',
              margin: '0',
              padding: '0',
              overflow: 'hidden',
              lineHeight: '0',
              background: '#fff',
              zIndex: '2147483647',
              visibility: 'visible',
              opacity: '1',
              pointerEvents: 'none',
            });

            const clone = document.createElement('img');
            clone.src = best.currentSrc || best.src || best.getAttribute('data-src') || '';
            clone.loading = 'eager';
            clone.decoding = 'sync';
            Object.assign(clone.style, {
              display: 'block',
              width: '100%',
              height: '100%',
              margin: '0',
              padding: '0',
              border: '0',
              maxWidth: 'none',
              maxHeight: 'none',
              objectFit: 'fill',
              visibility: 'visible',
              opacity: '1',
            });
            isolationStage.appendChild(clone);
            document.documentElement.appendChild(isolationStage);
            createdIsolationStage = true;

            if (!clone.complete || clone.naturalWidth === 0) {
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 12000);
                clone.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
                clone.addEventListener('error', () => { clearTimeout(timer); resolve(); }, { once: true });
              });
            }
          }
        }

        const body = document.body;
        const previousBodyVisibility = body?.style.getPropertyValue('visibility') || '';
        const previousBodyPriority = body?.style.getPropertyPriority('visibility') || '';
        const previousBodyOpacity = body?.style.getPropertyValue('opacity') || '';
        const previousBodyOpacityPriority = body?.style.getPropertyPriority('opacity') || '';

        // 임시 stage는 documentElement의 직접 자식이므로 body 전체를 숨여도 캡처 대상은 유지됩니다.
        if (body) {
          body.style.setProperty('visibility', 'hidden', 'important');
          body.style.setProperty('opacity', '0', 'important');
        }

        if (isolationStage) {
          isolationStage.style.setProperty('visibility', 'visible', 'important');
          isolationStage.style.setProperty('opacity', '1', 'important');
        }

        window.__ntkCaptureIsolation = {
          createdIsolationStage,
          previousBodyVisibility,
          previousBodyPriority,
          previousBodyOpacity,
          previousBodyOpacityPriority,
        };

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Boolean(isolationStage);
      })()
    `).catch(() => false);

    try {
      return await originalSendCommand(method, params);
    } finally {
      await window.webContents.executeJavaScript(`
        (() => {
          const state = window.__ntkCaptureIsolation || {};
          const body = document.body;

          if (body) {
            if (state.previousBodyVisibility) {
              body.style.setProperty('visibility', state.previousBodyVisibility, state.previousBodyPriority || '');
            } else {
              body.style.removeProperty('visibility');
            }

            if (state.previousBodyOpacity) {
              body.style.setProperty('opacity', state.previousBodyOpacity, state.previousBodyOpacityPriority || '');
            } else {
              body.style.removeProperty('opacity');
            }
          }

          if (state.createdIsolationStage) {
            document.getElementById('ntk-capture-isolation-stage')?.remove();
          }

          window.__ntkCaptureIsolation = null;
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
    construct(Target, args) {
      const options = args?.[0] || {};
      if (!isWorkerTitle(options.title)) {
        return Reflect.construct(Target, args, Target);
      }

      if (!isUsable(workerWindow)) workerWindow = adoptExistingWorker();
      if (isUsable(workerWindow)) {
        try {
          if (options.show === false) workerWindow.hide();
          else workerWindow.show();
        } catch {}
        return registerWorker(workerWindow);
      }

      const merged = { ...options, title: 'NTK 작업 브라우저' };
      return registerWorker(Reflect.construct(Target, [merged], Target));
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
