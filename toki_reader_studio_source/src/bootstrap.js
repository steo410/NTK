const { ipcMain } = require('electron');

// 구형 패치가 ipcMain.handle을 바꾸기 전에 Electron 원본을 보관합니다.
const nativeHandle = ipcMain.handle.bind(ipcMain);
let originalCrawlerStart = null;
let originalCrawlerCancel = null;

// main.js가 등록하는 기존 이미지 다운로드 핸들러를 보관합니다.
ipcMain.handle = function captureCoreHandlers(channel, listener) {
  if (channel === 'crawler:start') originalCrawlerStart = listener;
  if (channel === 'crawler:cancel') originalCrawlerCancel = listener;
  return nativeHandle(channel, listener);
};

// reloadIgnoringCache()가 Promise를 반환하지 않는 Electron 환경을 보정합니다.
require('./reload-promise-fix.js');
require('./download-recovery.js');
require('./novel-ui-runtime.js');
require('./main-v1.1.js');

// 구형 스캐너 등록 가로채기를 해제합니다.
ipcMain.handle = nativeHandle;
ipcMain.removeHandler('crawler:scan');

require('./pdf-export-enhancement.js');
const novelSupport = require('./novel-text-support.js');
const diagnostics = require('./scan-diagnostics-v2.js');

// 웹툰/만화는 기존 이미지 엔진, 소설은 텍스트 엔진으로 자동 분기합니다.
ipcMain.removeHandler('crawler:start');
nativeHandle('crawler:start', async (event, payload = {}) => {
  const source = String(payload.sourceUrl || payload.episodes?.[0]?.url || '');
  if (/\/novel\/\d+/.test(source)) {
    return novelSupport.downloadNovelEpisodes(payload);
  }
  if (!originalCrawlerStart) throw new Error('기존 다운로드 엔진을 찾지 못했습니다.');
  return originalCrawlerStart(event, payload);
});

ipcMain.removeHandler('crawler:cancel');
nativeHandle('crawler:cancel', async (event) => {
  novelSupport.requestCancel();
  if (originalCrawlerCancel) return originalCrawlerCancel(event);
  return { ok: true };
});

// 최신 스캐너 등록 시 실패를 자동 진단 파일로 남기도록 감쌉니다.
ipcMain.handle = function diagnosticHandle(channel, listener) {
  if (channel !== 'crawler:scan') {
    return nativeHandle(channel, listener);
  }

  return nativeHandle(channel, async (event, payload) => {
    try {
      return await listener(event, payload);
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
};

require('./current-page-exact-scan.js');

// 다른 IPC 등록에는 Electron 원본 함수를 사용합니다.
ipcMain.handle = nativeHandle;
