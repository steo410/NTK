const { BrowserWindow, ipcMain } = require('electron');

let fullScanWindow = null;
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

async function ensureWindow(show) {
  if (fullScanWindow && !fullScanWindow.isDestroyed()) {
    if (show) fullScanWindow.show();
    else fullScanWindow.hide();
    return fullScanWindow;
  }

  fullScanWindow = new BrowserWindow({
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

  fullScanWindow.webContents.setBackgroundThrottling(false);
  fullScanWindow.on('closed', () => {
    fullScanWindow = null;
  });

  return fullScanWindow;
}

async function preparePage(window, sourceUrl) {
  try {
    await window.loadURL(sourceUrl);
  } catch {
    // 부가 리소스 오류가 있어도 실제 DOM이 표시될 수 있습니다.
  }

  await sleep(1400);

  // 페이지가 늦게 회차 목록을 그리는 경우를 대비해 잠시 반복 대기합니다.
  for (let round = 0; round < 8; round += 1) {
    const count = await window.webContents.executeJavaScript(`
      document.querySelectorAll('a[href]').length
    `).catch(() => 0);

    if (Number(count) > 20) break;
    await sleep(350);
  }
}

async function discoverScrollTargets(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const targets = [];
      const seen = new Set();

      function add(element, type) {
        if (!element || seen.has(element)) return;
        seen.add(element);

        const scrollHeight = Math.max(element.scrollHeight || 0, 0);
        const clientHeight = Math.max(element.clientHeight || 0, 0);

        if (scrollHeight <= clientHeight + 40) return;

        const id = 'ntk-scroll-' + targets.length;
        element.setAttribute('data-ntk-scroll-id', id);
        targets.push({
          id,
          type,
          scrollHeight,
          clientHeight,
          maxScroll: Math.max(scrollHeight - clientHeight, 0),
        });
      }

      add(document.scrollingElement || document.documentElement, 'document');

      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        const overflowY = style.overflowY;

        if (!['auto', 'scroll', 'overlay'].includes(overflowY)) continue;
        add(element, 'element');
      }

      return targets
        .sort((a, b) => b.maxScroll - a.maxScroll)
        .slice(0, 12);
    })()
  `);
}

async function moveTarget(window, targetId, ratio) {
  return window.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(
        '[data-ntk-scroll-id=${JSON.stringify(targetId).slice(1, -1)}]'
      );

      if (!element) return false;

      const maxScroll = Math.max(
        (element.scrollHeight || 0) - (element.clientHeight || 0),
        0
      );
      const next = Math.round(maxScroll * ${Number(ratio)});
      element.scrollTop = next;

      if (
        element === document.scrollingElement ||
        element === document.documentElement ||
        element === document.body
      ) {
        window.scrollTo(0, next);
      }

      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()
  `).catch(() => false);
}

