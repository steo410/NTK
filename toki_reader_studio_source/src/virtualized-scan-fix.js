const { BrowserWindow, ipcMain } = require('electron');

let scanWindow = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseBound(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

async function ensureScanWindow(show) {
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

async function inspectVisibleEpisodes(window, seriesId) {
  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const pathPattern = new RegExp('^/webtoon/' + seriesId + '/\\\\d+/?$');

      function normalizeText(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function rowFor(anchor) {
        return anchor.closest(
          "li, article, tr, [class*='episode'], [class*='list-item'], " +
          "[class*='webtoon-item'], [class*='item'], [class*='row']"
        ) || anchor.parentElement || anchor;
      }

      function actualEpisodeNumber(anchor, row) {
        const texts = [
          normalizeText(anchor.innerText || anchor.textContent || ''),
          normalizeText(row.innerText || row.textContent || ''),
        ];

        for (const text of texts) {
          if (/최신화\\s*보기/.test(text)) continue;
          const matches = [...text.matchAll(/(\\d+(?:\\.\\d+)?)\\s*화/g)];
          if (!matches.length) continue;
          const value = Number(matches[matches.length - 1][1]);
          if (Number.isFinite(value) && value > 0) return value;
        }

        return null;
      }

      function cleanTitle(anchor, row, number) {
        const anchorText = normalizeText(anchor.innerText || anchor.textContent || '');
        const rowText = normalizeText(row.innerText || row.textContent || '');
        let title = anchorText.includes(String(number) + '화') ? anchorText : rowText;

        title = normalizeText(title)
          .replace(/^0*\\d+\\s*[-–]\\s*/, '')
          .replace(/\\d{2}\\.\\d{2}\\.\\d{2}.*$/, '')
          .trim();

        return title || String(number) + '화';
      }

      const episodes = [];
      const seen = new Set();

      for (const anchor of document.querySelectorAll('a[href]')) {
        let href = '';
        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }

        const parsed = new URL(href);
        if (!pathPattern.test(parsed.pathname)) continue;
        if (seen.has(href)) continue;

        const row = rowFor(anchor);
        const combined = normalizeText(
          (anchor.innerText || anchor.textContent || '') + ' ' +
          (row.innerText || row.textContent || '')
        );

        if (/최신화\\s*보기/.test(combined)) continue;

        const number = actualEpisodeNumber(anchor, row);
        if (!Number.isFinite(number)) continue;

        seen.add(href);
        episodes.push({
          number,
          title: cleanTitle(anchor, row, number),
          url: href,
        });
      }

      const root = document.scrollingElement || document.documentElement;
      const bodyText = normalizeText(document.body?.innerText || '');
      const totalMatch = bodyText.match(/총\\s*(\\d+)\\s*회차/);

      return {
        episodes,
        scrollTop: root?.scrollTop || 0,
        scrollHeight: Math.max(root?.scrollHeight || 0, document.body?.scrollHeight || 0),
        viewport: window.innerHeight || 800,
        totalEpisodes: totalMatch ? Number(totalMatch[1]) : null,
        title: normalizeText(
          document.querySelector('h1')?.innerText ||
          document.querySelector('.webtoon-title')?.innerText ||
          document.querySelector('.toon-title')?.innerText ||
          document.querySelector("meta[property='og:title']")?.content ||
          document.title || ''
        ).replace(/\\s*\\|.*$/, '').trim(),
      };
    })()
  `);
}

async function scanVirtualizedPage(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  if (!sourceUrl) throw new Error('작품 목록 URL을 입력하세요.');

  const parsedSource = new URL(sourceUrl);
  const seriesMatch = parsedSource.pathname.match(/^\/webtoon\/(\d+)/);
  if (!seriesMatch) throw new Error('지원되는 작품 URL 형식이 아닙니다.');

  const seriesId = seriesMatch[1];
  const minEpisode = parseBound(payload.minEpisode, Number.NEGATIVE_INFINITY);
  const maxEpisode = parseBound(payload.maxEpisode, Number.POSITIVE_INFINITY);
  const window = await ensureScanWindow(payload.showBrowser !== false);

  event.sender.send('crawler:progress', {
    type: 'status',
    message: '가상 스크롤 회차 목록을 위에서 아래까지 누적하고 있습니다.',
  });

  try {
    await window.loadURL(sourceUrl);
  } catch {
    // 일부 부가 리소스 실패는 무시합니다.
  }

  await sleep(1000);

  await window.webContents.executeJavaScript(`
    (() => {
      const root = document.scrollingElement || document.documentElement;
      if (root) root.scrollTop = 0;
      window.scrollTo(0, 0);
    })()
  `);
  await sleep(300);

  const episodeMap = new Map();
  let detectedTitle = '';
  let detectedTotal = null;
  let stableAtBottom = 0;
  let previousScrollTop = -1;

  for (let round = 0; round < 220; round += 1) {
    const snapshot = await inspectVisibleEpisodes(window, seriesId);

    detectedTitle = detectedTitle || snapshot.title || '';
    detectedTotal = detectedTotal || snapshot.totalEpisodes || null;

    for (const episode of snapshot.episodes || []) {
      const number = Number(episode.number);
      if (!Number.isFinite(number)) continue;
      if (number < minEpisode || number > maxEpisode) continue;

      if (!episodeMap.has(number)) {
        episodeMap.set(number, {
          number,
          title: episode.title,
          url: episode.url,
          selected: true,
        });
      }
    }

    event.sender.send('crawler:progress', {
      type: 'scan-progress',
      found: episodeMap.size,
      round: round + 1,
    });

    const atBottom =
      Number(snapshot.scrollTop) + Number(snapshot.viewport) >=
      Number(snapshot.scrollHeight) - 20;

    if (atBottom && Number(snapshot.scrollTop) === previousScrollTop) {
      stableAtBottom += 1;
    } else {
      stableAtBottom = 0;
    }

    if (atBottom && stableAtBottom >= 5) break;
    if (detectedTotal && episodeMap.size >= Math.min(100, detectedTotal)) break;

    previousScrollTop = Number(snapshot.scrollTop);

    await window.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const viewport = window.innerHeight || 800;
        const distance = Math.max(Math.round(viewport * 0.72), 520);
        if (root) {
          root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        }
        window.scrollBy(0, distance);
      })()
    `);

    await sleep(140);
  }

  const episodes = [...episodeMap.values()].sort((a, b) => a.number - b.number);

  if (!episodes.length) {
    throw new Error('입력한 페이지에서 실제 회차 제목을 찾지 못했습니다.');
  }

  return {
    title: detectedTitle,
    sourceUrl,
    episodes,
    count: episodes.length,
    totalEpisodes: detectedTotal,
    mode: 'virtualized-scroll-accumulator',
  };
}

ipcMain.removeHandler('crawler:scan');
ipcMain.handle('crawler:scan', async (event, payload) => {
  return scanVirtualizedPage(event, payload);
});
