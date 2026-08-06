const { ipcMain } = require('electron');

// 구형 패치가 ipcMain.handle을 바꾸기 전에 Electron 원본을 보관합니다.
const nativeHandle = ipcMain.handle.bind(ipcMain);

require('./download-recovery.js');
require('./main-v1.1.js');

// 구형 스캐너 등록 가로채기를 해제합니다.
ipcMain.handle = nativeHandle;
ipcMain.removeHandler('crawler:scan');

require('./pdf-export-enhancement.js');
require('./current-page-exact-scan.js');
