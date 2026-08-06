const { BrowserWindow, ipcMain } = require('electron');

let scanWindow = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  for (let round = 0; round < 20; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        anchors: document.querySelectorAll('a[href]').length,
        textLength: document.body?.innerText?.length || 0,
      }))()
    `).catch(() => ({ ready: 'loading', anchors: 0, textLength: 0 }));

    if (
      state.ready !== 'loading' &&
      Number(state.anchors) > 20 &&
      Number(state.textLength) > 200
    ) {
      break;
    }

    await sleep(250);
  }

  // 목록이 아래쪽에서 지연 렌더링되는 경우를 대비해 페이지 전체를 한 번 훑습니다.
  for (let step = 0; step <= 20; step += 1) {
    await window.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const maxScroll = Math.max(
          (root?.scrollHeight || 0) - (root?.clientHeight || 0),
          0
        );
        const next = Math.round(maxScroll * ${step / 20});
        if (root) root.scrollTop = next;
        window.scrollTo(0, next);
      })()
    `).catch(() => undefined);
    await sleep(90);
  }

  await window.webContents.executeJavaScript(`window.scrollTo(0, 0)`).catch(() => undefined);
  await sleep(150);
}

async function collectCurrentPage(window, seriesId) {
  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const pathPattern = new RegExp('^/webtoon/' + seriesId + '/\\d+/?$');

      function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      const bodyText = clean(document.body?.innerText || '');
      const totalMatch = bodyText.match(/총\\s*(\\d+)\\s*회차/);
      const totalEpisodes = totalMatch ? Number(totalMatch[1]) : null;

      function rowFor(anchor) {
        const candidates = [
          anchor.closest('li'),
          anchor.closest('article'),
          anchor.closest('tr'),
          anchor.closest('[class*="episode"]'),
          anchor.closest('[class*="list-item"]'),
          anchor.closest('[class*="webtoon-item"]'),
          anchor.closest('[class*="item"]'),
          anchor.closest('[class*="row"]'),
          anchor.closest('[class*="card"]'),
          anchor.parentElement,
        ].filter(Boolean);

        return candidates.sort((a, b) => {
          const aText = clean(a.innerText || a.textContent || '');
          const bText = clean(b.innerText || b.textContent || '');
          return aText.length - bText.length;
        })[0] || anchor;
      }

      function extractTitleCandidates(row, anchor) {
        const values = new Set();
        const elements = [
          anchor,
          ...row.querySelectorAll(
            'a, span, strong, b, p, h1, h2, h3, h4, h5, div'
          ),
        ];

        for (const element of elements) {
          const value = clean(element.innerText || element.textContent || '');
          if (!value || value.length > 180 || !value.includes('화')) continue;
          if (/최신화\\s*보기/.test(value)) continue;
          values.add(value);
        }

        const rowText = clean(row.innerText || row.textContent || '');
        if (rowText && rowText.length <= 260 && rowText.includes('화')) {
          values.add(rowText);
        }

        return [...values].sort((a, b) => a.length - b.length);
      }

      function extractNumber(candidates) {
        const valid = [];

        for (const candidate of candidates) {
          const matches = [...candidate.matchAll(/(?:^|\\D)(\\d{1,4}(?:\\.\\d+)?)\\s*화/g)];

          for (const match of matches) {
            const number = Number(match[1]);
            if (!Number.isFinite(number) || number <= 0) continue;
            if (totalEpisodes && number > totalEpisodes) continue;
            valid.push({
              number,
              text: candidate,
              score: candidate.length,
            });
          }
        }

        if (!valid.length) return null;

        valid.sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          return b.number - a.number;
        });

        return valid[0];
      }

      function cleanTitle(value, number) {
        let title = clean(value)
          .replace(/^0*\\d+\\s*[-–]\\s*/, '')
          .replace(/\\d{2}\\.\\d{2}\\.\\d{2}.*$/, '')
          .trim();

        if (!title || !new RegExp('(?:^|\\D)' + number + '(?:\\.\\d+)?\\s*화').test(title)) {
          title = number + '화';
        }

        return title;
      }

      const byUrl = new Map();
      let matchingUrlCount = 0;
      let parsedTitleCount = 0;

      for (const anchor of document.querySelectorAll('a[href]')) {
        let href = '';

        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }

        const parsed = new URL(href);
        if (!pathPattern.test(parsed.pathname)) continue;

        const combined = clean(
          (anchor.innerText || anchor.textContent || '') + ' ' +
          (anchor.parentElement?.innerText || anchor.parentElement?.textContent || '')
        );

        if (/최신화\\s*보기/.test(combined)) continue;

        matchingUrlCount += 1;
        if (byUrl.has(href)) continue;

        const row = rowFor(anchor);
        const candidates = extractTitleCandidates(row, anchor);
        const extracted = extractNumber(candidates);

        if (!extracted) continue;

        parsedTitleCount += 1;
        byUrl.set(href, {
          number: extracted.number,
          title: cleanTitle(extracted.text, extracted.number),
          url: href,
        });
      }

      const byNumber = new Map();

      for (const episode of byUrl.values()) {
        const current = byNumber.get(episode.number);

        if (!current || episode.title.length > current.title.length) {
          byNumber.set(episode.number, episode);
        }
      }

      const episodes = [...byNumber.values()]
        .sort((a, b) => a.number - b.number)
        .slice(0, 100);

      const title = clean(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.webtoon-title')?.innerText ||
        document.querySelector('.toon-title')?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '').trim();

      return {
        episodes,
        title,
        totalEpisodes,
        matchingUrlCount,
        parsedTitleCount,
      };
    })()
  `);
}

async function scanCurrentPage(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  if (!sourceUrl) throw new Error('작품 목록 URL을 입력하세요.');

  const parsedUrl = new URL(sourceUrl);
  const seriesMatch = parsedUrl.pathname.match(/^\/webtoon\/(\d+)/);
  if (!seriesMatch) throw new Error('지원되는 작품 URL 형식이 아닙니다.');

  const seriesId = seriesMatch[1];
  const minEpisode = parseBound(payload.minEpisode, Number.NEGATIVE_INFINITY);
  const maxEpisode = parseBound(payload.maxEpisode, Number.POSITIVE_INFINITY);
  const window = await ensureWindow(payload.showBrowser !== false);

  event.sender.send('crawler:progress', {
    type: 'status',
    message: '현재 페이지의 회차 행을 정확히 분석하고 있습니다.',
  });

  let snapshot = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await loadAndWait(window, sourceUrl);
    snapshot = await collectCurrentPage(window, seriesId);

    if (snapshot.episodes.length > 0) break;

    if (attempt === 1) {
      event.sender.send('crawler:progress', {
        type: 'warning',
        message: '첫 분석 결과가 0개여서 페이지를 새로고침한 뒤 다시 확인합니다.',
      });
      await window.webContents.reloadIgnoringCache().catch(() => undefined);
      await sleep(700);
    }
  }

  const filtered = (snapshot?.episodes || [])
    .filter((episode) => episode.number >= minEpisode && episode.number <= maxEpisode)
    .map((episode) => ({ ...episode, selected: true }))
    .slice(0, 100);

  if (!filtered.length) {
    throw new Error(
      `회차 분석 실패: 일치 URL ${snapshot?.matchingUrlCount || 0}개, ` +
      `제목 분석 성공 ${snapshot?.parsedTitleCount || 0}개`
    );
  }

  return {
    title: snapshot.title,
    sourceUrl,
    episodes: filtered,
    count: filtered.length,
    totalEpisodes: snapshot.totalEpisodes,
    mode: 'current-page-exact-rows',
  };
}

ipcMain.removeHandler('crawler:scan');
ipcMain.handle('crawler:scan', async (event, payload) => {
  return scanCurrentPage(event, payload);
});
