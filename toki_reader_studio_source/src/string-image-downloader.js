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

function parseIdentity(value) {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (!['webtoon', 'manhwa'].includes(parts[0]) || !parts[1]) return null;
    return { type: parts[0], key: decodeURIComponent(parts[1]), isNumeric: /^\d+$/.test(parts[1]) };
  } catch { return null; }
}

function stableSlug(identity) {
  let hash = 2166136261;
  const text = `${identity.type}:${identity.key}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${identity.type}-${safeFileName(identity.key, 'series')}-${(hash >>> 0).toString(16)}`;
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
    title: 'NTK 문자열 작품 다운로드',
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

async function loadEpisode(window, url) {
  try { await window.loadURL(url); } catch {}
  for (let round = 0; round < 36; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        textLength: document.body?.innerText?.length || 0,
        images: document.images?.length || 0,
      }))()
    `).catch(() => ({ ready: 'loading', textLength: 0, images: 0 }));
    if (state.ready !== 'loading' && (state.images > 0 || state.textLength > 80)) break;
    await sleep(250);
  }
  await sleep(700);
}

async function resetScroll(contents, toBottom = false) {
  await contents.executeJavaScript(`
    (() => {
      const root = document.scrollingElement || document.documentElement;
      const target = ${toBottom ? 'Math.max((root?.scrollHeight || 0) - (root?.clientHeight || 0), 0)' : '0'};
      if (root) root.scrollTop = target;
      window.scrollTo(0, target);
      return target;
    })()
  `).catch(() => undefined);
  await sleep(180);
}

async function scanVisibleImages(contents, direction = 1) {
  return contents.executeJavaScript(`
    (() => {
      const direction = ${Number(direction)};
      const lazyAttrs = ['data-src','data-original','data-lazy','data-url','data-img','data-original-src'];
      const excluded = ['logo','favicon','avatar','profile','banner','advert','/ads/','emoji','spinner','loading.gif','blank.','transparent.','brand/'];
      const preferred = [...document.querySelectorAll('.vw-imgs img')];
      const selectors = [
        '.vw-imgs img','.view-padding img','.view-content img','#toon_img img',
        '.viewer img','.webtoon-viewer img','.manhwa-viewer img','.episode-viewer img',
        '.view-wrap img','img.viewer-ratio-img','img[alt^="page "]','img[data-page]'
      ];
      const raw = preferred.length
        ? preferred
        : [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
      const output = [];

      function forceLoad(image) {
        image.loading = 'eager';
        image.decoding = 'sync';
        if (!image.src || image.naturalWidth === 0) {
          for (const attr of lazyAttrs) {
            const value = image.getAttribute(attr);
            if (value) { image.src = value; break; }
          }
        }
      }

      for (const image of raw) {
        forceLoad(image);
        if (image.closest('header,nav,footer,button,.site-chrome')) continue;
        const src = String(image.currentSrc || image.src || image.getAttribute('data-src') || '');
        const lower = src.toLowerCase();
        if (!src || excluded.some((part) => lower.includes(part))) continue;
        const rect = image.getBoundingClientRect();
        const width = Math.max(rect.width || 0, image.naturalWidth || 0);
        const height = Math.max(rect.height || 0, image.naturalHeight || 0);
        if (width < 260 || height < 100) continue;
        const alt = String(image.alt || image.getAttribute('aria-label') || '');
        const orderText = String(
          image.getAttribute('data-page') || image.dataset?.page || image.getAttribute('data-index') || image.dataset?.index || alt || ''
        );
        const orderMatch = orderText.match(/(?:page\\s*)?(\\d{1,5})/i);
        output.push({
          src,
          alt,
          order: orderMatch ? Number(orderMatch[1]) : null,
          displayWidth: Math.max(rect.width || 0, 0),
          displayHeight: Math.max(rect.height || 0, 0),
          naturalWidth: image.naturalWidth || 0,
          naturalHeight: image.naturalHeight || 0,
          documentY: rect.top + window.scrollY,
        });
      }

      const root = document.scrollingElement || document.documentElement;
      const viewport = Math.max(window.innerHeight || 800, 600);
      const maxScroll = Math.max((root?.scrollHeight || 0) - (root?.clientHeight || 0), 0);
      const current = root?.scrollTop || window.scrollY || 0;
      const next = Math.max(0, Math.min(current + direction * Math.round(viewport * 0.72), maxScroll));
      if (root) root.scrollTop = next;
      window.scrollTo(0, next);
      return {
        images: output,
        scrollTop: next,
        maxScroll,
        scrollHeight: root?.scrollHeight || 0,
        viewport,
        atEnd: direction > 0 ? next >= maxScroll - 4 : next <= 4,
      };
    })()
  `).catch(() => ({ images: [], scrollTop: 0, maxScroll: 0, scrollHeight: 0, atEnd: true }));
}

async function collectAllImageSources(contents, progressEpisode) {
  const found = new Map();
  let discovery = 0;
  let stableAtEnd = 0;
  let previousScrollHeight = -1;

  const merge = (records) => {
    let added = 0;
    for (const item of records || []) {
      if (!item.src) continue;
      const current = found.get(item.src);
      if (!current) {
        found.set(item.src, { ...item, discovery: discovery++ });
        added += 1;
      } else {
        if (!current.order && item.order) current.order = item.order;
        current.displayWidth = Math.max(current.displayWidth || 0, item.displayWidth || 0);
        current.displayHeight = Math.max(current.displayHeight || 0, item.displayHeight || 0);
        current.naturalWidth = Math.max(current.naturalWidth || 0, item.naturalWidth || 0);
        current.naturalHeight = Math.max(current.naturalHeight || 0, item.naturalHeight || 0);
      }
    }
    return added;
  };

  await resetScroll(contents, false);
  for (let round = 0; round < 240; round += 1) {
    if (cancelRequested) break;
    const snapshot = await scanVisibleImages(contents, 1);
    const added = merge(snapshot.images);
    if (snapshot.atEnd && added === 0 && snapshot.scrollHeight === previousScrollHeight) stableAtEnd += 1;
    else stableAtEnd = 0;
    previousScrollHeight = snapshot.scrollHeight;

    if (round % 6 === 0 || added > 0) {
      sendProgress({ type: 'warning', message: `${progressEpisode}화 · 전체 이미지 탐색 중 ${found.size}개 발견` });
    }
    if (stableAtEnd >= 8) break;
    await sleep(150);
  }

  // 가상화 목록에서 아래로 내려갈 때 놓친 요소를 역방향으로 한 번 더 확인합니다.
  await resetScroll(contents, true);
  let stableAtTop = 0;
  for (let round = 0; round < 90; round += 1) {
    if (cancelRequested) break;
    const snapshot = await scanVisibleImages(contents, -1);
    const added = merge(snapshot.images);
    if (snapshot.atEnd && added === 0) stableAtTop += 1; else stableAtTop = 0;
    if (stableAtTop >= 5) break;
    await sleep(130);
  }

  const items = [...found.values()];
  const orderedCount = items.filter((item) => Number.isFinite(item.order)).length;
  items.sort((a, b) => {
    if (orderedCount >= Math.max(2, Math.floor(items.length * 0.6))) {
      const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
    }
    return a.discovery - b.discovery;
  });
  return items;
}

async function prepareCaptureStage(contents, item) {
  return contents.executeJavaScript(`
    (async () => {
      document.getElementById('ntk-string-capture-stage')?.remove();
      const root = document.scrollingElement || document.documentElement;
      if (root) root.scrollTop = 0;
      window.scrollTo(0, 0);
      const stage = document.createElement('div');
      stage.id = 'ntk-string-capture-stage';
      Object.assign(stage.style, {
        position: 'absolute', left: '0px', top: '0px', zIndex: '2147480000',
        padding: '0', margin: '0', background: '#fff', lineHeight: '0', overflow: 'visible'
      });
      const image = document.createElement('img');
      image.src = ${JSON.stringify(item.src)};
      image.loading = 'eager';
      image.decoding = 'sync';
      image.referrerPolicy = 'no-referrer-when-downgrade';
      Object.assign(image.style, { display: 'block', margin: '0', padding: '0', maxWidth: 'none', maxHeight: 'none' });
      const preferredWidth = ${Number(item.displayWidth || 0)};
      if (preferredWidth >= 260) image.style.width = Math.round(preferredWidth) + 'px';
      stage.appendChild(image);
      document.documentElement.appendChild(stage);
      if (!image.complete || image.naturalWidth === 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 15000);
          image.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
          image.addEventListener('error', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지 로딩 실패');
      if (!image.style.width) image.style.width = Math.min(image.naturalWidth, 1400) + 'px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = image.getBoundingClientRect();
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        src: image.currentSrc || image.src,
      };
    })()
  `);
}

async function removeCaptureStage(contents) {
  await contents.executeJavaScript(`document.getElementById('ntk-string-capture-stage')?.remove()`).catch(() => undefined);
}

async function captureStage(contents, rect, outputPath) {
  let attachedHere = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      attachedHere = true;
    }
    await contents.debugger.sendCommand('Page.enable');
    const capture = await contents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: {
        x: Math.max(0, Number(rect.x)), y: Math.max(0, Number(rect.y)),
        width: Math.max(1, Number(rect.width)), height: Math.max(1, Number(rect.height)), scale: 1,
      },
    });
    const buffer = Buffer.from(capture.data, 'base64');
    if (buffer.length < 2000) throw new Error(`캡처 파일이 너무 작습니다: ${buffer.length} bytes`);
    await fsp.writeFile(outputPath, buffer);
    return buffer.length;
  } finally {
    if (attachedHere) {
      try { contents.debugger.detach(); } catch {}
    }
  }
}

async function downloadStringImages(payload = {}) {
  cancelRequested = false;
  const selected = (payload.episodes || []).filter((episode) => episode.selected !== false)
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (!selected.length) throw new Error('다운로드할 회차를 한 개 이상 선택하세요.');

  const source = payload.sourceUrl || selected[0]?.url || '';
  const identity = parseIdentity(source) || parseIdentity(selected[0]?.url || '');
  if (!identity || identity.isNumeric) throw new Error('문자열 작품 주소를 확인할 수 없습니다.');

  const title = safeFileName(payload.title || '만화');
  const seriesSlug = stableSlug(identity);
  const libraryRoot = await getLibraryRoot();
  const seriesDir = path.join(libraryRoot, seriesSlug);
  const episodesDir = path.join(seriesDir, 'episodes');
  const metaPath = path.join(seriesDir, 'series.json');
  await fsp.mkdir(episodesDir, { recursive: true });

  let meta = await readJson(metaPath, { title, slug: seriesSlug, sourceUrl: source, contentType: identity.type, createdAt: new Date().toISOString(), episodes: [] });
  Object.assign(meta, { title, slug: seriesSlug, sourceUrl: source, contentType: identity.type, updatedAt: new Date().toISOString() });

  const window = await ensureWorker(payload.showBrowser !== false);
  let completedEpisodes = 0;

  for (let episodeIndex = 0; episodeIndex < selected.length; episodeIndex += 1) {
    if (cancelRequested) break;
    const episode = selected[episodeIndex];
    const number = Number(episode.number);
    const episodeDir = path.join(episodesDir, String(number).padStart(4, '0'));
    const manifestPath = path.join(episodeDir, 'manifest.json');
    await fsp.mkdir(episodeDir, { recursive: true });

    const existing = await readJson(manifestPath);
    if (existing?.completed && !payload.force) {
      completedEpisodes += 1;
      sendProgress({ type: 'episode-skipped', episode: number, index: episodeIndex + 1, total: selected.length, pageCount: existing.pageCount || 0 });
      continue;
    }

    sendProgress({ type: 'episode-start', episode: number, title: episode.title, index: episodeIndex + 1, total: selected.length });
    await loadEpisode(window, episode.url);
    const items = await collectAllImageSources(window.webContents, number);

    if (!items.length) {
      await writeJson(manifestPath, { episode: number, title: episode.title, url: episode.url, completed: false, error: '전체 스크롤 이미지 0개', updatedAt: new Date().toISOString() });
      sendProgress({ type: 'episode-error', episode: number, message: '본문 이미지를 찾지 못했습니다.' });
      continue;
    }

    sendProgress({ type: 'warning', message: `${number}화 · 전체 스크롤에서 ${items.length}개 이미지를 찾았습니다.` });
    const manifest = { episode: number, title: episode.title, url: episode.url, pageCount: items.length, completed: false, pages: [], updatedAt: new Date().toISOString() };
    let success = 0;

    for (let index = 0; index < items.length; index += 1) {
      if (cancelRequested) break;
      const pageNumber = index + 1;
      const outputPath = path.join(episodeDir, `${String(pageNumber).padStart(4, '0')}.png`);
      if (fs.existsSync(outputPath) && !payload.force) {
        const stat = await fsp.stat(outputPath);
        manifest.pages.push({ index: pageNumber, file: path.basename(outputPath), bytes: stat.size, existing: true, src: items[index].src });
        success += 1;
      } else {
        try {
          const rect = await prepareCaptureStage(window.webContents, items[index]);
          const bytes = await captureStage(window.webContents, rect, outputPath);
          manifest.pages.push({ index: pageNumber, file: path.basename(outputPath), bytes, src: items[index].src, naturalWidth: rect.naturalWidth, naturalHeight: rect.naturalHeight });
          success += 1;
        } catch (error) {
          manifest.pages.push({ index: pageNumber, src: items[index].src, error: String(error?.message || error) });
        } finally {
          await removeCaptureStage(window.webContents);
        }
      }
      sendProgress({ type: 'page-progress', episode: number, page: pageNumber, pageTotal: items.length, episodeIndex: episodeIndex + 1, episodeTotal: selected.length });
      await sleep(80);
    }

    manifest.completed = !cancelRequested && success === items.length;
    manifest.successCount = success;
    manifest.updatedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);

    const metaEpisode = { number, title: episode.title || `${number}화`, url: episode.url, pageCount: items.length, completed: manifest.completed, updatedAt: new Date().toISOString() };
    const oldIndex = meta.episodes.findIndex((item) => Number(item.number) === number);
    if (oldIndex >= 0) meta.episodes[oldIndex] = metaEpisode; else meta.episodes.push(metaEpisode);
    meta.episodes.sort((a, b) => Number(a.number) - Number(b.number));
    await writeJson(metaPath, meta);

    if (manifest.completed) {
      completedEpisodes += 1;
      sendProgress({ type: 'episode-complete', episode: number, pageCount: items.length, index: episodeIndex + 1, total: selected.length });
    } else {
      sendProgress({ type: 'episode-error', episode: number, message: `${success}/${items.length}개 저장` });
    }
    await sleep(250);
  }

  sendProgress({ type: cancelRequested ? 'cancelled' : 'all-complete', completedEpisodes, totalEpisodes: selected.length, seriesSlug });
  return { completedEpisodes, totalEpisodes: selected.length, cancelled: cancelRequested, seriesSlug };
}

function requestCancel() { cancelRequested = true; }
module.exports = { downloadStringImages, requestCancel };
