const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

let cancelRequested = false;
let running = false;

const PRESETS = {
  high: { label: '고화질', maxWidth: 1800, quality: 90 },
  standard: { label: '표준', maxWidth: 1400, quality: 82 },
  low: { label: '저화질', maxWidth: 1100, quality: 70 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeName(value, fallback = 'untitled') {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (text || fallback).slice(0, 90);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function libraryRoot() {
  const settings = await readJson(path.join(app.getPath('userData'), 'settings.json'), {});
  const root = settings.libraryRoot || path.join(app.getPath('userData'), 'library');
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function progress(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('crawler:progress', payload);
  }
}

function normalizePayload(payload) {
  if (typeof payload === 'string') return { seriesSlug: payload, quality: 'standard' };
  const quality = PRESETS[payload?.quality] ? payload.quality : 'standard';
  return { seriesSlug: String(payload?.seriesSlug || ''), quality };
}

function inferContentType(meta = {}, seriesSlug = '') {
  const direct = String(meta.contentType || '').toLowerCase();
  if (['webtoon', 'manhwa', 'novel'].includes(direct)) return direct;
  try {
    const first = new URL(String(meta.sourceUrl || '')).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (['webtoon', 'manhwa', 'novel'].includes(first)) return first;
  } catch {}
  const slug = String(seriesSlug || meta.slug || '').toLowerCase();
  if (slug.startsWith('novel-')) return 'novel';
  if (slug.startsWith('manhwa-')) return 'manhwa';
  return 'webtoon';
}

function cleanNovelText(value) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n');

  const isUiTail = (raw) => {
    const line = String(raw || '').trim();
    if (!line) return false;
    if (/^(?:🔊|⚙️?|💬|🔈|🔉|🔇)+$/u.test(line.replace(/\s+/g, ''))) return true;
    const noIcons = line.replace(/[🔊⚙️💬🔈🔉🔇]/gu, '').trim();
    if (/^댓글\s*\d+\s*개(?:\s+(?:등록순|최신순))*$/u.test(noIcons)) return true;
    if (/^(?:등록순|최신순)(?:\s+(?:등록순|최신순))*$/u.test(noIcons)) return true;
    if (/^(?:댓글\s*\d+\s*개\s*)?(?:등록순\s*)?(?:최신순\s*)?$/u.test(noIcons) && /(?:댓글|등록순|최신순)/u.test(noIcons)) return true;
    return false;
  };

  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let cutoff = lines.length;
  for (let index = Math.max(0, lines.length - 18); index < lines.length; index += 1) {
    if (isUiTail(lines[index])) {
      cutoff = index;
      break;
    }
  }

  return lines.slice(0, cutoff).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function episodeHeading(episode) {
  const number = Number(episode.number);
  const fallback = `${number}화`;
  const title = String(episode.title || '').trim();
  if (!title) return fallback;
  if (new RegExp(`(^|\\s)${number}(?:\\.\\d+)?\\s*화`).test(title)) return title;
  return `${fallback} · ${title}`;
}

async function exportNovelTxt(seriesDir, meta) {
  const episodes = (meta.episodes || [])
    .filter((item) => item.completed)
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (!episodes.length) throw new Error('TXT로 내보낼 완료 회차가 없습니다.');

  const save = await dialog.showSaveDialog({
    title: '소설 TXT 저장 위치 선택',
    defaultPath: path.join(app.getPath('documents'), `${safeName(meta.title, 'novel')}.txt`),
    filters: [{ name: '텍스트 파일', extensions: ['txt'] }],
  });
  if (save.canceled || !save.filePath) return { cancelled: true, format: 'txt' };

  running = true;
  cancelRequested = false;
  progress({ type: 'txt-start', seriesTitle: meta.title, totalEpisodes: episodes.length });
  const sections = [String(meta.title || '소설').trim(), '='.repeat(64), ''];
  let exported = 0;
  const failed = [];

  try {
    for (let index = 0; index < episodes.length; index += 1) {
      if (cancelRequested) break;
      const episode = episodes[index];
      const number = Number(episode.number);
      const episodeDir = path.join(seriesDir, 'episodes', String(number).padStart(4, '0'));
      try {
        const raw = await fsp.readFile(path.join(episodeDir, 'content.txt'), 'utf-8');
        const text = cleanNovelText(raw);
        if (!text) throw new Error('본문이 비어 있습니다.');
        sections.push(episodeHeading(episode), '-'.repeat(64), '', text, '', '');
        exported += 1;
        progress({ type: 'txt-episode-progress', episode: number, episodeIndex: index + 1, episodeTotal: episodes.length });
      } catch (error) {
        failed.push(number);
        progress({ type: 'warning', message: `${number}화 TXT 내보내기 실패: ${error.message}` });
      }
    }

    if (cancelRequested) {
      progress({ type: 'txt-cancelled', exportedCount: exported, totalEpisodes: episodes.length });
      return { cancelled: true, format: 'txt', destination: save.filePath, episodeCount: exported, failedEpisodes: failed };
    }

    await fsp.writeFile(save.filePath, `\uFEFF${sections.join('\n').trim()}\n`, 'utf-8');
    progress({ type: 'txt-complete', exportedCount: exported, totalEpisodes: episodes.length, destination: save.filePath });

    const done = await dialog.showMessageBox({
      type: failed.length ? 'warning' : 'info',
      title: 'TXT 내보내기 완료',
      message: `${exported}개 회차를 하나의 TXT 파일로 저장했습니다.`,
      detail: failed.length ? `실패 회차: ${failed.join(', ')}` : path.basename(save.filePath),
      buttons: ['닫기', '파일 위치 열기'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (done.response === 1) await shell.showItemInFolder(save.filePath);

    return { cancelled: false, format: 'txt', destination: save.filePath, episodeCount: exported, failedEpisodes: failed };
  } finally {
    running = false;
    cancelRequested = false;
  }
}

async function compress(sourcePath, outputPath, preset) {
  let image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error(`이미지를 읽지 못했습니다: ${path.basename(sourcePath)}`);

  const size = image.getSize();
  if (size.width > preset.maxWidth) {
    image = image.resize({ width: preset.maxWidth, quality: 'best' });
  }

  const buffer = image.toJPEG(preset.quality);
  if (!buffer || buffer.length < 1000) throw new Error('이미지 압축에 실패했습니다.');
  await fsp.writeFile(outputPath, buffer);
}

async function waitImages(window) {
  await window.webContents.executeJavaScript(`
    Promise.all([...document.images].map((image) => {
      if (image.complete && image.naturalWidth > 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 30000);
        image.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
        image.addEventListener('error', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }))
  `);
}

function pdfHtml(seriesTitle, episodeNumber, imagePaths) {
  const pages = imagePaths.map((imagePath, index) => `
    <section class="page">
      <img src="${pathToFileURL(imagePath).href}" alt="${episodeNumber}화 ${index + 1}페이지">
    </section>
  `).join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${safeName(seriesTitle)} ${episodeNumber}화</title><style>
    @page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff}.page{display:flex;align-items:center;justify-content:center;width:210mm;height:297mm;overflow:hidden;page-break-after:always}.page:last-child{page-break-after:auto}.page img{display:block;width:100%;height:100%;object-fit:contain}
  </style></head><body>${pages}</body></html>`;
}

async function writePdf(seriesTitle, episodeNumber, imagePaths, outputPath) {
  const window = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const htmlPath = path.join(app.getPath('temp'), `ntk-pdf-${process.pid}-${Date.now()}.html`);

  try {
    await fsp.writeFile(htmlPath, pdfHtml(seriesTitle, episodeNumber, imagePaths), 'utf-8');
    await window.loadFile(htmlPath);
    await waitImages(window);
    await sleep(100);
    const data = await window.webContents.printToPDF({ printBackground: true, landscape: false, pageSize: 'A4', preferCSSPageSize: true });
    await fsp.writeFile(outputPath, data);
  } finally {
    await fsp.rm(htmlPath, { force: true });
    if (!window.isDestroyed()) window.destroy();
  }
}

async function exportPdf(payload) {
  if (running) throw new Error('이미 내보내기가 진행 중입니다.');

  const { seriesSlug, quality } = normalizePayload(payload);
  if (!seriesSlug) throw new Error('내보낼 작품을 선택하세요.');

  const preset = PRESETS[quality];
  const root = await libraryRoot();
  const seriesDir = path.join(root, seriesSlug);
  const meta = await readJson(path.join(seriesDir, 'series.json'));
  if (!meta) throw new Error('작품 정보를 찾을 수 없습니다.');

  if (inferContentType(meta, seriesSlug) === 'novel') {
    return exportNovelTxt(seriesDir, meta);
  }

  const folder = await dialog.showOpenDialog({ title: 'PDF를 저장할 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
  if (folder.canceled || !folder.filePaths[0]) return { cancelled: true };

  const destination = path.join(folder.filePaths[0], `${safeName(meta.title)}-PDF-${preset.label}`);
  await fsp.mkdir(destination, { recursive: true });

  const episodes = (meta.episodes || []).filter((item) => item.completed).sort((a, b) => Number(a.number) - Number(b.number));
  if (!episodes.length) throw new Error('PDF로 내보낼 완료 회차가 없습니다.');

  running = true;
  cancelRequested = false;
  let exported = 0;
  const failed = [];
  progress({ type: 'pdf-start', seriesTitle: meta.title, quality, qualityLabel: preset.label, totalEpisodes: episodes.length });

  try {
    for (let episodeIndex = 0; episodeIndex < episodes.length; episodeIndex += 1) {
      if (cancelRequested) break;

      const episode = episodes[episodeIndex];
      const number = Number(episode.number);
      const padded = String(number).padStart(4, '0');
      const episodeDir = path.join(seriesDir, 'episodes', padded);
      const tempDir = await fsp.mkdtemp(path.join(app.getPath('temp'), `ntk-pdf-${padded}-`));

      try {
        const names = (await fsp.readdir(episodeDir)).filter((name) => /^\d{4}\.png$/i.test(name)).sort();
        if (!names.length) { failed.push(number); continue; }

        progress({ type: 'pdf-episode-start', episode: number, episodeIndex: episodeIndex + 1, episodeTotal: episodes.length, pageTotal: names.length });
        const compressed = [];

        for (let pageIndex = 0; pageIndex < names.length; pageIndex += 1) {
          if (cancelRequested) break;
          const target = path.join(tempDir, `${String(pageIndex + 1).padStart(4, '0')}.jpg`);
          await compress(path.join(episodeDir, names[pageIndex]), target, preset);
          compressed.push(target);
          progress({ type: 'pdf-page-progress', episode: number, episodeIndex: episodeIndex + 1, episodeTotal: episodes.length, page: pageIndex + 1, pageTotal: names.length });
        }

        if (cancelRequested) break;
        await writePdf(meta.title, number, compressed, path.join(destination, `${padded}화.pdf`));
        exported += 1;
        progress({ type: 'pdf-episode-complete', episode: number, episodeIndex: episodeIndex + 1, episodeTotal: episodes.length });
      } catch (error) {
        failed.push(number);
        progress({ type: 'warning', message: `${number}화 PDF 생성 실패: ${error.message}` });
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    }

    if (cancelRequested) {
      progress({ type: 'pdf-cancelled', exportedCount: exported, totalEpisodes: episodes.length, destination });
      return { cancelled: true, destination, episodeCount: exported, failedEpisodes: failed };
    }

    progress({ type: 'pdf-complete', exportedCount: exported, totalEpisodes: episodes.length, destination, failedEpisodes: failed });

    const done = await dialog.showMessageBox({
      type: failed.length ? 'warning' : 'info',
      title: 'PDF 내보내기 완료',
      message: `${exported}개 회차를 PDF로 저장했습니다.`,
      detail: failed.length ? `실패 회차: ${failed.join(', ')}` : `${preset.label} 설정으로 저장했습니다.`,
      buttons: ['닫기', '저장 폴더 열기'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (done.response === 1) await shell.openPath(destination);

    return { cancelled: false, format: 'pdf', destination, episodeCount: exported, failedEpisodes: failed, quality, qualityLabel: preset.label };
  } finally {
    running = false;
    cancelRequested = false;
  }
}

ipcMain.removeHandler('export:pdf');
ipcMain.handle('export:pdf', async (_event, payload) => exportPdf(payload));
ipcMain.removeHandler('export:pdf-cancel');
ipcMain.handle('export:pdf-cancel', async () => {
  if (!running) return { cancelled: false, running: false };
  cancelRequested = true;
  return { cancelled: true, running: true };
});
