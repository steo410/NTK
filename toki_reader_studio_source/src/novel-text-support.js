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

async function primeNovelPage(contents) {
  for (let round = 0; round < 10; round += 1) {
    await contents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const distance = Math.max(window.innerHeight * 0.9, 700);
        if (root) root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        window.scrollBy(0, distance);
      })()
    `).catch(() => undefined);
    await sleep(90);
  }

  await contents.executeJavaScript(`
    (() => {
      const root = document.scrollingElement || document.documentElement;
      if (root) root.scrollTop = 0;
      window.scrollTo(0, 0);
    })()
  `).catch(() => undefined);
}

async function loadNovelPage(url, show) {
  const window = await ensureNovelWindow(show);
  try { await window.loadURL(url); } catch {}

  for (let round = 0; round < 40; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        textLength: document.body?.innerText?.length || 0,
        frames: document.querySelectorAll('iframe').length,
      }))()
    `).catch(() => ({ ready: 'loading', textLength: 0, frames: 0 }));

    if (state.ready !== 'loading' && state.textLength > 30) break;
    await sleep(250);
  }

  await primeNovelPage(window.webContents);
  await sleep(300);
  return window;
}

const NOVEL_EXTRACT_SCRIPT = `
(() => {
  const clean = (v) => String(v || '')
    .replace(/\\u00a0/g, ' ')
    .replace(/\\r/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n[ \\t]+/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

  const roots = [document];
  const rootSeen = new Set(roots);
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    for (const element of root.querySelectorAll?.('*') || []) {
      if (element.shadowRoot && !rootSeen.has(element.shadowRoot)) {
        rootSeen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
  }

  const queryAll = (selector) => {
    const output = [];
    const seen = new Set();
    for (const root of roots) {
      let nodes = [];
      try { nodes = [...root.querySelectorAll(selector)]; } catch {}
      for (const node of nodes) {
        if (!seen.has(node)) {
          seen.add(node);
          output.push(node);
        }
      }
    }
    return output;
  };

  const explicitSelectors = [
    '#novel_content', '#novel-content', '#novel-viewer', '#novel-reader',
    '#episode-content', '#episode-body', '#reader-content', '#viewer-content',
    '.novel-content', '.novel-view-content', '.novel-viewer-content',
    '.novel-viewer', '.novel-reader', '.novel-reader-content', '.novel-body',
    '.novel-text', '.novel-episode-content', '.novel-episode-body',
    '.episode-content', '.episode-body', '.episode-text', '.reader-content',
    '.reader-body', '.reader-text', '.viewer-content', '.view-content',
    '.text-viewer', '.text-reader', '.reading-content', '.content-text',
    '[data-novel-content]', '[data-episode-content]', '[data-reader-content]',
    '[data-viewer-content]', '[class*="novel"][class*="content"]',
    '[class*="novel"][class*="reader"]', '[class*="novel"][class*="viewer"]',
    '[class*="episode"][class*="content"]', '[class*="reader"][class*="content"]',
    '[class*="viewer"][class*="content"]'
  ];

  const candidates = [];
  const candidateSeen = new Set();

  const addCandidate = (element, explicit = false, label = '') => {
    if (!element || candidateSeen.has(element)) return;
    const text = clean(element.innerText || element.textContent || '');
    if (text.length < 40) return;
    candidateSeen.add(element);
    candidates.push({ element, text, explicit, label });
  };

  for (const selector of explicitSelectors) {
    for (const element of queryAll(selector)) addCandidate(element, true, selector);
  }

  for (const element of queryAll('article, main, section, [role="main"], div')) {
    if (element.closest?.('header, nav, footer, aside')) continue;
    addCandidate(element, false, 'generic');
  }

  for (const container of queryAll('article, main, section, div')) {
    if (container.closest?.('header, nav, footer, aside')) continue;
    const paragraphs = [...container.querySelectorAll?.('p') || []]
      .map((p) => clean(p.innerText || p.textContent || ''))
      .filter((text) => text.length > 0);
    if (paragraphs.length >= 3) {
      const text = clean(paragraphs.join('\n\n'));
      if (text.length >= 80) {
        candidates.push({ element: container, text, explicit: false, label: 'paragraph-group' });
      }
    }
  }

  if (document.body) addCandidate(document.body, false, 'body-fallback');

  let best = null;
  let bestScore = -Infinity;
  const diagnostics = [];
  const noisePattern = /(댓글|추천|목록으로|로그인|회원가입|광고문의|북마크|이전\s*회차|다음\s*회차|에피소드\s*\()/g;

  for (const candidate of candidates) {
    const element = candidate.element;
    const text = candidate.text;
    const linksLength = [...element.querySelectorAll?.('a') || []]
      .map((a) => clean(a.innerText || a.textContent || '')).join(' ').length;
    const buttonsLength = [...element.querySelectorAll?.('button') || []]
      .map((b) => clean(b.innerText || b.textContent || '')).join(' ').length;
    const lineCount = text.split(/\n+/).filter(Boolean).length;
    const noiseCount = (text.match(noisePattern) || []).length;
    const classText = String(element.className || '');
    const idText = String(element.id || '');
    const semantic = (classText + ' ' + idText).toLowerCase();

    let score = text.length + lineCount * 22;
    score -= (linksLength + buttonsLength) * 3.2;
    score -= noiseCount * 360;
    if (candidate.explicit) score += 7000;
    if (candidate.label === 'paragraph-group') score += 2600;
    if (/(novel|reader|viewer|episode|content|body|text|read)/.test(semantic)) score += 1600;
    if (element.tagName === 'ARTICLE') score += 1000;
    if (element.tagName === 'MAIN') score += 700;
    if (element.tagName === 'BODY') score -= 5000;
    if (text.length > 300) score += 600;
    if (text.length > 1000) score += 900;

    diagnostics.push({
      tag: element.tagName || '',
      id: idText,
      className: classText.slice(0, 180),
      label: candidate.label,
      textLength: text.length,
      score,
      sample: text.slice(0, 220),
    });

    if (score > bestScore) {
      bestScore = score;
      best = { element, text, label: candidate.label };
    }
  }

  diagnostics.sort((a, b) => b.score - a.score);

  if (!best || best.text.length < 80) {
    return {
      text: '', selector: '', length: 0, score: bestScore,
      frameUrl: location.href,
      bodyTextLength: clean(document.body?.innerText || '').length,
      candidates: diagnostics.slice(0, 20),
    };
  }

  let selector = best.element.id ? '#' + best.element.id : '';
  if (!selector && typeof best.element.className === 'string' && best.element.className.trim()) {
    selector = '.' + best.element.className.trim().split(/\\s+/).slice(0, 4).join('.');
  }
  if (!selector) selector = best.element.tagName?.toLowerCase?.() || best.label || '';

  return {
    text: best.text,
    selector,
    length: best.text.length,
    score: bestScore,
    frameUrl: location.href,
    bodyTextLength: clean(document.body?.innerText || '').length,
    candidates: diagnostics.slice(0, 20),
  };
})()
`;

