const { BrowserWindow, ipcMain } = require('electron');

let scanWindow = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTENT_PATH_PATTERN = /^\/(webtoon|manhwa|novel)\/(\d+)/;

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function parseBound(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function parseContentIdentity(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const match = parsed.pathname.match(CONTENT_PATH_PATTERN);
    if (!match) return null;
    return { type: match[1], id: match[2] };
  } catch {
    return null;
  }
}

async function ensureWindow(show) {
  if (scanWindow && !scanWindow.isDestroyed()) {
    if (show) scanWindow.show();
    else scanWindow.hide();
    return scanWindow;
  }

  scanWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show: Boolean(show),
    title: 'NTK 회차 검색',
    backgroundColor: '#111319',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  scanWindow.webContents.setBackgroundThrottling(false);
  scanWindow.on('closed', () => {
    scanWindow = null;
  });

  return scanWindow;
}

async function loadAndWait(window, sourceUrl) {
  try {
    await window.loadURL(sourceUrl);
  } catch {
    // 부가 리소스 오류가 있어도 실제 DOM이 표시될 수 있습니다.
  }

  for (let round = 0; round < 40; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        episodeRows: document.querySelectorAll('a.ep-row-v2-link[href]').length,
        anchors: document.querySelectorAll('a[href]').length,
        textLength: document.body?.innerText?.length || 0,
      }))()
    `).catch(() => ({ ready: 'loading', episodeRows: 0, anchors: 0, textLength: 0 }));

    if (state.ready !== 'loading' && Number(state.episodeRows) > 0) break;
    await sleep(250);
  }

  await window.webContents.executeJavaScript(`
    (() => {
      const root = document.scrollingElement || document.documentElement;
      const maxScroll = Math.max((root?.scrollHeight || 0) - (root?.clientHeight || 0), 0);
      if (root) root.scrollTop = maxScroll;
      window.scrollTo(0, maxScroll);
    })()
  `).catch(() => undefined);

  await sleep(250);

  await window.webContents.executeJavaScript(`
    (() => {
      const root = document.scrollingElement || document.documentElement;
      if (root) root.scrollTop = 0;
      window.scrollTo(0, 0);
    })()
  `).catch(() => undefined);

  await sleep(120);
}

async function collectCurrentPage(window, contentType, seriesId) {
  return window.webContents.executeJavaScript(`
    (() => {
      const contentType = ${JSON.stringify(contentType)};
      const seriesId = ${JSON.stringify(seriesId)};

      function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      const bodyText = clean(document.body?.innerText || '');
      const totalMatch = bodyText.match(/총\\s*(\\d+)\\s*회차/);
      const totalEpisodes = totalMatch ? Number(totalMatch[1]) : null;
      const rows = [...document.querySelectorAll('a.ep-row-v2-link[href]')];
      const episodes = [];
      const seenUrls = new Set();
      let invalidHrefCount = 0;
      let invalidTitleCount = 0;

      for (const row of rows) {
        let href = '';

        try {
          href = new URL(row.getAttribute('href'), location.href).href;
        } catch {
          invalidHrefCount += 1;
          continue;
        }

        const parsed = new URL(href);
        const expectedPrefix = '/' + contentType + '/' + seriesId + '/';

        // webtoon / manhwa / novel 각각 입력한 작품의 실제 회차 행만 허용합니다.
        if (!parsed.pathname.startsWith(expectedPrefix)) {
          invalidHrefCount += 1;
          continue;
        }

        if (seenUrls.has(href)) continue;

        const titleElement = row.querySelector('.ep-row-v2-title strong') ||
          row.querySelector('.ep-row-v2-title') ||
          row.querySelector('strong');
        const titleText = clean(titleElement?.innerText || titleElement?.textContent || '');
        const matches = [...titleText.matchAll(/(\\d{1,5}(?:\\.\\d+)?)\\s*화/g)];

        if (!matches.length) {
          invalidTitleCount += 1;
          continue;
        }

        const number = Number(matches[matches.length - 1][1]);

        if (!Number.isFinite(number) || number <= 0) {
          invalidTitleCount += 1;
          continue;
        }

        seenUrls.add(href);
        episodes.push({
          number,
          title: titleText || number + '화',
          url: href,
        });
      }

      const title = clean(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.webtoon-title')?.innerText ||
        document.querySelector('.manhwa-title')?.innerText ||
        document.querySelector('.novel-title')?.innerText ||
        document.querySelector('.toon-title')?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '').trim();

      return {
        episodes: episodes.slice(0, 100),
        title,
        totalEpisodes,
        rowCount: rows.length,
        matchingUrlCount: seenUrls.size,
        parsedTitleCount: episodes.length,
        invalidHrefCount,
        invalidTitleCount,
      };
    })()
  `);
}

async function safeReload(window) {
  try {
    const result = window.webContents.reloadIgnoringCache();
    if (result && typeof result.then === 'function') await result;
  } catch {
    // 새로고침 자체가 실패해도 다음 로딩 시도를 계속합니다.
  }
}

async function scanCurrentPage(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  if (!sourceUrl) throw new Error('작품 목록 URL을 입력하세요.');

  const identity = parseContentIdentity(sourceUrl);
  if (!identity) {
    throw new Error('지원되는 URL 형식은 /webtoon/숫자, /manhwa/숫자, /novel/숫자 입니다.');
  }

  const minEpisode = parseBound(payload.minEpisode, Number.NEGATIVE_INFINITY);
  const maxEpisode = parseBound(payload.maxEpisode, Number.POSITIVE_INFINITY);
  const window = await ensureWindow(payload.showBrowser !== false);

  event.sender.send('crawler:progress', {
    type: 'status',
    message: `${identity.type} 작품의 실제 회차 행(ep-row-v2)을 분석하고 있습니다.`,
  });

  let snapshot = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await loadAndWait(window, sourceUrl);
    snapshot = await collectCurrentPage(window, identity.type, identity.id);

    event.sender.send('crawler:progress', {
      type: 'warning',
      message: `회차 행 ${snapshot.rowCount}개 · URL 확인 ${snapshot.matchingUrlCount}개 · 제목 분석 ${snapshot.parsedTitleCount}개`,
    });

    if (snapshot.episodes.length > 0) break;

    if (attempt === 1) {
      event.sender.send('crawler:progress', {
        type: 'warning',
        message: '첫 분석 결과가 0개여서 페이지를 새로고침한 뒤 다시 확인합니다.',
      });
      await safeReload(window);
      await sleep(700);
    }
  }

  const filtered = (snapshot?.episodes || [])
    .filter((episode) => episode.number >= minEpisode && episode.number <= maxEpisode)
    .map((episode) => ({ ...episode, selected: true }))
    .slice(0, 100);

  if (!filtered.length) {
    throw new Error(
      `회차 분석 실패: 실제 행 ${snapshot?.rowCount || 0}개, ` +
      `URL 확인 ${snapshot?.matchingUrlCount || 0}개, ` +
      `제목 분석 ${snapshot?.parsedTitleCount || 0}개`
    );
  }

  return {
    title: snapshot.title,
    sourceUrl,
    contentType: identity.type,
    seriesId: identity.id,
    episodes: filtered,
    count: filtered.length,
    totalEpisodes: snapshot.totalEpisodes,
    mode: 'ep-row-v2-exact-multi-path',
  };
}

ipcMain.removeHandler('crawler:scan');
ipcMain.handle('crawler:scan', async (event, payload) => scanCurrentPage(event, payload));
