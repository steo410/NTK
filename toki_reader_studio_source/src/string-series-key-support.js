const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let scanWindow = null;

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function parseIdentity(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const type = parts[0];
    if (!['webtoon', 'manhwa', 'novel'].includes(type)) return null;
    const key = parts[1];
    if (!key || !/^[A-Za-z0-9._~-]+$/.test(key)) return null;
    return {
      type,
      key,
      encodedKey: encodeURIComponent(decodeURIComponent(key)),
      isNumeric: /^\d+$/.test(key),
    };
  } catch {
    return null;
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
    if (show) scanWindow.show(); else scanWindow.hide();
    return scanWindow;
  }

  scanWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show: Boolean(show),
    title: 'NTK 문자열 작품 검색',
    backgroundColor: '#111319',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  scanWindow.webContents.setBackgroundThrottling(false);
  scanWindow.on('closed', () => { scanWindow = null; });
  return scanWindow;
}

async function loadAndWait(window, sourceUrl, type) {
  try { await window.loadURL(sourceUrl); } catch {}

  for (let round = 0; round < 48; round += 1) {
    const state = await window.webContents.executeJavaScript(`
      (() => ({
        ready: document.readyState,
        comicRows: document.querySelectorAll('a.ep-row-v2-link[href]').length,
        novelRows: document.querySelectorAll('a.novel-ep-link[href]').length,
      }))()
    `).catch(() => ({ ready: 'loading', comicRows: 0, novelRows: 0 }));

    const count = type === 'novel' ? Number(state.novelRows) : Number(state.comicRows);
    if (state.ready !== 'loading' && count > 0) return;
    await sleep(250);
  }
}

async function collectVisible(window, identity) {
  return window.webContents.executeJavaScript(`
    (() => {
      const type = ${JSON.stringify(identity.type)};
      const key = ${JSON.stringify(identity.key)};
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const expectedPrefix = '/' + type + '/' + key + '/';
      const rowSelector = type === 'novel'
        ? 'a.novel-ep-link[href]'
        : 'a.ep-row-v2-link[href]';
      const rows = [...document.querySelectorAll(rowSelector)];
      const episodes = [];
      const seenUrls = new Set();
      const seenNumbers = new Set();
      let matchingUrlCount = 0;
      let invalidTitleCount = 0;

      const bodyText = clean(document.body?.innerText || '');
      const totalPatterns = type === 'novel'
        ? [/에피소드\\s*\\(\\s*(\\d+)\\s*화\\s*\\)/, /총\\s*(\\d+)\\s*회차/, /·\\s*(\\d+)\\s*화/]
        : [/총\\s*(\\d+)\\s*회차/];
      let totalEpisodes = null;
      for (const pattern of totalPatterns) {
        const match = bodyText.match(pattern);
        if (match) { totalEpisodes = Number(match[1]); break; }
      }

      for (const row of rows) {
        let href = '';
        try { href = new URL(row.getAttribute('href'), location.href).href; }
        catch { continue; }

        let pathname = '';
        try { pathname = decodeURIComponent(new URL(href).pathname); }
        catch { continue; }
        if (!pathname.startsWith(expectedPrefix)) continue;
        matchingUrlCount += 1;
        if (seenUrls.has(href)) continue;

        let number = null;
        let title = '';
        if (type === 'novel') {
          const container = row.closest('li.novel-ep-row');
          const dataNumber = Number(container?.dataset?.ep);
          const numText = clean(row.querySelector('.ne-num')?.innerText || row.querySelector('.ne-num')?.textContent || '');
          const numMatch = numText.match(/(\\d{1,7}(?:\\.\\d+)?)\\s*화/);
          number = Number.isFinite(dataNumber) && dataNumber > 0
            ? dataNumber
            : numMatch ? Number(numMatch[1]) : null;
          const subTitle = clean(row.querySelector('.ne-title')?.innerText || row.querySelector('.ne-title')?.textContent || '');
          title = subTitle && Number.isFinite(number) ? number + '화 ' + subTitle : clean(row.innerText || row.textContent || '');
        } else {
          const titleElement = row.querySelector('.ep-row-v2-title strong') ||
            row.querySelector('.ep-row-v2-title') || row.querySelector('strong');
          title = clean(titleElement?.innerText || titleElement?.textContent || '');
          const matches = [...title.matchAll(/(\\d{1,6}(?:\\.\\d+)?)\\s*화/g)];
          number = matches.length ? Number(matches[matches.length - 1][1]) : null;
        }

        if (!Number.isFinite(number) || number <= 0) {
          invalidTitleCount += 1;
          continue;
        }
        if (seenNumbers.has(number)) continue;
        seenNumbers.add(number);
        seenUrls.add(href);
        episodes.push({ number, title: title || number + '화', url: href, contentType: type });
      }

      const pageTitle = clean(
        document.querySelector('h1')?.innerText ||
        document.querySelector('.webtoon-title')?.innerText ||
        document.querySelector('.manhwa-title')?.innerText ||
        document.querySelector('.novel-title')?.innerText ||
        document.querySelector('.nd-title')?.innerText ||
        document.querySelector('.toon-title')?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title || ''
      ).replace(/\\s*\\|.*$/, '').trim();

      return {
        episodes: episodes.sort((a, b) => Number(a.number) - Number(b.number)),
        title: pageTitle,
        totalEpisodes,
        rowCount: rows.length,
        matchingUrlCount,
        parsedTitleCount: episodes.length,
        invalidTitleCount,
      };
    })()
  `);
}

