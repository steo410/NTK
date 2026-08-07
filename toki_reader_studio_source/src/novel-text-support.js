const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

let novelWindow = null;
let cancelRequested = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeFileName(value, fallback = 'untitled') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (normalized || fallback).slice(0, 90);
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fsp.readFile(filePath, 'utf-8')); }
  catch { return fallback; }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function getLibraryRoot() {
  const settings = await readJson(path.join(app.getPath('userData'), 'settings.json'), {});
  const root = settings.libraryRoot || path.join(app.getPath('userData'), 'library');
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function getNovelId(url) {
  try { return new URL(url).pathname.match(/^\/novel\/(\d+)/)?.[1] || ''; }
  catch { return ''; }
}

function sendProgress(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('crawler:progress', payload);
  }
}

async function ensureNovelWindow(show) {
  if (novelWindow && !novelWindow.isDestroyed()) {
    if (show) novelWindow.show(); else novelWindow.hide();
    return novelWindow;
  }
  novelWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show: Boolean(show),
    title: 'NTK 소설 작업 브라우저',
    backgroundColor: '#111319',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  novelWindow.webContents.setBackgroundThrottling(false);
  novelWindow.on('closed', () => { novelWindow = null; });
  return novelWindow;
}

async function loadNovelPage(url, show) {
  const window = await ensureNovelWindow(show);
  try { await window.loadURL(url); } catch {}
  await sleep(1000);
  return window;
}

async function extractNovelText(contents) {
  return contents.executeJavaScript(`
    (() => {
      const clean = (v) => String(v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n[ \\t]+/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
      const selectors = [
        '#novel_content','#novel-content','.novel-content','.novel-view-content',
        '.novel-viewer','.novel-body','.novel-text','.viewer-content','.view-content',
        '[data-novel-content]','[class*="novel"][class*="content"]','[class*="novel"][class*="viewer"]'
      ];
      const explicit = selectors.flatMap((s) => [...document.querySelectorAll(s)])
        .filter((el) => clean(el.innerText).length >= 80);
      const candidates = explicit.length ? explicit : [...document.querySelectorAll('article, main, section, div')]
        .filter((el) => !el.closest('header, nav, footer, aside') && clean(el.innerText).length >= 200);
      let best = null;
      let score = -Infinity;
      for (const el of candidates) {
        const text = clean(el.innerText);
        const links = [...el.querySelectorAll('a')].map((a) => clean(a.innerText)).join(' ').length;
        const buttons = [...el.querySelectorAll('button')].map((b) => clean(b.innerText)).join(' ').length;
        const lines = text.split(/\\n+/).filter(Boolean).length;
        const noise = /댓글|추천|목록|로그인|회원가입|광고문의|북마크/.test(text) ? 220 : 0;
        const nextScore = text.length + lines * 18 - (links + buttons) * 2.2 - noise;
        if (nextScore > score) { score = nextScore; best = { el, text }; }
      }
      if (!best || best.text.length < 80) return { text:'', selector:'', length:0 };
      let selector = best.el.id ? '#' + best.el.id : '';
      if (!selector && typeof best.el.className === 'string' && best.el.className.trim()) {
        selector = '.' + best.el.className.trim().split(/\\s+/).slice(0,3).join('.');
      }
      return { text: best.text, selector, length: best.text.length };
    })()
  `);
}

