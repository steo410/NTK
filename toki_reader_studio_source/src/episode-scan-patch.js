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

async function scrollCurrentPage(window) {
  for (let index = 0; index < 16; index += 1) {
    await window.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const distance = Math.max(window.innerHeight * 0.9, 750);
        root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        window.scrollBy(0, distance);
      })()
    `);

    await sleep(90);
  }
}

async function loadPage(window, url) {
  try {
    await window.loadURL(url);
  } catch {
    // 부가 리소스가 실패해도 실제 DOM이 표시되는 경우가 있습니다.
  }

  await sleep(900);
  await scrollCurrentPage(window);
  await sleep(250);
}

async function inspectCurrentPage(window, seriesId) {
  return window.webContents.executeJavaScript(`
    (() => {
      const seriesId = ${JSON.stringify(seriesId)};
      const episodePathPattern = new RegExp(
        "^/webtoon/" + seriesId + "/\\\\d+/?$"
      );

      function normalizeText(value) {
        return String(value || "")
          .replace(/\\s+/g, " ")
          .trim();
      }

      const bodyText = normalizeText(
        document.body?.innerText || document.body?.textContent || ""
      );
      const totalMatch = bodyText.match(/총\\s*(\\d+)\\s*회차/);
      const totalEpisodes = totalMatch ? Number(totalMatch[1]) : null;

      function normalizeEpisodeDigits(rawDigits) {
        const digits = String(rawDigits || "").replace(/\\D/g, "");
        if (!digits) return null;

        const direct = Number(digits);

        if (
          Number.isFinite(direct) &&
          direct > 0 &&
          (!Number.isFinite(totalEpisodes) || direct <= totalEpisodes)
        ) {
          return direct;
        }

        if (!Number.isFinite(totalEpisodes)) return null;

        // 썸네일 번호와 제목 번호가 붙어 706693화처럼 보이면
        // 전체 회차 이내인 가장 긴 뒤쪽 숫자(693)를 사용합니다.
        for (
          let length = Math.min(5, digits.length - 1);
          length >= 1;
          length -= 1
        ) {
          const suffix = Number(digits.slice(-length));

          if (
            Number.isFinite(suffix) &&
            suffix > 0 &&
            suffix <= totalEpisodes
          ) {
            return suffix;
          }
        }

        return null;
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

      function collectTextCandidates(anchor, row) {
        const nodes = [
          ...anchor.querySelectorAll(
            "h1, h2, h3, h4, h5, h6, strong, b, p, span, div"
          ),
          anchor,
          ...row.querySelectorAll(
            "h1, h2, h3, h4, h5, h6, strong, b, p, span, div"
          ),
          row,
        ];
        const output = [];
        const seen = new Set();

        for (const node of nodes) {
          if (!node) continue;
          if (node.closest("time, [class*='date'], [class*='comment']")) {
            continue;
          }

          const text = normalizeText(
            node.innerText || node.textContent || ""
          );

          if (!text || seen.has(text) || !text.includes("화")) continue;
          if (/최신화\\s*보기/.test(text)) continue;
          if (text.length > 260) continue;

          seen.add(text);
          output.push({
            text,
            isAnchor: node === anchor,
            isRow: node === row,
          });
        }

        return output;
      }

      function findEpisode(anchor, row) {
        const candidates = collectTextCandidates(anchor, row);
        let best = null;

        for (const candidate of candidates) {
          const matches = [
            ...candidate.text.matchAll(/(\\d+(?:\\.\\d+)?)\\s*화/g),
          ];

          for (const match of matches) {
            const number = normalizeEpisodeDigits(match[1]);
            if (!Number.isFinite(number)) continue;

            const rawNumber = Number(match[1]);
            let score = 0;

            if (Number.isFinite(rawNumber) && rawNumber === number) {
              score += 80;
            } else {
              score += 35;
            }

            if (!candidate.isRow) score += 25;
            if (!candidate.isAnchor) score += 10;
            if (candidate.text.length >= 8 && candidate.text.length <= 150) {
              score += 20;
            }
            if (match.index > candidate.text.length * 0.35) score += 10;

            const result = {
              number,
              text: candidate.text,
              score,
            };

            if (!best || result.score > best.score) {
              best = result;
            }
          }
        }

        return best;
      }

      function cleanTitle(value, number) {
        let title = normalizeText(value)
          .replace(/^\\d+\\s+(?=\\d+\\s*[-–])/, "")
          .replace(/^0*\\d+\\s*[-–]\\s*/, "")
          .replace(/\\d{2}\\.\\d{2}\\.\\d{2}.*$/, "")
          .trim();

        if (!title.includes(String(number) + "화")) {
          title = String(number) + "화";
        }

        return title;
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
        const combinedText = normalizeText(
          (anchor.innerText || anchor.textContent || "") + " " +
          (row.innerText || row.textContent || "")
        );

        if (/최신화\\s*보기/.test(combinedText)) continue;

        const episode = findEpisode(anchor, row);
        if (!episode) continue;

        seenUrls.add(href);
        episodes.push({
          number: episode.number,
          title: cleanTitle(episode.text, episode.number),
          url: href,
          score: episode.score,
        });
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
        title,
        totalEpisodes,
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

  event.sender.send("crawler:progress", {
    type: "status",
    message: "입력한 페이지의 회차 목록을 찾고 있습니다.",
  });

  // epage=9처럼 사용자가 입력한 정확한 페이지만 검사합니다.
  // 다른 페이지로 자동 이동하지 않습니다.
  await loadPage(window, sourceUrl);
  const result = await inspectCurrentPage(window, seriesId);
  const episodeMap = new Map();

  for (const episode of result.episodes || []) {
    const number = Number(episode.number);

    if (!Number.isFinite(number)) continue;
    if (number < minEpisode || number > maxEpisode) continue;

    const previous = episodeMap.get(number);

    if (!previous || Number(episode.score || 0) > Number(previous.score || 0)) {
      episodeMap.set(number, {
        number,
        title: episode.title,
        url: episode.url,
        selected: true,
      });
    }
  }

  const episodes = [...episodeMap.values()].sort(
    (a, b) => Number(a.number) - Number(b.number),
  );

  event.sender.send("crawler:progress", {
    type: "scan-progress",
    found: episodes.length,
    round: 1,
  });

  if (episodes.length === 0) {
    throw new Error(
      "입력한 페이지에서 실제 회차 제목을 찾지 못했습니다.",
    );
  }

  return {
    title: result.title,
    sourceUrl,
    episodes,
    count: episodes.length,
    totalEpisodes: result.totalEpisodes,
    mode: "single-page-visible-title",
  };
}

async function installLegacyViewerBridge(contents) {
  for (let round = 0; round < 12; round += 1) {
    try {
      const result = await contents.executeJavaScript(`
        (() => {
          const lazyAttributes = [
            "data-src",
            "data-original",
            "data-lazy",
            "data-url",
            "data-img"
          ];
          const rootSelectors = [
            ".vw-imgs",
            ".view-padding",
            ".view-content",
            "#toon_img",
            "#novel_content",
            ".viewer",
            ".webtoon-viewer",
            ".episode-viewer",
            ".view-wrap",
            "[class*='viewer']",
            "[class*='view-content']",
            "article",
            "main"
          ];
          const excludedParts = [
            "logo", "icon", "favicon", "avatar", "profile",
            "banner", "advert", "/ads/", "emoji", "loading",
            "spinner", "blank.", "transparent."
          ];

          function isExcluded(image) {
            if (image.closest("header, nav, footer, button")) return true;

            const source = String(
              image.currentSrc || image.src ||
              image.getAttribute("data-src") || ""
            ).toLowerCase();

            return excludedParts.some((part) => source.includes(part));
          }

          function forceLoad(image) {
            image.loading = "eager";

            if (!image.src || image.naturalWidth === 0) {
              for (const attribute of lazyAttributes) {
                const value = image.getAttribute(attribute);

                if (value) {
                  image.src = value;
                  break;
                }
              }
            }
          }

          function getCandidateImages(root) {
            return [...root.querySelectorAll("img")].filter((image) => {
              forceLoad(image);
              if (isExcluded(image)) return false;

              const rect = image.getBoundingClientRect();
              const alt = String(image.alt || "").toLowerCase();
              const knownPage =
                /page\\s*\\d+/.test(alt) ||
                image.classList.contains("viewer-ratio-img");
              const largeEnough =
                Math.max(rect.width, image.naturalWidth || 0) >= 260 &&
                Math.max(rect.height, image.naturalHeight || 0) >= 180;

              return knownPage || largeEnough;
            });
          }

          const roots = rootSelectors
            .flatMap((selector) => [...document.querySelectorAll(selector)])
            .filter(Boolean);

          if (document.body) roots.push(document.body);

          let bestImages = [];
          let bestScore = 0;

          for (const root of roots) {
            const images = getCandidateImages(root);
            const score = images.reduce((sum, image) => {
              const rect = image.getBoundingClientRect();
              return sum + Math.max(rect.height, image.naturalHeight || 0, 1);
            }, 0);

            if (
              images.length > bestImages.length ||
              (images.length === bestImages.length && score > bestScore)
            ) {
              bestImages = images;
              bestScore = score;
            }
          }

          for (const image of bestImages) {
            image.classList.add("viewer-ratio-img");
            image.setAttribute("data-ntk-viewer-page", "true");
          }

          const root = document.scrollingElement || document.documentElement;
          const distance = Math.max(window.innerHeight * 0.85, 700);

          if (root) {
            root.scrollTop = Math.min(
              root.scrollTop + distance,
              root.scrollHeight
            );
          }
          window.scrollBy(0, distance);

          return bestImages.length;
        })()
      `);

      if (Number(result) > 0 && round >= 3) {
        return Number(result);
      }
    } catch {
      return 0;
    }

    await sleep(140);
  }

  return 0;
}

// 구형 회차 페이지는 .vw-imgs가 아닌 다른 뷰어 구조를 사용합니다.
// 모든 BrowserWindow의 회차 페이지 로딩 후 실제 큰 본문 이미지에
// viewer-ratio-img 클래스를 붙여 기존 다운로드 로직이 그대로 찾게 합니다.
const originalLoadURL = BrowserWindow.prototype.loadURL;

BrowserWindow.prototype.loadURL = async function patchedLoadURL(url, options) {
  const result = await originalLoadURL.call(this, url, options);

  try {
    const parsed = new URL(url);

    if (/^\/webtoon\/\d+\/[^/]+\/?$/.test(parsed.pathname)) {
      await sleep(500);
      await installLegacyViewerBridge(this.webContents);
    }
  } catch {
    // 로컬 앱 페이지 등은 그대로 둡니다.
  }

  return result;
};

const originalHandle = ipcMain.handle.bind(ipcMain);

ipcMain.handle = function patchedHandle(channel, listener) {
  if (channel === "crawler:scan") {
    return originalHandle(channel, async (event, payload) => {
      return scanEpisodes(event, payload);
    });
  }

  return originalHandle(channel, listener);
};
