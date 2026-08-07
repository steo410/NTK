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

async function loadAndWait(window, sourceUrl, contentType) {
  try {
    await window.loadURL(sourceUrl);
  } catch {
    // 부가 리소스 오류가 있어도 실제 DOM이 표시될 수 있습니다.
  }

  for (let round = 0; round < 40; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        comicRows: document.querySelectorAll('a.ep-row-v2-link[href]').length,
        novelRows: document.querySelectorAll('a.novel-ep-link[href]').length,
        anchors: document.querySelectorAll('a[href]').length,
        textLength: document.body?.innerText?.length || 0,
      }))()
    `).catch(() => ({ ready: 'loading', comicRows: 0, novelRows: 0, anchors: 0, textLength: 0 }));

    const rowCount = contentType === 'novel'
      ? Number(state.novelRows)
      : Number(state.comicRows);

    if (state.ready !== 'loading' && rowCount > 0) break;
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

async function getNovelLoadState(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('li.novel-ep-row')];
      const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ');
      const totalMatch = bodyText.match(/에피소드\\s*\\(\\s*(\\d+)\\s*화\\s*\\)/) ||
        bodyText.match(/·\\s*(\\d+)\\s*화/);
      const totalEpisodes = totalMatch ? Number(totalMatch[1]) : null;
      const buttons = [...document.querySelectorAll('button')];
      const loadMoreButton = buttons.find((button) =>
        /이전\\s*회차\\s*더\\s*보기/.test(String(button.innerText || button.textContent || '').trim())
      );

      const numbers = rows
        .map((row) => Number(row.dataset.ep))
        .filter((value) => Number.isFinite(value) && value > 0);

      return {
        rowCount: rows.length,
        totalEpisodes,
        minEpisode: numbers.length ? Math.min(...numbers) : null,
        maxEpisode: numbers.length ? Math.max(...numbers) : null,
        hasLoadMore: Boolean(loadMoreButton),
        loadMoreDisabled: Boolean(loadMoreButton?.disabled),
        loadMoreText: String(loadMoreButton?.innerText || loadMoreButton?.textContent || '').trim(),
      };
    })()
  `).catch(() => ({
    rowCount: 0,
    totalEpisodes: null,
    minEpisode: null,
    maxEpisode: null,
    hasLoadMore: false,
    loadMoreDisabled: false,
    loadMoreText: '',
  }));
}