async function downloadNovelEpisodes(payload = {}) {
  cancelRequested = false;
  const selected = (payload.episodes || []).filter((e) => e.selected !== false)
    .sort((a,b) => Number(a.number) - Number(b.number));
  if (!selected.length) throw new Error('다운로드할 회차를 한 개 이상 선택하세요.');

  const sourceUrl = payload.sourceUrl || selected[0]?.url || '';
  const novelId = getNovelId(sourceUrl);
  if (!novelId) throw new Error('소설 작품 ID를 확인할 수 없습니다.');
  const title = safeFileName(payload.title || '소설');
  const libraryRoot = await getLibraryRoot();
  const seriesSlug = `novel-${novelId}`;
  const seriesDir = path.join(libraryRoot, seriesSlug);
  const episodesDir = path.join(seriesDir, 'episodes');
  const metaPath = path.join(seriesDir, 'series.json');
  await fsp.mkdir(episodesDir, { recursive: true });

  let meta = await readJson(metaPath, { title, slug: seriesSlug, sourceUrl, contentType:'novel', createdAt:new Date().toISOString(), episodes:[] });
  Object.assign(meta, { title, slug:seriesSlug, sourceUrl, contentType:'novel', updatedAt:new Date().toISOString() });
  let completedEpisodes = 0;

  for (let index=0; index<selected.length; index+=1) {
    if (cancelRequested) break;
    const episode = selected[index];
    const number = Number(episode.number);
    const episodeDir = path.join(episodesDir, String(number).padStart(4,'0'));
    const contentPath = path.join(episodeDir, 'content.txt');
    const manifestPath = path.join(episodeDir, 'manifest.json');
    await fsp.mkdir(episodeDir, { recursive:true });
    const existing = await readJson(manifestPath);
    if (existing?.completed && fs.existsSync(contentPath) && !payload.force) {
      completedEpisodes += 1;
      sendProgress({ type:'episode-skipped', episode:number, index:index+1, total:selected.length, pageCount:1, contentType:'novel' });
      continue;
    }

    sendProgress({ type:'episode-start', episode:number, title:episode.title, index:index+1, total:selected.length, contentType:'novel' });
    const window = await loadNovelPage(episode.url, payload.showBrowser !== false);
    let extracted = { text:'', selector:'', length:0 };
    for (let retry=0; retry<4; retry+=1) {
      extracted = await extractNovelText(window.webContents);
      if (extracted.text.length >= 80) break;
      await sleep(450);
    }
    if (extracted.text.length < 80) {
      await writeJson(manifestPath, { episode:number, title:episode.title, url:episode.url, contentType:'novel', completed:false, error:'본문 텍스트를 찾지 못했습니다.', updatedAt:new Date().toISOString() });
      sendProgress({ type:'episode-error', episode:number, message:'본문 텍스트를 찾지 못했습니다.' });
      continue;
    }

    await fsp.writeFile(contentPath, extracted.text, 'utf-8');
    await writeJson(manifestPath, { episode:number, title:episode.title, url:episode.url, contentType:'novel', textFile:'content.txt', textLength:extracted.length, selector:extracted.selector, pageCount:1, completed:true, updatedAt:new Date().toISOString() });
    const metaEpisode = { number, title:episode.title || `${number}화`, url:episode.url, contentType:'novel', textLength:extracted.length, pageCount:1, completed:true, updatedAt:new Date().toISOString() };
    const oldIndex = meta.episodes.findIndex((item) => Number(item.number) === number);
    if (oldIndex >= 0) meta.episodes[oldIndex] = metaEpisode; else meta.episodes.push(metaEpisode);
    meta.episodes.sort((a,b) => Number(a.number) - Number(b.number));
    await writeJson(metaPath, meta);
    completedEpisodes += 1;
    sendProgress({ type:'page-progress', episode:number, page:1, pageTotal:1, episodeIndex:index+1, episodeTotal:selected.length, contentType:'novel' });
    sendProgress({ type:'episode-complete', episode:number, pageCount:1, contentType:'novel', index:index+1, total:selected.length });
    await sleep(180);
  }

  sendProgress({ type: cancelRequested ? 'cancelled' : 'all-complete', completedEpisodes, totalEpisodes:selected.length, seriesSlug });
  return { completedEpisodes, totalEpisodes:selected.length, cancelled:cancelRequested, seriesSlug };
}

async function getReaderItems(seriesSlug, episodeNumber) {
  const root = await getLibraryRoot();
  const episodeDir = path.join(root, safeFileName(seriesSlug), 'episodes', String(episodeNumber).padStart(4,'0'));
  try {
    const text = await fsp.readFile(path.join(episodeDir, 'content.txt'), 'utf-8');
    return [{ type:'text', text, index:1, name:'content.txt', url:'' }];
  } catch {}
  try {
    const names = (await fsp.readdir(episodeDir)).filter((name) => /^\d{4}\.png$/i.test(name)).sort();
    return names.map((name,index) => ({ type:'image', index:index+1, name, url:pathToFileURL(path.join(episodeDir,name)).href }));
  } catch { return []; }
}

function requestCancel() { cancelRequested = true; }

ipcMain.removeHandler('novel:download');
ipcMain.handle('novel:download', async (_event,payload) => downloadNovelEpisodes(payload || {}));
ipcMain.removeHandler('novel:cancel');
ipcMain.handle('novel:cancel', async () => { requestCancel(); return { ok:true }; });
ipcMain.removeHandler('library:episode-images');
ipcMain.handle('library:episode-images', async (_event,seriesSlug,episodeNumber) => getReaderItems(seriesSlug,episodeNumber));

module.exports = { downloadNovelEpisodes, requestCancel };
