const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let workerWindow = null;
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

function sendProgress(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('crawler:progress', payload);
  }
}

function parseNovelIdentity(value) {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'novel' || !parts[1]) return null;
    return { origin: url.origin, key: decodeURIComponent(parts[1]) };
  } catch { return null; }
}

function stableStorageKey(value) {
  const text = String(value || '');
  if (/^\d+$/.test(text)) return text;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${safeFileName(text, 'novel')}-${(hash >>> 0).toString(16)}`;
}

async function ensureWorker(show) {
  if (workerWindow && !workerWindow.isDestroyed()) {
    if (show) workerWindow.show(); else workerWindow.hide();
    return workerWindow;
  }
  workerWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show: Boolean(show),
    title: 'NTK 소설 다운로드',
    backgroundColor: '#111319',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  workerWindow.webContents.setBackgroundThrottling(false);
  workerWindow.on('closed', () => { workerWindow = null; });
  return workerWindow;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(value) {
  return cleanText(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function candidateScore(text, hint = '', sourceUrl = '') {
  const value = cleanText(text);
  if (value.length < 100) return -Infinity;
  const hangul = (value.match(/[가-힣]/g) || []).length;
  const sentences = (value.match(/[.!?…]|다\.|요\./g) || []).length;
  const newlines = (value.match(/\n/g) || []).length;
  const noise = (value.match(/뉴토끼|로그인|회원가입|댓글|광고문의|책갈피|이전화|다음화|불러오는 중|static\/chunks|webpack|__next/gi) || []).length;
  let score = Math.min(value.length, 40000) + hangul * 4 + sentences * 28 + newlines * 15;
  if (/content|text|body|chapter|episode|novel|payload|data/i.test(hint)) score += 2000;
  if (/api|novel|episode|content/i.test(sourceUrl)) score += 600;
  if (hangul / Math.max(value.length, 1) > 0.22) score += 1800;
  score -= noise * 1000;
  return score;
}

function collectStrings(value, hint, out, depth = 0) {
  if (depth > 14 || out.length > 5000) return;
  if (typeof value === 'string') {
    const text = cleanText(value);
    if (text.length >= 100) {
      out.push({ text, hint });
      if (/<[a-z][\s\S]*>/i.test(text)) {
        const stripped = stripHtml(text);
        if (stripped.length >= 100) out.push({ text: stripped, hint: `${hint}:html` });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    const joined = value.filter((item) => typeof item === 'string').join('\n');
    if (joined.length >= 100) out.push({ text: cleanText(joined), hint: `${hint}:array` });
    value.forEach((item, index) => collectStrings(item, `${hint}[${index}]`, out, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectStrings(item, key || hint, out, depth + 1);
  }
}

function extractBestText(body, sourceUrl = '', mimeType = '') {
  const raw = String(body || '');
  if (!raw) return null;
  const candidates = [];
  try { collectStrings(JSON.parse(raw), 'json', candidates); } catch {}

  const quoted = raw.match(/"(?:[^"\\]|\\.){100,}"/g) || [];
  for (const item of quoted.slice(0, 1200)) {
    try {
      const decoded = JSON.parse(item);
      if (typeof decoded === 'string' && decoded.length >= 100) candidates.push({ text: cleanText(decoded), hint: 'quoted' });
    } catch {}
  }

  if (/html/i.test(mimeType) || /<[a-z][\s\S]*>/i.test(raw)) {
    const stripped = stripHtml(raw);
    if (stripped.length >= 100) candidates.push({ text: stripped, hint: 'html' });
  }
  if (!/^[\s\[{<]/.test(raw) && raw.length >= 100) candidates.push({ text: cleanText(raw), hint: 'raw' });

  let best = null;
  for (const candidate of candidates) {
    const score = candidateScore(candidate.text, candidate.hint, sourceUrl);
    if (!best || score > best.score) best = { ...candidate, score, sourceUrl, mimeType };
  }
  return best && best.score >= 1800 ? best : null;
}

async function extractDomText(contents) {
  try {
    return await contents.executeJavaScript(`
      (() => {
        const clean = (v) => String(v || '').replace(/\\u00a0/g,' ').replace(/\\r/g,'')
          .replace(/[ \\t]+\\n/g,'\\n').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
        const selectors = [
          '.novel-viewer-content','.novel-content','.novel-reader-content','.novel-text',
          '[data-novel-content]','[data-episode-content]','.novel-viewer article',
          '.novel-viewer .content','.novel-viewer'
        ];
        let best = '', selector = '';
        for (const current of selectors) {
          for (const element of document.querySelectorAll(current)) {
            const clone = element.cloneNode(true);
            clone.querySelectorAll('button,nav,script,style,.novel-toolbar,.reader-toolbar').forEach((node) => node.remove());
            const text = clean(clone.innerText || clone.textContent || '');
            if (/불러오는 중/.test(text) && text.length < 180) continue;
            if (text.length > best.length) { best = text; selector = current; }
          }
        }
        return { text: best, selector, length: best.length };
      })()
    `);
  } catch { return { text: '', selector: '', length: 0 }; }
}

async function inspectAndReplayResources(contents) {
  try {
    return await contents.executeJavaScript(`
      (async () => {
        const entries = performance.getEntriesByType('resource').map((entry) => ({
          url: String(entry.name || ''),
          initiatorType: String(entry.initiatorType || ''),
          duration: Number(entry.duration || 0),
          transferSize: Number(entry.transferSize || 0),
        }));
        const urls = [...new Set(entries
          .filter((entry) => /fetch|xmlhttprequest/i.test(entry.initiatorType) || /\\/api\\/|novel|episode|content/i.test(entry.url))
          .map((entry) => entry.url))].slice(0, 60);
        const bodies = [];
        for (const url of urls) {
          try {
            const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
            const type = response.headers.get('content-type') || '';
            const text = await response.text();
            if (text && text.length <= 5000000) {
              bodies.push({ url, status: response.status, mimeType: type, body: text });
            }
          } catch (error) {
            bodies.push({ url, status: 0, mimeType: '', body: '', error: String(error?.message || error) });
          }
        }
        return { entries, bodies };
      })()
    `, true);
  } catch (error) {
    return { entries: [], bodies: [], error: String(error?.message || error) };
  }
}

async function loadEpisodeAndExtract(window, episodeUrl) {
  let loadError = '';
  try { await window.loadURL(episodeUrl); }
  catch (error) { loadError = String(error?.message || error); }

  let dom = { text: '', selector: '', length: 0 };
  for (let round = 0; round < 28; round += 1) {
    if (cancelRequested) break;
    dom = await extractDomText(window.webContents);
    if (dom.text.length >= 120 && !/불러오는 중/.test(dom.text)) break;
    await sleep(250);
  }

  const domScore = candidateScore(dom.text, dom.selector, episodeUrl);
  if (dom.text.length >= 100 && domScore >= 1800) {
    return { text: dom.text, method: 'dom', selector: dom.selector, sourceUrl: episodeUrl, responseCount: 0, resourceCount: 0, loadError };
  }

  const replay = await inspectAndReplayResources(window.webContents);
  let best = null;
  for (const response of replay.bodies || []) {
    if (!response.body) continue;
    const candidate = extractBestText(response.body, response.url, response.mimeType);
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }

  if (best?.text?.length >= 100) {
    return {
      text: best.text,
      method: 'passive-network-replay',
      selector: best.hint,
      sourceUrl: best.sourceUrl,
      mimeType: best.mimeType,
      responseCount: replay.bodies.length,
      resourceCount: replay.entries.length,
      loadError,
    };
  }

  return {
    text: '', method: 'none', selector: '', sourceUrl: episodeUrl,
    responseCount: replay.bodies?.length || 0,
    resourceCount: replay.entries?.length || 0,
    resourceUrls: (replay.entries || []).filter((entry) => /fetch|xmlhttprequest/i.test(entry.initiatorType) || /\\/api\\/|novel|episode|content/i.test(entry.url)).slice(0, 80),
    replayError: replay.error || '', loadError,
  };
}

async function captureFailureDiagnostic(window, episode, extraction) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(app.getPath('userData'), 'diagnostics', `${stamp}-novel-passive-${safeFileName(episode.number)}`);
  await fsp.mkdir(folder, { recursive: true });
  let html = '';
  try { html = await window.webContents.executeJavaScript('document.documentElement?.outerHTML || ""'); } catch {}
  if (html) await fsp.writeFile(path.join(folder, 'page.html'), html, 'utf-8');
  try {
    const image = await window.webContents.capturePage();
    await fsp.writeFile(path.join(folder, 'visible-page.png'), image.toPNG());
  } catch {}
  await writeJson(path.join(folder, 'diagnostic.json'), { type: 'novel-passive-body-download', episode, extraction, createdAt: new Date().toISOString() });
  return folder;
}

async function downloadNovelEpisodes(payload = {}) {
  cancelRequested = false;
  const selected = (payload.episodes || []).filter((episode) => episode.selected !== false)
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (!selected.length) throw new Error('다운로드할 회차를 한 개 이상 선택하세요.');

  const realSourceUrl = payload.originalSourceUrl || payload.sourceUrl || selected[0]?.url || '';
  const identity = parseNovelIdentity(realSourceUrl) || parseNovelIdentity(selected[0]?.url || '');
  if (!identity) throw new Error('소설 작품 주소를 확인할 수 없습니다.');

  const storageKey = stableStorageKey(payload.seriesKey || identity.key);
  const title = safeFileName(payload.title || '소설');
  const libraryRoot = await getLibraryRoot();
  const seriesSlug = `novel-${storageKey}`;
  const seriesDir = path.join(libraryRoot, seriesSlug);
  const episodesDir = path.join(seriesDir, 'episodes');
  const metaPath = path.join(seriesDir, 'series.json');
  await fsp.mkdir(episodesDir, { recursive: true });

  let meta = await readJson(metaPath, { title, slug: seriesSlug, sourceUrl: realSourceUrl, contentType: 'novel', createdAt: new Date().toISOString(), episodes: [] });
  Object.assign(meta, { title, slug: seriesSlug, sourceUrl: realSourceUrl, contentType: 'novel', updatedAt: new Date().toISOString() });

  const window = await ensureWorker(payload.showBrowser !== false);
  let completedEpisodes = 0;

  for (let index = 0; index < selected.length; index += 1) {
    if (cancelRequested) break;
    const episode = selected[index];
    const number = Number(episode.number);
    const episodeDir = path.join(episodesDir, String(number).padStart(4, '0'));
    const contentPath = path.join(episodeDir, 'content.txt');
    const manifestPath = path.join(episodeDir, 'manifest.json');
    await fsp.mkdir(episodeDir, { recursive: true });

    const existing = await readJson(manifestPath);
    if (existing?.completed && fs.existsSync(contentPath) && !payload.force) {
      completedEpisodes += 1;
      sendProgress({ type: 'episode-skipped', episode: number, index: index + 1, total: selected.length, pageCount: 1, contentType: 'novel' });
      continue;
    }

    sendProgress({ type: 'episode-start', episode: number, title: episode.title, index: index + 1, total: selected.length, contentType: 'novel' });
    sendProgress({ type: 'warning', message: `${number}화 · 디버거 없이 본문을 불러오고 있습니다.` });
    const extraction = await loadEpisodeAndExtract(window, episode.url);

    if (!extraction.text || extraction.text.length < 100) {
      let folder = '';
      try { folder = await captureFailureDiagnostic(window, episode, extraction); } catch {}
      const message = folder
        ? `본문을 찾지 못했습니다. 리소스 ${extraction.resourceCount || 0}개 · 재확인 응답 ${extraction.responseCount || 0}개 · 진단 폴더: ${folder}`
        : `본문을 찾지 못했습니다. 리소스 ${extraction.resourceCount || 0}개 · 재확인 응답 ${extraction.responseCount || 0}개`;
      await writeJson(manifestPath, { episode: number, title: episode.title, url: episode.url, contentType: 'novel', completed: false, error: message, extraction, updatedAt: new Date().toISOString() });
      sendProgress({ type: 'episode-error', episode: number, message });
      continue;
    }

    await fsp.writeFile(contentPath, extraction.text, 'utf-8');
    await writeJson(manifestPath, {
      episode: number, title: episode.title, url: episode.url, contentType: 'novel', textFile: 'content.txt',
      textLength: extraction.text.length, extractionMethod: extraction.method, selector: extraction.selector,
      responseUrl: extraction.method === 'passive-network-replay' ? extraction.sourceUrl : '', pageCount: 1, completed: true,
      updatedAt: new Date().toISOString(),
    });

    const metaEpisode = { number, title: episode.title || `${number}화`, url: episode.url, contentType: 'novel', textLength: extraction.text.length, pageCount: 1, completed: true, extractionMethod: extraction.method, updatedAt: new Date().toISOString() };
    const oldIndex = meta.episodes.findIndex((item) => Number(item.number) === number);
    if (oldIndex >= 0) meta.episodes[oldIndex] = metaEpisode; else meta.episodes.push(metaEpisode);
    meta.episodes.sort((a, b) => Number(a.number) - Number(b.number));
    await writeJson(metaPath, meta);

    completedEpisodes += 1;
    sendProgress({ type: 'page-progress', episode: number, page: 1, pageTotal: 1, episodeIndex: index + 1, episodeTotal: selected.length, contentType: 'novel' });
    sendProgress({ type: 'episode-complete', episode: number, pageCount: 1, contentType: 'novel', index: index + 1, total: selected.length });
    sendProgress({ type: 'warning', message: `${number}화 저장 완료 · ${extraction.method === 'dom' ? '화면 본문' : '네트워크 재확인 본문'} · ${extraction.text.length}자` });
    await sleep(180);
  }

  sendProgress({ type: cancelRequested ? 'cancelled' : 'all-complete', completedEpisodes, totalEpisodes: selected.length, seriesSlug });
  return { completedEpisodes, totalEpisodes: selected.length, cancelled: cancelRequested, seriesSlug };
}

function requestCancel() { cancelRequested = true; }

module.exports = { downloadNovelEpisodes, requestCancel };
