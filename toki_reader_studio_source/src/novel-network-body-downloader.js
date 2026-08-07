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
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const settings = await readJson(settingsPath, {});
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
    return { origin: url.origin, key: parts[1] };
  } catch {
    return null;
  }
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

function looksBase64(text) {
  return text.length >= 120 && text.length % 4 === 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(text);
}

function tryDecodeBase64(text) {
  if (!looksBase64(text)) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf-8');
    if ((decoded.match(/[가-힣]/g) || []).length >= 10) return cleanText(decoded);
  } catch {}
  return '';
}

function candidateScore(text, keyHint = '', sourceUrl = '') {
  const value = cleanText(text);
  if (value.length < 80) return -Infinity;

  const hangul = (value.match(/[가-힣]/g) || []).length;
  const newlines = (value.match(/\n/g) || []).length;
  const sentences = (value.match(/[.!?…]\s|다\.|요\.|다\n/g) || []).length;
  const noise = (value.match(/뉴토끼|로그인|회원가입|댓글|광고문의|책갈피|목록|이전화|다음화|불러오는 중|static\/chunks|__next|webpack|function\s*\(|Content Security Policy/gi) || []).length;
  const keyBonus = /content|text|body|chapter|episode|novel|html|payload|data/i.test(keyHint) ? 2200 : 0;
  const apiBonus = /api|novel|episode|content/i.test(sourceUrl) ? 700 : 0;
  const density = hangul / Math.max(value.length, 1);

  let score = Math.min(value.length, 30000) + hangul * 4 + newlines * 18 + sentences * 25 + keyBonus + apiBonus;
  score += density > 0.25 ? 1800 : 0;
  score -= noise * 900;
  if (/^[\[{]/.test(value) && /"(?:content|text|body)"/.test(value)) score -= 1200;
  return score;
}

function collectStrings(value, keyHint, output, depth = 0) {
  if (depth > 14 || output.length > 5000) return;
  if (typeof value === 'string') {
    const raw = cleanText(value);
    if (raw.length >= 80) {
      output.push({ text: raw, keyHint });
      if (/<[a-z][\s\S]*>/i.test(raw)) {
        const stripped = stripHtml(raw);
        if (stripped.length >= 80 && stripped !== raw) output.push({ text: stripped, keyHint: `${keyHint}:html` });
      }
      const decoded = tryDecodeBase64(raw);
      if (decoded) output.push({ text: decoded, keyHint: `${keyHint}:base64` });
    }
    return;
  }
  if (Array.isArray(value)) {
    const joined = value.filter((item) => typeof item === 'string').join('\n');
    if (joined.length >= 80) output.push({ text: cleanText(joined), keyHint: `${keyHint}:array` });
    value.forEach((item, index) => collectStrings(item, `${keyHint}[${index}]`, output, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectStrings(item, key || keyHint, output, depth + 1);
  }
}

function extractBestTextFromBody(body, sourceUrl = '', mimeType = '') {
  const candidates = [];
  const rawBody = String(body || '');
  if (!rawBody) return null;

  try {
    const parsed = JSON.parse(rawBody);
    collectStrings(parsed, 'json', candidates);
  } catch {}

  // Next/RSC 응답이나 이중 인코딩 JSON 안의 긴 문자열도 수집합니다.
  const quoted = rawBody.match(/"(?:[^"\\]|\\.){100,}"/g) || [];
  for (const item of quoted.slice(0, 1500)) {
    try {
      const decoded = JSON.parse(item);
      if (typeof decoded === 'string') {
        const cleaned = cleanText(decoded);
        if (cleaned.length >= 80) candidates.push({ text: cleaned, keyHint: 'quoted' });
      }
    } catch {}
  }

  if (/html/i.test(mimeType) || /<[a-z][\s\S]*>/i.test(rawBody)) {
    const stripped = stripHtml(rawBody);
    if (stripped.length >= 80) candidates.push({ text: stripped, keyHint: 'raw-html' });
  }

  if (!/^[\s\[{<]/.test(rawBody) && rawBody.length >= 80) {
    candidates.push({ text: cleanText(rawBody), keyHint: 'raw-text' });
  }

  let best = null;
  for (const candidate of candidates) {
    const score = candidateScore(candidate.text, candidate.keyHint, sourceUrl);
    if (!best || score > best.score) best = { ...candidate, score, sourceUrl, mimeType };
  }

  if (!best || best.score < 1500) return null;
  return best;
}

async function extractDomText(contents) {
  try {
    return await contents.executeJavaScript(`
      (() => {
        const clean = (value) => String(value || '')
          .replace(/\\u00a0/g, ' ')
          .replace(/\\r/g, '')
          .replace(/[ \\t]+\\n/g, '\\n')
          .replace(/\\n[ \\t]+/g, '\\n')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim();
        const selectors = [
          '.novel-viewer-content', '.novel-content', '.novel-reader-content',
          '.novel-text', '[data-novel-content]', '[data-episode-content]',
          '.novel-viewer article', '.novel-viewer .content', '.novel-viewer'
        ];
        let best = '';
        let selector = '';
        for (const current of selectors) {
          for (const el of document.querySelectorAll(current)) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('button, nav, .novel-toolbar, .reader-toolbar, script, style').forEach((node) => node.remove());
            const text = clean(clone.innerText || clone.textContent || '');
            if (/불러오는 중/.test(text) && text.length < 160) continue;
            if (text.length > best.length) { best = text; selector = current; }
          }
        }
        return { text: best, selector, length: best.length };
      })()
    `);
  } catch {
    return { text: '', selector: '', length: 0 };
  }
}

async function captureNetworkBodies(contents, pageUrl) {
  const responses = new Map();
  const bodies = [];
  let attachedHere = false;

  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      attachedHere = true;
    }
    await contents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
    });
  } catch (error) {
    return { bodies, error: String(error?.message || error), detach: async () => {} };
  }

  const onMessage = async (_event, method, params) => {
    if (method === 'Network.responseReceived') {
      const response = params?.response || {};
      const type = String(params?.type || '');
      const url = String(response.url || '');
      if (!['XHR', 'Fetch'].includes(type) && !/\/api\/|novel|episode|content/i.test(url)) return;
      responses.set(params.requestId, {
        requestId: params.requestId,
        url,
        type,
        status: response.status,
        mimeType: response.mimeType || '',
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const meta = responses.get(params?.requestId);
      if (!meta) return;
      responses.delete(params.requestId);
      try {
        const result = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: meta.requestId });
        let body = String(result?.body || '');
        if (result?.base64Encoded) body = Buffer.from(body, 'base64').toString('utf-8');
        if (body.length > 0 && body.length <= 8 * 1024 * 1024) bodies.push({ ...meta, body });
      } catch {}
    }
  };

  contents.debugger.on('message', onMessage);

  return {
    bodies,
    error: '',
    detach: async () => {
      try { contents.debugger.removeListener('message', onMessage); } catch {}
      if (attachedHere) {
        try { contents.debugger.detach(); } catch {}
      }
    },
  };
}

async function loadEpisodeAndExtract(window, episodeUrl) {
  const contents = window.webContents;
  const capture = await captureNetworkBodies(contents, episodeUrl);
  let loadError = '';

  try { await window.loadURL(episodeUrl); }
  catch (error) { loadError = String(error?.message || error); }

  let domBest = { text: '', selector: '', length: 0 };
  let networkBest = null;

  for (let round = 0; round < 32; round += 1) {
    if (cancelRequested) break;
    domBest = await extractDomText(contents);
    if (domBest.text.length >= 120 && !/불러오는 중/.test(domBest.text)) break;

    for (const response of capture.bodies) {
      const candidate = extractBestTextFromBody(response.body, response.url, response.mimeType);
      if (candidate && (!networkBest || candidate.score > networkBest.score)) networkBest = candidate;
    }
    if (networkBest?.text?.length >= 120 && networkBest.score >= 3000) break;
    await sleep(250);
  }

  // 마지막으로 모든 완료 응답을 한 번 더 평가합니다.
  for (const response of capture.bodies) {
    const candidate = extractBestTextFromBody(response.body, response.url, response.mimeType);
    if (candidate && (!networkBest || candidate.score > networkBest.score)) networkBest = candidate;
  }

  await capture.detach();

  const domScore = candidateScore(domBest.text, domBest.selector, episodeUrl);
  if (domBest.text.length >= 100 && domScore >= (networkBest?.score || -Infinity)) {
    return {
      text: domBest.text,
      method: 'dom',
      selector: domBest.selector,
      sourceUrl: episodeUrl,
      responseCount: capture.bodies.length,
      loadError,
      captureError: capture.error,
    };
  }

  if (networkBest?.text?.length >= 100) {
    return {
      text: networkBest.text,
      method: 'network-response',
      selector: networkBest.keyHint,
      sourceUrl: networkBest.sourceUrl,
      mimeType: networkBest.mimeType,
      responseCount: capture.bodies.length,
      loadError,
      captureError: capture.error,
    };
  }

  return {
    text: '',
    method: 'none',
    selector: '',
    sourceUrl: episodeUrl,
    responseCount: capture.bodies.length,
    loadError,
    captureError: capture.error,
  };
}

async function captureFailureDiagnostic(window, episode, extraction) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(app.getPath('userData'), 'diagnostics', `${stamp}-novel-network-${safeFileName(episode.number)}`);
  await fsp.mkdir(folder, { recursive: true });

  let html = '';
  try { html = await window.webContents.executeJavaScript('document.documentElement?.outerHTML || ""'); } catch {}
  if (html) await fsp.writeFile(path.join(folder, 'page.html'), html, 'utf-8');

  try {
    const image = await window.webContents.capturePage();
    await fsp.writeFile(path.join(folder, 'visible-page.png'), image.toPNG());
  } catch {}

  await writeJson(path.join(folder, 'diagnostic.json'), {
    type: 'novel-network-body-download',
    episode,
    extraction,
    createdAt: new Date().toISOString(),
  });
  return folder;
}

async function downloadNovelEpisodes(payload = {}) {
  cancelRequested = false;
  const selected = (payload.episodes || [])
    .filter((episode) => episode.selected !== false)
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

  let meta = await readJson(metaPath, {
    title,
    slug: seriesSlug,
    sourceUrl: realSourceUrl,
    contentType: 'novel',
    createdAt: new Date().toISOString(),
    episodes: [],
  });
  Object.assign(meta, {
    title,
    slug: seriesSlug,
    sourceUrl: realSourceUrl,
    contentType: 'novel',
    updatedAt: new Date().toISOString(),
  });

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
    sendProgress({ type: 'warning', message: `${number}화 · 화면 본문과 네트워크 응답을 동시에 확인합니다.` });

    const extraction = await loadEpisodeAndExtract(window, episode.url);

    if (!extraction.text || extraction.text.length < 100) {
      let folder = '';
      try { folder = await captureFailureDiagnostic(window, episode, extraction); } catch {}
      const message = folder
        ? `본문을 찾지 못했습니다. 네트워크 응답 ${extraction.responseCount || 0}개 확인 · 진단 폴더: ${folder}`
        : `본문을 찾지 못했습니다. 네트워크 응답 ${extraction.responseCount || 0}개 확인`;
      await writeJson(manifestPath, {
        episode: number,
        title: episode.title,
        url: episode.url,
        contentType: 'novel',
        completed: false,
        error: message,
        extraction,
        updatedAt: new Date().toISOString(),
      });
      sendProgress({ type: 'episode-error', episode: number, message });
      continue;
    }

    await fsp.writeFile(contentPath, extraction.text, 'utf-8');
    await writeJson(manifestPath, {
      episode: number,
      title: episode.title,
      url: episode.url,
      contentType: 'novel',
      textFile: 'content.txt',
      textLength: extraction.text.length,
      extractionMethod: extraction.method,
      selector: extraction.selector,
      responseUrl: extraction.method === 'network-response' ? extraction.sourceUrl : '',
      pageCount: 1,
      completed: true,
      updatedAt: new Date().toISOString(),
    });

    const metaEpisode = {
      number,
      title: episode.title || `${number}화`,
      url: episode.url,
      contentType: 'novel',
      textLength: extraction.text.length,
      pageCount: 1,
      completed: true,
      extractionMethod: extraction.method,
      updatedAt: new Date().toISOString(),
    };
    const oldIndex = meta.episodes.findIndex((item) => Number(item.number) === number);
    if (oldIndex >= 0) meta.episodes[oldIndex] = metaEpisode;
    else meta.episodes.push(metaEpisode);
    meta.episodes.sort((a, b) => Number(a.number) - Number(b.number));
    await writeJson(metaPath, meta);

    completedEpisodes += 1;
    sendProgress({ type: 'page-progress', episode: number, page: 1, pageTotal: 1, episodeIndex: index + 1, episodeTotal: selected.length, contentType: 'novel' });
    sendProgress({ type: 'episode-complete', episode: number, pageCount: 1, contentType: 'novel', index: index + 1, total: selected.length });
    sendProgress({ type: 'warning', message: `${number}화 저장 완료 · ${extraction.method === 'network-response' ? '네트워크 본문' : '화면 본문'} · ${extraction.text.length}자` });
    await sleep(180);
  }

  sendProgress({ type: cancelRequested ? 'cancelled' : 'all-complete', completedEpisodes, totalEpisodes: selected.length, seriesSlug });
  return { completedEpisodes, totalEpisodes: selected.length, cancelled: cancelRequested, seriesSlug };
}

function requestCancel() {
  cancelRequested = true;
}

module.exports = {
  downloadNovelEpisodes,
  requestCancel,
};