async function getContentFrames(contents) {
  const frames = [];
  const seen = new Set();
  const add = (frame) => {
    if (!frame || seen.has(frame)) return;
    seen.add(frame);
    frames.push(frame);
  };

  try {
    add(contents.mainFrame);
    for (const frame of contents.mainFrame.framesInSubtree || []) add(frame);
  } catch {}

  return frames;
}

async function extractNovelText(contents) {
  const frames = await getContentFrames(contents);
  let best = { text: '', selector: '', length: 0, score: -Infinity, frameUrl: '', candidates: [] };

  if (!frames.length) {
    try {
      const result = await contents.executeJavaScript(NOVEL_EXTRACT_SCRIPT);
      return result || best;
    } catch {
      return best;
    }
  }

  for (const frame of frames) {
    try {
      const result = await frame.executeJavaScript(NOVEL_EXTRACT_SCRIPT);
      if (result && Number(result.score) > Number(best.score)) best = result;
      if (result?.text?.length >= 300 && Number(result.score) >= 5000) return result;
    } catch {}
  }

  return best;
}

async function captureNovelDiagnostic(window, episode, attempts = []) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(
    app.getPath('userData'),
    'diagnostics',
    `${stamp}-novel-${safeFileName(episode?.number || 'episode')}`,
  );
  await fsp.mkdir(folder, { recursive: true });

  let html = '';
  try {
    html = await window.webContents.executeJavaScript('document.documentElement?.outerHTML || ""');
  } catch {}
  if (html) await fsp.writeFile(path.join(folder, 'page.html'), html, 'utf-8');

  const frames = [];
  for (const frame of await getContentFrames(window.webContents)) {
    try {
      const info = await frame.executeJavaScript(`
        (() => {
          const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
          const nodes = [...document.querySelectorAll('article, main, section, div, p')]
            .map((el) => ({
              tag: el.tagName || '',
              id: el.id || '',
              className: String(el.className || '').slice(0, 200),
              textLength: clean(el.innerText || el.textContent || '').length,
              sample: clean(el.innerText || el.textContent || '').slice(0, 260),
            }))
            .filter((item) => item.textLength > 0)
            .sort((a, b) => b.textLength - a.textLength)
            .slice(0, 40);
          return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            bodyTextLength: clean(document.body?.innerText || '').length,
            bodyTextPreview: clean(document.body?.innerText || '').slice(0, 3000),
            iframes: [...document.querySelectorAll('iframe')].map((item) => item.src || item.getAttribute('src') || ''),
            topTextNodes: nodes,
          };
        })()
      `);
      frames.push(info);
    } catch (error) {
      frames.push({ url: frame.url || '', error: String(error?.message || error) });
    }
  }

  try {
    const image = await window.webContents.capturePage();
    await fsp.writeFile(path.join(folder, 'visible-page.png'), image.toPNG());
  } catch {}

  await writeJson(path.join(folder, 'diagnostic.json'), {
    type: 'novel-body-extraction',
    episode: {
      number: episode?.number,
      title: episode?.title,
      url: episode?.url,
    },
    attempts,
    frames,
    createdAt: new Date().toISOString(),
  });

  return folder;
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
    let extracted = { text:'', selector:'', length:0, score:-Infinity, frameUrl:'', candidates:[] };
    const attempts = [];

    for (let retry=0; retry<8; retry+=1) {
      extracted = await extractNovelText(window.webContents);
      attempts.push({
        retry: retry + 1,
        length: extracted.length || 0,
        selector: extracted.selector || '',
        frameUrl: extracted.frameUrl || '',
        score: extracted.score,
        bodyTextLength: extracted.bodyTextLength || 0,
        candidates: extracted.candidates || [],
      });
      if (extracted.text.length >= 80) break;
      if (retry === 2 || retry === 5) await primeNovelPage(window.webContents);
      await sleep(650);
    }

    if (extracted.text.length < 80) {
      let diagnosticFolder = '';
      try {
        diagnosticFolder = await captureNovelDiagnostic(window, episode, attempts);
      } catch {}

      const diagnosticMessage = diagnosticFolder
        ? `본문 텍스트를 찾지 못했습니다. 진단 폴더: ${diagnosticFolder}`
        : '본문 텍스트를 찾지 못했습니다.';

      await writeJson(manifestPath, {
        episode:number,
        title:episode.title,
        url:episode.url,
        contentType:'novel',
        completed:false,
        error:diagnosticMessage,
        updatedAt:new Date().toISOString(),
      });
      sendProgress({ type:'episode-error', episode:number, message:diagnosticMessage });
      continue;
    }

    await fsp.writeFile(contentPath, extracted.text, 'utf-8');
    await writeJson(manifestPath, {
      episode:number,
      title:episode.title,
      url:episode.url,
      contentType:'novel',
      textFile:'content.txt',
      textLength:extracted.length,
      selector:extracted.selector,
      frameUrl:extracted.frameUrl || '',
      pageCount:1,
      completed:true,
      updatedAt:new Date().toISOString(),
    });
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
