const sharedWorker = require('./shared-worker-window.js');
sharedWorker.installSharedWorkerBrowser();

const { ipcMain } = require('electron');

// 구형 패치가 ipcMain.handle을 바꾸기 전에 Electron 원본을 보관합니다.
const nativeHandle = ipcMain.handle.bind(ipcMain);
let originalCrawlerStart = null;
let originalCrawlerCancel = null;
let numericCrawlerScan = null;

// main.js가 등록하는 기존 이미지 다운로드 핸들러를 보관합니다.
ipcMain.handle = function captureCoreHandlers(channel, listener) {
  if (channel === 'crawler:start') originalCrawlerStart = listener;
  if (channel === 'crawler:cancel') originalCrawlerCancel = listener;
  return nativeHandle(channel, listener);
};

require('./reload-promise-fix.js');
require('./download-recovery.js');
require('./novel-ui-runtime.js');
require('./generic-export-label.js');
require('./main-v1.1.js');

ipcMain.handle = nativeHandle;
ipcMain.removeHandler('crawler:scan');

require('./pdf-export-enhancement.js');
require('./library-catalog-enhancement.js');
const novelSupport = require('./novel-text-support.js');
const novelPassiveDownloader = require('./novel-native-text-loader.js');
const novelRequestDiagnostics = require('./novel-request-format-diagnostics.js');
const novelClientDiagnostics = require('./novel-client-chunk-diagnostics.js');
const stringImageDownloader = require('./string-image-downloader.js');
const diagnostics = require('./scan-diagnostics-v2.js');
const stringSeriesSupport = require('./string-series-key-support.js');

function parseContentIdentity(value) {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (!['webtoon', 'manhwa', 'novel'].includes(parts[0])) return null;
    return { type: parts[0], key: parts[1], isNumeric: /^\d+$/.test(parts[1]) };
  } catch {
    return null;
  }
}

function stableNumericKey(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return String(100000000 + (hash % 899999999));
}

function prepareNovelPayload(payload = {}) {
  const source = String(payload.sourceUrl || payload.episodes?.[0]?.url || '');
  const identity = parseContentIdentity(source);
  if (!identity || identity.type !== 'novel' || identity.isNumeric) return payload;

  try {
    const parsed = new URL(source);
    const fakeId = stableNumericKey(identity.key);
    const fakeSourceUrl = `${parsed.origin}/novel/${fakeId}`;
    return {
      ...payload,
      sourceUrl: fakeSourceUrl,
      originalSourceUrl: source,
      seriesKey: identity.key,
    };
  } catch {
    return payload;
  }
}

ipcMain.removeHandler('crawler:start');
nativeHandle('crawler:start', async (event, payload = {}) => {
  const source = String(payload.sourceUrl || payload.episodes?.[0]?.url || '');
  const identity = parseContentIdentity(source);

  if (identity?.type === 'novel') {
    await novelRequestDiagnostics.begin(source);
    await novelClientDiagnostics.begin(source);
    let requestDiagnostic = {};
    try {
      return await novelPassiveDownloader.downloadNovelEpisodes(prepareNovelPayload(payload));
    } finally {
      try { requestDiagnostic = await novelRequestDiagnostics.end(); } catch {}
      try { await novelClientDiagnostics.end(requestDiagnostic); } catch {}
    }
  }

  if (identity && !identity.isNumeric && ['webtoon', 'manhwa'].includes(identity.type)) {
    return stringImageDownloader.downloadStringImages(payload);
  }

  if (!originalCrawlerStart) throw new Error('기존 다운로드 엔진을 찾지 못했습니다.');
  return originalCrawlerStart(event, payload);
});

ipcMain.removeHandler('crawler:cancel');
nativeHandle('crawler:cancel', async (event) => {
  novelSupport.requestCancel();
  novelPassiveDownloader.requestCancel();
  stringImageDownloader.requestCancel();
  if (originalCrawlerCancel) return originalCrawlerCancel(event);
  return { ok: true };
});

ipcMain.handle = function captureCurrentScanner(channel, listener) {
  if (channel === 'crawler:scan') numericCrawlerScan = listener;
  return nativeHandle(channel, listener);
};

require('./current-page-exact-scan.js');
ipcMain.handle = nativeHandle;

ipcMain.removeHandler('crawler:scan');
nativeHandle('crawler:scan', async (event, payload = {}) => {
  try {
    const identity = stringSeriesSupport.parseIdentity(payload?.sourceUrl || '');

    if (identity && !identity.isNumeric) {
      return await stringSeriesSupport.scanStringSeriesPage(event, payload);
    }

    if (!numericCrawlerScan) {
      throw new Error('기존 숫자형 회차 스캐너를 찾지 못했습니다.');
    }

    return await numericCrawlerScan(event, payload);
  } catch (error) {
    let diagnosticFolder = '';
    try {
      const result = await diagnostics.captureDiagnostics({
        sourceUrl: payload?.sourceUrl || '',
        error: String(error?.stack || error),
      });
      diagnosticFolder = result?.folder || '';
    } catch (diagnosticError) {
      console.error('[NTK Diagnostics] 진단 저장 실패:', diagnosticError);
    }

    const originalMessage = String(error?.message || error);
    const suffix = diagnosticFolder
      ? `\n진단 폴더: ${diagnosticFolder}\nF12: 개발자 도구 / Ctrl+Shift+D: 진단 폴더 열기`
      : '';
    throw new Error(originalMessage + suffix);
  }
});
