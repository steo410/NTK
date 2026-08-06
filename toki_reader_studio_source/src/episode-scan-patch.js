const { BrowserWindow, ipcMain } = require("electron");

let scanWindow = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
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
    title: "NTK 회차 검색",
    backgroundColor: "#111319",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  scanWindow.webContents.setBackgroundThrottling(false);

  scanWindow.on("closed", () => {
    scanWindow = null;
  });

  return scanWindow;
}

async function loadPage(window, url) {
  try {
    await window.loadURL(url);
  } catch {
    // 일부 사이트는 부가 리소스 오류 때문에 loadURL이 reject되어도
    // 실제 페이지 DOM은 정상적으로 표시됩니다.
  }

  await sleep(1100);

  for (let index = 0; index < 8; index += 1) {
    await window.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const distance = Math.max(window.innerHeight * 1.1, 900);
        root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        window.scrollBy(0, distance);
      })()
    `);

    await sleep(120);
  }
}

async function inspectCurrentPage(window, seriesId, sourceUrl) {
  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const sourceUrl = ${JSON.stringify(sourceUrl)};
      const episodePathPattern = new RegExp(
        "^/webtoon/" + seriesId + "/\\\\d+/?$"
      );

      function normalizeText(value) {
        return String(value || "")
          .replace(/\\s+/g, " ")
          .trim();
      }

      function getRow(anchor) {
        return (
          anchor.closest(
            "li, article, tr, [class*='episode'], [class*='list-item'], " +
            "[class*='webtoon-item'], [class*='item'], [class*='row']"
          ) ||
          anchor.parentElement ||
          anchor
        );
      }

      function extractEpisodeNumber(anchorText, rowText) {
        const texts = [anchorText, rowText].filter(Boolean);

        for (const text of texts) {
          const matches = [
            ...text.matchAll(/(\\d+(?:\\.\\d+)?)\\s*화/g),
          ];

          if (matches.length === 0) continue;

          // "0076 - 작품명 76화"처럼 앞쪽 관리번호가 있어도
          // 실제 제목 끝의 76화를 사용합니다.
          const value = Number(matches[matches.length - 1][1]);

          if (Number.isFinite(value)) {
            return value;
          }
        }

        return null;
      }

      function cleanTitle(anchorText, rowText, number) {
        let title = anchorText.includes(String(number) + "화")
          ? anchorText
          : rowText;

        title = normalizeText(title)
          .replace(/^\\d+\\s+(?=\\d+\\s*[-–])/, "")
          .replace(/^\\d+\\s*[-–]\\s*/, "")
          .replace(/\\s+\\d{2}\\.\\d{2}\\.\\d{2}(?:\\s.*)?$/, "")
          .trim();

        return title || String(number) + "화";
      }

      const episodes = [];
      const seenUrls = new Set();

      for (const anchor of document.querySelectorAll("a[href]")) {
        let href = "";

        try {
          href = new URL(anchor.getAttribute("href"), location.href).href;
        } catch {
          continue;
        }

        const parsed = new URL(href);

        if (!episodePathPattern.test(parsed.pathname)) continue;
        if (seenUrls.has(href)) continue;

        const row = getRow(anchor);
        const anchorText = normalizeText(
          anchor.innerText || anchor.textContent || ""
        );
        const rowText = normalizeText(
          row.innerText || row.textContent || ""
        );
        const combinedText = normalizeText(anchorText + " " + rowText);

        // 작품 상단의 "최신화 보기" 버튼은 실제 회차 행이 아닙니다.
        if (/최신화\\s*보기/.test(combinedText)) continue;

        const number = extractEpisodeNumber(anchorText, rowText);

        if (!Number.isFinite(number)) continue;

        seenUrls.add(href);
        episodes.push({
          number,
          title: cleanTitle(anchorText, rowText, number),
          url: href,
        });
      }

      const pageLinks = [];
      const seenPages = new Set();
      const source = new URL(sourceUrl);
      const normalizedSourcePath = source.pathname.replace(/\\/$/, "");

      for (const anchor of document.querySelectorAll("a[href]")) {
        let href = "";

        try {
          href = new URL(anchor.getAttribute("href"), location.href).href;
        } catch {
          continue;
        }

        const parsed = new URL(href);
        const normalizedPath = parsed.pathname.replace(/\\/$/, "");

        if (parsed.origin !== source.origin) continue;
        if (normalizedPath !== normalizedSourcePath) continue;
        if (href === location.href || seenPages.has(href)) continue;

        const text = normalizeText(
          anchor.innerText || anchor.textContent || ""
        );
        const context = anchor.closest(
          "nav, [class*='pagination'], [class*='paging'], [class*='pager']"
        );
        const hasPageQuery = [
          ...parsed.searchParams.keys(),
        ].some((key) => /page|paging|pager|pageno|page_no/i.test(key));
        const looksLikePageControl =
          Boolean(context) ||
          hasPageQuery ||
          /^(?:\\d+|다음|이전|next|prev|[›»‹«])$/i.test(text);

        if (!looksLikePageControl) continue;

        seenPages.add(href);
        pageLinks.push(href);
      }

      const title = normalizeText(
        document.querySelector("h1")?.innerText ||
        document.querySelector(".webtoon-title")?.innerText ||
        document.querySelector(".toon-title")?.innerText ||
        document.querySelector("meta[property='og:title']")?.content ||
        document.title ||
        ""
      )
        .replace(/\\s*\\|.*$/, "")
        .trim();

      return {
        episodes,
        pageLinks,
        title,
      };
    })()
  `);
}

