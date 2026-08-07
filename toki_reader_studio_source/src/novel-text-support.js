const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

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
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function getLibraryRoot() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const settings = await readJson(settingsPath, {});
  const root = settings.libraryRoot || path.join(app.getPath('userData'), 'library');
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function getNovelId(url) {
  try {
    return new URL(url).pathname.match(/^\/novel\/(\d+)/)?.[1] || '';
  } catch {
    return '';
  }
}

function sendProgress(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('crawler:progress', payload);
  }
}

async function ensureNovelWindow(show) {
  if (novelWindow && !novelWindow.isDestroyed()) {
    if (show) novelWindow.show();
    else novelWindow.hide();
    return novelWindow;
  }

  novelWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show: Boolean(show),
    title: 'NTK 소설 작업 브라우저',
    backgroundColor: '#111319',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  novelWindow.webContents.setBackgroundThrottling(false);
  novelWindow.on('closed', () => { novelWindow = null; });
  return novelWindow;
}

async function loadNovelPage(url, show) {
  const window = await ensureNovelWindow(show);
  try {
    await window.loadURL(url);
  } catch {
    // 일부 부가 리소스가 실패해도 본문 DOM은 정상 표시될 수 있습니다.
  }
  await sleep(1100);
  return window;
}

async function extractNovelText(contents) {
  return contents.executeJavaScript(`
    (() => {
      const clean = (value) => String(value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n[ \\t]+/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const explicitSelectors = [
        '#novel_content',
        '#novel-content',
        '.novel-content',
        '.novel-view-content',
        '.novel-viewer',
        '.novel-body',
        '.novel-text',
        '.viewer-content',
        '.view-content',
        '[data-novel-content]',
        '[class*="novel"][class*="content"]',
        '[class*="novel"][class*="viewer"]'
      ];

      const explicit = explicitSelectors
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .filter((element) => clean(element.innerText).length >= 80);

      const candidates = explicit.length
        ? explicit
        : [...document.querySelectorAll('article, main, section, div')]
            .filter((element) => {
              if (element.closest('header, nav, footer, aside')) return false;
              const text = clean(element.innerText);
              return text.length >= 200;
            });

      let best = null;
      let bestScore = -Infinity;

      for (const element of candidates) {
        const text = clean(element.innerText);
        if (!text) continue;

        const linkText = [...element.querySelectorAll('a')]
          .map((a) => clean(a.innerText))
          .join(' ');
        const buttonText = [...element.querySelectorAll('button')]
          .map((b) => clean(b.innerText))
          .join(' ');
        const lineCount = text.split(/\\n+/).filter(Boolean).length;
        const childPenalty = Math.min(element.querySelectorAll('*').length, 800) * 0.7;
        const navigationPenalty = (linkText.length + buttonText.length) * 2.2;
        const noisePenalty = /댓글|추천|목록|로그인|회원가입|광고문의|북마크/.test(text) ? 180 : 0;
        const score = text.length + lineCount * 18 - navigationPenalty - childPenalty - noisePenalty;

        if (score > bestScore) {
          bestScore = score;
          best = { element, text };
        }
      }

      if (!best || best.text.length < 80) {
        return { text: '', title: '', selector: '', length: 0 };
      }

      const title = clean(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.novel-title')?.innerText ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '');

      let selector = best.element.id ? '#' + best.element.id : '';
      if (!selector && typeof best.element.className === 'string' && best.element.className.trim()) {
        selector = '.' + best.element.className.trim().split(/\\s+/).slice(0, 3).join('.');
      }

      return { text: best.text, title, selector, length: best.text.length };
    })()
  `);
}