async function getNovelState(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('li.novel-ep-row')];
      const numbers = rows.map((row) => Number(row.dataset.ep))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a,b) => a-b);
      const button = [...document.querySelectorAll('button')].find((item) =>
        /이전\\s*회차\\s*더\\s*보기/.test(String(item.innerText || item.textContent || '').trim())
      );
      return {
        signature: numbers.join(','),
        hasMore: Boolean(button && !button.disabled),
      };
    })()
  `).catch(() => ({ signature: '', hasMore: false }));
}

async function clickNovelMore(window) {
  return window.webContents.executeJavaScript(`
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
}

async function collectAllNovel(window, event, identity) {
  const map = new Map();
  const seenBatches = new Set();
  let title = '';
  let totalEpisodes = null;
  let last = null;

  for (let round = 0; round < 80; round += 1) {
    const snapshot = await collectVisible(window, identity);
    last = snapshot;
    if (!title && snapshot.title) title = snapshot.title;
    if (Number.isFinite(snapshot.totalEpisodes)) totalEpisodes = snapshot.totalEpisodes;
    for (const episode of snapshot.episodes) map.set(Number(episode.number), episode);

    event.sender.send('crawler:progress', {
      type: 'warning',
      message: totalEpisodes
        ? `문자열 소설 전체 회차 수집 중 · ${map.size}/${totalEpisodes}개 누적`
        : `문자열 소설 전체 회차 수집 중 · ${map.size}개 누적`,
    });

    if (totalEpisodes && map.size >= totalEpisodes) break;
    const state = await getNovelState(window);
    if (!state.hasMore) break;
    if (state.signature && seenBatches.has(state.signature)) break;
    if (state.signature) seenBatches.add(state.signature);

    const clicked = await clickNovelMore(window);
    if (!clicked) break;

    let changed = false;
    for (let wait = 0; wait < 60; wait += 1) {
      await sleep(160);
      const next = await getNovelState(window);
      if (next.signature && next.signature !== state.signature) { changed = true; break; }
    }
    if (!changed) break;
  }

  const finalSnapshot = await collectVisible(window, identity);
  for (const episode of finalSnapshot.episodes) map.set(Number(episode.number), episode);
  if (!title) title = finalSnapshot.title || last?.title || '';
  if (!totalEpisodes && Number.isFinite(finalSnapshot.totalEpisodes)) totalEpisodes = finalSnapshot.totalEpisodes;

  const episodes = [...map.values()].sort((a,b) => Number(a.number) - Number(b.number));
  return {
    episodes,
    title,
    totalEpisodes,
    rowCount: episodes.length,
    matchingUrlCount: episodes.length,
    parsedTitleCount: episodes.length,
  };
}

async function scanStringSeriesPage(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  if (!sourceUrl) throw new Error('작품 목록 URL을 입력하세요.');
  const identity = parseIdentity(sourceUrl);
  if (!identity) throw new Error('지원되는 URL 형식은 /webtoon/작품키, /manhwa/작품키, /novel/작품키 입니다.');

  const minEpisode = parseBound(payload.minEpisode, Number.NEGATIVE_INFINITY);
  const maxEpisode = parseBound(payload.maxEpisode, Number.POSITIVE_INFINITY);
  const window = await ensureWindow(payload.showBrowser !== false);

  event.sender.send('crawler:progress', {
    type: 'status',
    message: identity.type === 'novel'
      ? `문자열 작품 키(${identity.key})의 소설 전체 회차를 불러오고 있습니다.`
      : `문자열 작품 키(${identity.key})의 ${identity.type} 회차를 분석하고 있습니다.`,
  });

  await loadAndWait(window, sourceUrl, identity.type);
  const snapshot = identity.type === 'novel'
    ? await collectAllNovel(window, event, identity)
    : await collectVisible(window, identity);

  const filtered = (snapshot.episodes || [])
    .filter((episode) => Number(episode.number) >= minEpisode && Number(episode.number) <= maxEpisode)
    .map((episode) => ({ ...episode, selected: true }));

  if (!filtered.length) {
    throw new Error(
      `문자열 작품 키 회차 분석 실패: 실제 행 ${snapshot.rowCount || 0}개, ` +
      `URL 확인 ${snapshot.matchingUrlCount || 0}개, 제목 분석 ${snapshot.parsedTitleCount || 0}개`
    );
  }

  return {
    title: snapshot.title,
    sourceUrl,
    contentType: identity.type,
    seriesId: identity.key,
    seriesKey: identity.key,
    episodes: identity.type === 'novel' ? filtered : filtered.slice(0, 100),
    count: identity.type === 'novel' ? filtered.length : Math.min(filtered.length, 100),
    totalEpisodes: snapshot.totalEpisodes,
    mode: identity.type === 'novel' ? 'novel-string-key-all' : 'string-series-key-current-page',
  };
}

module.exports = {
  parseIdentity,
  scanStringSeriesPage,
};