async function collectVisible(window, seriesId) {
  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const pathPattern = new RegExp('^/webtoon/' + seriesId + '/\\\\d+/?$');

      function text(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function rowFor(anchor) {
        return anchor.closest(
          "li, article, tr, [class*='episode'], [class*='list-item'], " +
          "[class*='webtoon-item'], [class*='item'], [class*='row'], " +
          "[class*='card']"
        ) || anchor.parentElement || anchor;
      }

      function titleNumber(anchorText, rowText) {
        const candidates = [anchorText, rowText];

        for (const candidate of candidates) {
          if (!candidate || /최신화\\s*보기/.test(candidate)) continue;
          const matches = [...candidate.matchAll(/(\\d+(?:\\.\\d+)?)\\s*화/g)];
          if (!matches.length) continue;

          // 제목 앞 관리번호가 있더라도 마지막 n화를 실제 화수로 사용합니다.
          const value = Number(matches[matches.length - 1][1]);
          if (Number.isFinite(value) && value > 0) return value;
        }

        return null;
      }

      function thumbnailNumber(row) {
        const image = row.querySelector('img');
        const values = [
          image?.alt,
          image?.title,
          image?.getAttribute('aria-label'),
          row.querySelector('[class*="thumb"]')?.innerText,
          row.querySelector('[class*="number"]')?.innerText,
          row.querySelector('[class*="no"]')?.innerText,
        ].map(text).filter(Boolean);

        for (const value of values) {
          const match = value.match(/(?:^|\\D)(\\d{1,5})(?:화)?(?:$|\\D)/);
          if (!match) continue;
          const number = Number(match[1]);
          if (Number.isFinite(number) && number > 0) return number;
        }

        return null;
      }

      function cleanTitle(anchorText, rowText, number) {
        let value = anchorText.includes(String(number) + '화')
          ? anchorText
          : rowText;

        value = text(value)
          .replace(/^0*\\d+\\s*[-–]\\s*/, '')
          .replace(/\\d{2}\\.\\d{2}\\.\\d{2}.*$/, '')
          .trim();

        if (!value || !value.includes(String(number) + '화')) {
          return String(number) + '화';
        }

        return value;
      }

      const episodes = [];
      const seenUrls = new Set();

      for (const anchor of document.querySelectorAll('a[href]')) {
        let href = '';

        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }

        const parsed = new URL(href);
        if (!pathPattern.test(parsed.pathname)) continue;
        if (seenUrls.has(href)) continue;

        const row = rowFor(anchor);
        const anchorText = text(anchor.innerText || anchor.textContent || '');
        const rowText = text(row.innerText || row.textContent || '');
        const combined = text(anchorText + ' ' + rowText);

        if (/최신화\\s*보기/.test(combined)) continue;

        const number =
          titleNumber(anchorText, rowText) ||
          thumbnailNumber(row);

        if (!Number.isFinite(number)) continue;

        seenUrls.add(href);
        episodes.push({
          number,
          title: cleanTitle(anchorText, rowText, number),
          url: href,
        });
      }

      const pageText = text(document.body?.innerText || '');
      const totalMatch = pageText.match(/총\\s*(\\d+)\\s*회차/);
      const title = text(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.webtoon-title')?.innerText ||
        document.querySelector('.toon-title')?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '').trim();

      return {
        episodes,
        totalEpisodes: totalMatch ? Number(totalMatch[1]) : null,
        title,
      };
    })()
  `);
}

function mergeEpisodes(map, snapshot, minEpisode, maxEpisode) {
  for (const episode of snapshot.episodes || []) {
    const number = Number(episode.number);
    if (!Number.isFinite(number)) continue;
    if (number < minEpisode || number > maxEpisode) continue;

    const current = map.get(number);
    const incoming = {
      number,
      title: episode.title || `${number}화`,
      url: episode.url,
      selected: true,
    };

    if (!current) {
      map.set(number, incoming);
      continue;
    }

    // 실제 제목이 있는 항목을 우선 유지합니다.
    const currentScore = current.title === `${number}화` ? 0 : 1;
    const incomingScore = incoming.title === `${number}화` ? 0 : 1;

    if (incomingScore > currentScore) {
      map.set(number, incoming);
    }
  }
}

async function scanAllVisiblePositions(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  if (!sourceUrl) throw new Error('작품 목록 URL을 입력하세요.');

  const parsed = new URL(sourceUrl);
  const seriesMatch = parsed.pathname.match(/^\/webtoon\/(\d+)/);
  if (!seriesMatch) throw new Error('지원되는 작품 URL 형식이 아닙니다.');

  const seriesId = seriesMatch[1];
  const minEpisode = parseBound(payload.minEpisode, Number.NEGATIVE_INFINITY);
  const maxEpisode = parseBound(payload.maxEpisode, Number.POSITIVE_INFINITY);
  const window = await ensureWindow(payload.showBrowser !== false);

  event.sender.send('crawler:progress', {
    type: 'status',
    message: '페이지 전체와 내부 목록을 구간별로 확인하고 있습니다.',
  });

  await preparePage(window, sourceUrl);

  const episodeMap = new Map();
  let detectedTitle = '';
  let detectedTotal = null;

  const initial = await collectVisible(window, seriesId);
  mergeEpisodes(episodeMap, initial, minEpisode, maxEpisode);
  detectedTitle = initial.title || '';
  detectedTotal = initial.totalEpisodes || null;

  let targets = await discoverScrollTargets(window);

  // 동적 목록이 늦게 생성되면 한 번 더 탐색합니다.
  if (!targets.length) {
    await sleep(500);
    targets = await discoverScrollTargets(window);
  }

  const ratios = Array.from({ length: 41 }, (_, index) => index / 40);
  let round = 0;

  for (const target of targets) {
    for (const ratio of ratios) {
      round += 1;
      await moveTarget(window, target.id, ratio);
      await sleep(170);

      const snapshot = await collectVisible(window, seriesId);
      mergeEpisodes(episodeMap, snapshot, minEpisode, maxEpisode);
      detectedTitle = detectedTitle || snapshot.title || '';
      detectedTotal = detectedTotal || snapshot.totalEpisodes || null;

      event.sender.send('crawler:progress', {
        type: 'scan-progress',
        found: episodeMap.size,
        round,
      });
    }
  }

  // 가상 스크롤이 위아래 이동 때 다르게 렌더링되는 경우를 위해 역방향도 확인합니다.
  for (const target of [...targets].reverse()) {
    for (const ratio of [...ratios].reverse()) {
      round += 1;
      await moveTarget(window, target.id, ratio);
      await sleep(120);

      const snapshot = await collectVisible(window, seriesId);
      mergeEpisodes(episodeMap, snapshot, minEpisode, maxEpisode);

      event.sender.send('crawler:progress', {
        type: 'scan-progress',
        found: episodeMap.size,
        round,
      });
    }
  }

  // 최종적으로 현재 DOM에 남은 항목을 한 번 더 병합합니다.
  const finalSnapshot = await collectVisible(window, seriesId);
  mergeEpisodes(episodeMap, finalSnapshot, minEpisode, maxEpisode);

  const episodes = [...episodeMap.values()].sort(
    (a, b) => Number(a.number) - Number(b.number),
  );

  if (!episodes.length) {
    throw new Error(
      '입력한 페이지에서 회차 링크를 찾지 못했습니다. 작업 브라우저에서 목록이 표시되는지 확인하세요.'
    );
  }

  return {
    title: detectedTitle,
    sourceUrl,
    episodes,
    count: episodes.length,
    totalEpisodes: detectedTotal,
    mode: 'all-scroll-containers-bidirectional',
  };
}

ipcMain.removeHandler('crawler:scan');
ipcMain.handle('crawler:scan', async (event, payload) => {
  return scanAllVisiblePositions(event, payload);
});
