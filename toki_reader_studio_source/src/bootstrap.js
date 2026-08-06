const { ipcMain } = require('electron');

// 구형 패치가 ipcMain.handle을 바꾸기 전에 Electron 원본을 보관합니다.
const nativeHandle = ipcMain.handle.bind(ipcMain);

// reloadIgnoringCache()가 Promise를 반환하지 않는 Electron 환경을 보정합니다.
require('./reload-promise-fix.js');
require('./download-recovery.js');
require('./main-v1.1.js');

// 구형 스캐너 등록 가로채기를 해제합니다.
ipcMain.handle = nativeHandle;
ipcMain.removeHandler('crawler:scan');

require('./pdf-export-enhancement.js');
const diagnostics = require('./scan-diagnostics-v2.js');

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