async function downloadNovelEpisodes(payload = {}) {
  cancelRequested = false;
  const selected = (payload.episodes || [])
    .filter((episode) => episode.selected !== false)
    .sort((a, b) => Number(a.number) - Number(b.number));

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

  let meta = await readJson(metaPath, {
    title,
    slug: seriesSlug,
    sourceUrl,
    contentType: 'novel',
    createdAt: new Date().toISOString(),
    episodes: [],
  });
  meta.title = title;
  meta.sourceUrl = sourceUrl;
  meta.contentType = 'novel';
  meta.updatedAt = new Date().toISOString();

  let completedEpisodes = 0;

  for (let index = 0; index < selected.length; index += 1) {
    if (cancelRequested) break;
    const episode = selected[index];
    const number = Number(episode.number);
    const padded = String(number).padStart(4, '0');
    const episodeDir = path.join(episodesDir, padded);
    const contentPath = path.join(episodeDir, 'content.txt');
    const manifestPath = path.join(episodeDir, 'manifest.json');
    await fsp.mkdir(episodeDir, { recursive: true });

    const existing = await readJson(manifestPath);
    if (existing?.completed && fs.existsSync(contentPath) && !payload.force) {
      completedEpisodes += 1;
      sendProgress({ type: 'episode-skipped', episode: number, index: index + 1, total: selected.length, pageCount: 1 });
      continue;
    }

    sendProgress({ type: 'episode-start', episode: number, title: episode.title, index: index + 1, total: selected.length, contentType: 'novel' });
    const window = await loadNovelPage(episode.url, payload.showBrowser !== false);

    let extracted = { text: '', title: '', selector: '', length: 0 };
    for (let retry = 0; retry < 4; retry += 1) {
      extracted = await extractNovelText(window.webContents);
      if (extracted.text.length >= 80) break;
      await sleep(500);
    }

    if (extracted.text.length < 80) {
      await writeJson(manifestPath, {
        episode: number,
        title: episode.title,
        url: episode.url,
        contentType: 'novel',
        completed: false,
        error: '본문 텍스트를 찾지 못했습니다.',
        updatedAt: new Date().toISOString(),
      });
      sendProgress({ type: 'episode-error', episode: number, message: '본문 텍스트를 찾지 못했습니다.' });
      continue;
    }

    await fsp.writeFile(contentPath, extracted.text, 'utf-8');
    await writeJson(manifestPath, {
      episode: number,
      title: episode.title,
      url: episode.url,
      contentType: 'novel',
      textFile: 'content.txt',
      textLength: extracted.length,
      selector: extracted.selector,
      pageCount: 1,
      completed: true,
      updatedAt: new Date().toISOString(),
    });

    const metaEpisode = {
      number,
      title: episode.title || `${number}화`,
      url: episode.url,
      contentType: 'novel',
      textLength: extracted.length,
      pageCount: 1,
      completed: true,
      updatedAt: new Date().toISOString(),
    };
    const existingIndex = meta.episodes.findIndex((item) => Number(item.number) === number);
    if (existingIndex >= 0) meta.episodes[existingIndex] = metaEpisode;
    else meta.episodes.push(metaEpisode);
    meta.episodes.sort((a, b) => Number(a.number) - Number(b.number));
    await writeJson(metaPath, meta);

    completedEpisodes += 1;
    sendProgress({ type: 'page-progress', episode: number, page: 1, pageTotal: 1, episodeIndex: index + 1, episodeTotal: selected.length });
    sendProgress({ type: 'episode-complete', episode: number, pageCount: 1, contentType: 'novel', index: index + 1, total: selected.length });
    await sleep(180);
  }

  sendProgress({ type: cancelRequested ? 'cancelled' : 'all-complete', completedEpisodes, totalEpisodes: selected.length, seriesSlug });
  return { completedEpisodes, totalEpisodes: selected.length, cancelled: cancelRequested, seriesSlug };
}

async function getEpisodeContent(seriesSlug, episodeNumber) {
  const libraryRoot = await getLibraryRoot();
  const episodeDir = path.join(libraryRoot, safeFileName(seriesSlug), 'episodes', String(episodeNumber).padStart(4, '0'));
  const contentPath = path.join(episodeDir, 'content.txt');
  try {
    const text = await fsp.readFile(contentPath, 'utf-8');
    return { type: 'text', text };
  } catch {
    return { type: 'images', text: '' };
  }
}

ipcMain.removeHandler('novel:download');
ipcMain.handle('novel:download', async (_event, payload) => downloadNovelEpisodes(payload || {}));

ipcMain.removeHandler('novel:cancel');
ipcMain.handle('novel:cancel', async () => {
  cancelRequested = true;
  return { ok: true };
});

ipcMain.removeHandler('library:episode-content');
ipcMain.handle('library:episode-content', async (_event, seriesSlug, episodeNumber) => getEpisodeContent(seriesSlug, episodeNumber));
