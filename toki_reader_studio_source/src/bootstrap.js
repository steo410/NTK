const { ipcMain } = require('electron');

// episode-scan-patch.js가 ipcMain.handle 자체를 가로채기 전에
// Electron의 원래 IPC 등록 함수를 보관합니다.
const nativeHandle = ipcMain.handle.bind(ipcMain);

require('./download-recovery.js');
require('./main-v1.1.js');

// main-v1.1.js 내부의 구형 스캐너 패치가 ipcMain.handle을 바꿔 놓으므로
// 원래 등록 함수로 복구한 뒤 최신 스캐너를 마지막에 등록합니다.
ipcMain.handle = nativeHandle;
ipcMain.removeHandler('crawler:scan');

require('./pdf-export-enhancement.js');
require('./full-episode-scan-fix.js');