async function scanEpisodes(event, payload = {}) {
  const sourceUrl = normalizeUrl(payload.sourceUrl);

  if (!sourceUrl) {
    throw new Error("작품 목록 URL을 입력하세요.");
  }

  const source = new URL(sourceUrl);
  const seriesMatch = source.pathname.match(/^\/webtoon\/(\d+)/);

  if (!seriesMatch) {
    throw new Error("지원되는 작품 URL 형식이 아닙니다.");
  }

  const seriesId = seriesMatch[1];
  const minEpisode = parseBound(
    payload.minEpisode,
    Number.NEGATIVE_INFINITY,
  );
  const maxEpisode = parseBound(
    payload.maxEpisode,
    Number.POSITIVE_INFINITY,
  );
  const window = await ensureScanWindow(payload.showBrowser !== false);

  const queue = [sourceUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const episodeMap = new Map();
  let detectedTitle = "";

  event.sender.send("crawler:progress", {
    type: "status",
    message: "페이지의 실제 회차 제목을 기준으로 목록을 찾고 있습니다.",
  });

  while (queue.length > 0 && visited.size < 50) {
    const pageUrl = queue.shift();

    if (!pageUrl || visited.has(pageUrl)) continue;

    visited.add(pageUrl);
    await loadPage(window, pageUrl);

    const result = await inspectCurrentPage(
      window,
      seriesId,
      sourceUrl,
    );

    detectedTitle = detectedTitle || result.title || "";

    for (const episode of result.episodes || []) {
      const number = Number(episode.number);

      if (!Number.isFinite(number)) continue;
      if (number < minEpisode || number > maxEpisode) continue;

      // 같은 화가 중복 등록된 경우 목록에서 먼저 발견된 항목만 사용합니다.
      if (!episodeMap.has(number)) {
        episodeMap.set(number, {
          ...episode,
          number,
          selected: true,
        });
      }
    }

    for (const candidate of result.pageLinks || []) {
      const normalized = normalizeUrl(candidate);

      if (
        normalized &&
        !visited.has(normalized) &&
        !queued.has(normalized)
      ) {
        queued.add(normalized);
        queue.push(normalized);
      }
    }

    event.sender.send("crawler:progress", {
      type: "scan-progress",
      found: episodeMap.size,
      round: visited.size,
    });
  }

  const episodes = [...episodeMap.values()].sort(
    (a, b) => Number(a.number) - Number(b.number),
  );

  if (episodes.length === 0) {
    throw new Error(
      "실제 회차 제목을 찾지 못했습니다. 작품 목록 페이지인지 확인하세요.",
    );
  }

  return {
    title: detectedTitle,
    sourceUrl,
    episodes,
    count: episodes.length,
    mode: "scanned-title-number",
  };
}

const originalHandle = ipcMain.handle.bind(ipcMain);

ipcMain.handle = function patchedHandle(channel, listener) {
  if (channel === "crawler:scan") {
    return originalHandle(channel, async (event, payload) => {
      return scanEpisodes(event, payload);
    });
  }

  return originalHandle(channel, listener);
};