async function expandAllNovelEpisodes(window, event) {
  let previousCount = -1;
  let unchangedRounds = 0;

  for (let round = 0; round < 50; round += 1) {
    const before = await getNovelLoadState(window);

    event.sender.send('crawler:progress', {
      type: 'warning',
      message: before.totalEpisodes
        ? `소설 회차 확장 중 · ${before.rowCount}/${before.totalEpisodes}개 로드됨`
        : `소설 회차 확장 중 · ${before.rowCount}개 로드됨`,
    });

    if (
      before.totalEpisodes &&
      before.rowCount >= before.totalEpisodes
    ) {
      return before;
    }

    if (!before.hasLoadMore || before.loadMoreDisabled) {
      return before;
    }

    const clicked = await window.webContents.executeJavaScript(`
      (() => {
        const button = [...document.querySelectorAll('button')].find((item) =>
          /이전\\s*회차\\s*더\\s*보기/.test(String(item.innerText || item.textContent || '').trim())
        );
        if (!button || button.disabled) return false;
        button.scrollIntoView({ block: 'center', behavior: 'instant' });
        button.click();
        return true;
      })()
    `).catch(() => false);

    if (!clicked) return before;

    let grew = false;
    for (let waitRound = 0; waitRound < 30; waitRound += 1) {
      await sleep(180);
      const after = await getNovelLoadState(window);
      if (after.rowCount > before.rowCount) {
        grew = true;
        break;
      }
      if (!after.hasLoadMore) break;
    }

    const after = await getNovelLoadState(window);

    if (after.rowCount === previousCount || !grew) {
      unchangedRounds += 1;
    } else {
      unchangedRounds = 0;
      previousCount = after.rowCount;
    }

    if (
      after.totalEpisodes &&
      after.rowCount >= after.totalEpisodes
    ) {
      return after;
    }

    if (!after.hasLoadMore || unchangedRounds >= 2) {
      return after;
    }
  }

  return getNovelLoadState(window);
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
      const totalPatterns = contentType === 'novel'
        ? [/에피소드\\s*\\(\\s*(\\d+)\\s*화\\s*\\)/, /총\\s*(\\d+)\\s*회차/, /·\\s*(\\d+)\\s*화/]
        : [/총\\s*(\\d+)\\s*회차/];
      let totalEpisodes = null;
      for (const pattern of totalPatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          totalEpisodes = Number(match[1]);
          break;
        }
      }

      const rowSelector = contentType === 'novel'
        ? 'a.novel-ep-link[href]'
        : 'a.ep-row-v2-link[href]';
      const rows = [...document.querySelectorAll(rowSelector)];
      const episodes = [];
      const seenUrls = new Set();
      const seenNumbers = new Set();
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
        if (!parsed.pathname.startsWith(expectedPrefix)) {
          invalidHrefCount += 1;
          continue;
        }
        if (seenUrls.has(href)) continue;

        let number = null;
        let titleText = '';

        if (contentType === 'novel') {
          const li = row.closest('li.novel-ep-row');
          const dataEpisode = Number(li?.dataset?.ep);
          const numberText = clean(row.querySelector('.ne-num')?.innerText || row.querySelector('.ne-num')?.textContent || '');
          const numberMatch = numberText.match(/(\\d{1,6}(?:\\.\\d+)?)\\s*화/);
          number = Number.isFinite(dataEpisode) && dataEpisode > 0
            ? dataEpisode
            : numberMatch ? Number(numberMatch[1]) : null;
          const episodeTitle = clean(row.querySelector('.ne-title')?.innerText || row.querySelector('.ne-title')?.textContent || '');
          titleText = episodeTitle
            ? String(number) + '화 ' + episodeTitle
            : clean(row.innerText || row.textContent || '');
        } else {
          const titleElement = row.querySelector('.ep-row-v2-title strong') ||
            row.querySelector('.ep-row-v2-title') ||
            row.querySelector('strong');
          titleText = clean(titleElement?.innerText || titleElement?.textContent || '');
          const matches = [...titleText.matchAll(/(\\d{1,5}(?:\\.\\d+)?)\\s*화/g)];
          number = matches.length ? Number(matches[matches.length - 1][1]) : null;
        }

        if (!Number.isFinite(number) || number <= 0) {
          invalidTitleCount += 1;
          continue;
        }
        if (seenNumbers.has(number)) continue;

        seenUrls.add(href);
        seenNumbers.add(number);
        episodes.push({
          number,
          title: titleText || number + '화',
          url: href,
          contentType,
        });
      }

      const title = clean(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.webtoon-title')?.innerText ||
        document.querySelector('.manhwa-title')?.innerText ||
        document.querySelector('.novel-title')?.innerText ||
        document.querySelector('.nd-title')?.innerText ||
        document.querySelector('.toon-title')?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '').trim();

      const sorted = episodes.sort((a, b) => a.number - b.number);

      return {
        episodes: contentType === 'novel' ? sorted : sorted.slice(0, 100),
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
    message: identity.type === 'novel'
      ? '소설 전용 회차 목록(novel-ep-row)을 분석하고 있습니다.'
      : `${identity.type} 작품의 실제 회차 행(ep-row-v2)을 분석하고 있습니다.`,
  });

  let snapshot = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await loadAndWait(window, sourceUrl, identity.type);

    if (identity.type === 'novel') {
      const expanded = await expandAllNovelEpisodes(window, event);
      event.sender.send('crawler:progress', {
        type: 'warning',
        message: expanded.totalEpisodes
          ? `소설 회차 확장 완료 · ${expanded.rowCount}/${expanded.totalEpisodes}개 로드됨`
          : `소설 회차 확장 완료 · ${expanded.rowCount}개 로드됨`,
      });
    }

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
    .map((episode) => ({ ...episode, selected: true }));

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
    episodes: identity.type === 'novel' ? filtered : filtered.slice(0, 100),
    count: identity.type === 'novel' ? filtered.length : Math.min(filtered.length, 100),
    totalEpisodes: snapshot.totalEpisodes,
    mode: identity.type === 'novel' ? 'novel-ep-row-text-all-loaded' : 'ep-row-v2-exact-multi-path',
  };
}

ipcMain.removeHandler('crawler:scan');
ipcMain.handle('crawler:scan', async (event, payload) => scanCurrentPage(event, payload));
