const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pathToFileURL } = require("url");

let mainWindow = null;
let workerWindow = null;
let cancelRequested = false;
let activeSeriesSlug = null;

const VIEWER_SELECTOR = [
  ".vw-imgs img.viewer-ratio-img",
  ".vw-imgs img",
  "img.viewer-ratio-img",
  'img[alt^="page "]',
].join(", ");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileName(value, fallback = "untitled") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return (normalized || fallback).slice(0, 90);
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);

  return slug || `series-${Date.now()}`;
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readSettings() {
  const defaults = {
    libraryRoot: path.join(app.getPath("userData"), "library"),
  };

  try {
    const raw = await fsp.readFile(getSettingsPath(), "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

async function writeSettings(settings) {
  await fsp.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fsp.writeFile(
    getSettingsPath(),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

async function getLibraryRoot() {
  const settings = await readSettings();
  await fsp.mkdir(settings.libraryRoot, { recursive: true });
  return settings.libraryRoot;
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("crawler:progress", payload);
  }
}

async function createWorkerWindow(show = true) {
  if (workerWindow && !workerWindow.isDestroyed()) {
    if (show) workerWindow.show();
    return workerWindow;
  }

  workerWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    show,
    title: "Toki Reader Studio 작업 브라우저",
    backgroundColor: "#111319",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  workerWindow.webContents.setBackgroundThrottling(false);

  workerWindow.on("closed", () => {
    workerWindow = null;
  });

  return workerWindow;
}

async function loadRemotePage(url, showBrowser = true) {
  const worker = await createWorkerWindow(showBrowser);

  if (showBrowser) worker.show();

  try {
    await worker.loadURL(url);
  } catch (error) {
    sendProgress({
      type: "warning",
      message: `페이지 로딩 경고: ${error.message}`,
    });
  }

  await sleep(1800);
  return worker;
}

function extractSeriesId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/webtoon\/(\d+)/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function parseEpisodeNumber(text) {
  const value = String(text || "");

  const titleMatch = value.match(/(?<!\d)(\d{1,5})(?:\.\d+)?\s*화/);
  if (titleMatch) return Number(titleMatch[1]);

  const leading = value.match(/^\s*(\d{1,5})\s*[,|\t]/);
  if (leading) return Number(leading[1]);

  return null;
}

function parseDirectLines(rawText, minEpisode, maxEpisode) {
  const episodes = [];
  const seen = new Set();

  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^회차\s*,/i.test(line)) continue;

    const urlMatch = line.match(/https?:\/\/[^\s,"']+/i);
    if (!urlMatch) continue;

    const url = urlMatch[0].replace(/[),.;]+$/g, "");
    const number = parseEpisodeNumber(line);

    if (number === null) continue;
    if (Number.isFinite(minEpisode) && number < minEpisode) continue;
    if (Number.isFinite(maxEpisode) && number > maxEpisode) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    episodes.push({
      number,
      title: `${number}화`,
      url,
      selected: true,
    });
  }

  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

async function scanWorkPage({
  sourceUrl,
  pastedUrls,
  minEpisode,
  maxEpisode,
  showBrowser,
}) {
  const minValue = Number.isFinite(Number(minEpisode))
    ? Number(minEpisode)
    : Number.NEGATIVE_INFINITY;
  const maxValue = Number.isFinite(Number(maxEpisode))
    ? Number(maxEpisode)
    : Number.POSITIVE_INFINITY;

  if (String(pastedUrls || "").trim()) {
    const directEpisodes = parseDirectLines(
      pastedUrls,
      minValue,
      maxValue,
    );

    if (directEpisodes.length > 0) {
      return {
        title: "",
        sourceUrl: sourceUrl || "",
        episodes: directEpisodes,
        count: directEpisodes.length,
        mode: "pasted",
      };
    }
  }

  if (!sourceUrl) {
    throw new Error("작품 목록 URL을 입력하세요.");
  }

  const seriesId = extractSeriesId(sourceUrl);

  if (!seriesId) {
    throw new Error("지원되는 작품 URL 형식이 아닙니다.");
  }

  const worker = await loadRemotePage(sourceUrl, showBrowser);
  const episodeMap = new Map();
  let unchangedRounds = 0;
  let previousCount = -1;

  sendProgress({
    type: "status",
    message: "작품 페이지에서 회차 링크를 찾고 있습니다.",
  });

  for (let round = 0; round < 180 && unchangedRounds < 12; round += 1) {
    const found = await worker.webContents.executeJavaScript(`
      (() => {
        const seriesId = ${JSON.stringify(seriesId)};
        const output = [];
        const pathPattern = new RegExp(
          "^/webtoon/" + seriesId + "/(\\\\d+)/?$"
        );

        function normalizeText(value) {
          return String(value || "")
            .replace(/\\s+/g, " ")
            .trim();
        }

        function selectEpisodeTitle(anchor, number) {
          const episodePattern = new RegExp(
            "(?<!\\\\d)" + number + "(?:\\\\.\\\\d+)?\\\\s*화"
          );
          const candidates = [
            anchor.closest("li, article, tr, [class*='item'], [class*='episode']"),
            anchor.parentElement,
            anchor,
          ].filter(Boolean);

          for (const candidate of candidates) {
            const text = normalizeText(
              candidate.innerText || candidate.textContent || ""
            );
            const match = text.match(episodePattern);

            if (match) {
              const index = text.indexOf(match[0]);
              const start = Math.max(0, index - 60);
              const end = Math.min(text.length, index + match[0].length + 60);
              return text.slice(start, end).trim();
            }
          }

          return number + "화";
        }

        for (const anchor of document.querySelectorAll("a[href]")) {
          let href = "";

          try {
            href = new URL(anchor.getAttribute("href"), location.href).href;
          } catch {
            continue;
          }

          const parsed = new URL(href);
          const pathMatch = parsed.pathname.match(pathPattern);

          if (!pathMatch) continue;

          const number = Number(pathMatch[1]);

          if (!Number.isFinite(number)) continue;

          output.push({
            number,
            title: selectEpisodeTitle(anchor, number),
            url: href,
          });
        }

        return output;
      })()
    `);

    for (const item of found) {
      if (item.number < minValue || item.number > maxValue) continue;

      const previous = episodeMap.get(item.number);
      const next = {
        ...item,
        selected: true,
      };

      if (!previous || next.title.length < previous.title.length) {
        episodeMap.set(item.number, next);
      }
    }

    if (episodeMap.size === previousCount) {
      unchangedRounds += 1;
    } else {
      previousCount = episodeMap.size;
      unchangedRounds = 0;
    }

    sendProgress({
      type: "scan-progress",
      found: episodeMap.size,
      round: round + 1,
    });

    await worker.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const distance = Math.max(window.innerHeight * 1.25, 1100);
        root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        window.scrollBy(0, distance);
      })()
    `);

    await sleep(320);
  }

  const pageInfo = await worker.webContents.executeJavaScript(`
    (() => {
      function clean(value) {
        return String(value || "")
          .replace(/\\s+/g, " ")
          .replace(/\\s*[-|]\\s*(뉴토끼|NEWTO|NTK).*$/i, "")
          .replace(/\\s*\\|.*$/, "")
          .trim();
      }

      const selectors = [
        "h1",
        "[data-title]",
        ".view-title",
        ".webtoon-title",
        ".toon-title",
        "meta[property='og:title']",
      ];

      let title = "";

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;

        const candidate = clean(
          element.getAttribute?.("content") ||
          element.getAttribute?.("data-title") ||
          element.innerText ||
          element.textContent ||
          ""
        );

        if (
          candidate &&
          !/^전체 회차/.test(candidate) &&
          !/^최신화 보기/.test(candidate) &&
          candidate.length < 120
        ) {
          title = candidate;
          break;
        }
      }

      if (!title) {
        title = clean(document.title);
      }

      return {
        title,
        url: location.href,
      };
    })()
  `);

  const episodes = [...episodeMap.values()]
    .sort((a, b) => a.number - b.number);

  if (episodes.length === 0) {
    throw new Error(
      "선택한 범위에서 회차 링크를 찾지 못했습니다. 작품 목록 페이지인지 확인하세요.",
    );
  }

  return {
    title: pageInfo.title,
    sourceUrl: sourceUrl,
    episodes,
    count: episodes.length,
    mode: "scanned",
  };
}

async function attachDebugger(contents) {
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
  }

  await contents.debugger.sendCommand("Page.enable");
}

async function getViewerCount(contents) {
  return contents.executeJavaScript(`
    (() => {
      const selector = ${JSON.stringify(VIEWER_SELECTOR)};
      const unique = [...new Set(document.querySelectorAll(selector))];
      return unique.length;
    })()
  `);
}

async function prepareViewerImage(contents, index) {
  return contents.executeJavaScript(`
    (async () => {
      const selector = ${JSON.stringify(VIEWER_SELECTOR)};
      const images = [...new Set(document.querySelectorAll(selector))];
      const image = images[${index}];

      if (!image) {
        throw new Error("이미지 요소를 찾지 못했습니다.");
      }

      image.loading = "eager";

      if (!image.src || image.naturalWidth === 0) {
        for (const attr of [
          "data-src",
          "data-original",
          "data-lazy",
          "data-url",
          "data-img"
        ]) {
          const value = image.getAttribute(attr);
          if (value) {
            image.src = value;
            break;
          }
        }
      }

      image.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant"
      });

      if (!image.complete || image.naturalWidth === 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 15000);
          image.addEventListener("load", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          image.addEventListener("error", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 80));

      const rect = image.getBoundingClientRect();

      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
        naturalWidth: image.naturalWidth || 0,
        naturalHeight: image.naturalHeight || 0,
        alt: image.alt || "",
        src: image.currentSrc || image.src || "",
      };
    })()
  `);
}

async function captureElement(contents, rect, outputPath) {
  await attachDebugger(contents);

  const capture = await contents.debugger.sendCommand(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, Number(rect.x)),
        y: Math.max(0, Number(rect.y)),
        width: Math.max(1, Number(rect.width)),
        height: Math.max(1, Number(rect.height)),
        scale: 1,
      },
    },
  );

  const buffer = Buffer.from(capture.data, "base64");

  if (buffer.length < 2000) {
    throw new Error(`캡처 파일이 너무 작습니다: ${buffer.length} bytes`);
  }

  await fsp.writeFile(outputPath, buffer);
  return buffer.length;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(
    filePath,
    JSON.stringify(value, null, 2),
    "utf-8",
  );
}

function chooseEpisodeMeta(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  const currentCompleted = current.completed === true;
  const incomingCompleted = incoming.completed === true;

  if (incomingCompleted !== currentCompleted) {
    return incomingCompleted ? incoming : current;
  }

  return Number(incoming.pageCount || 0) >= Number(current.pageCount || 0)
    ? incoming
    : current;
}

async function mergeEpisodeFolder(sourceDir, targetDir) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return;

  await fsp.mkdir(targetDir, { recursive: true });

  for (const entry of await fsp.readdir(sourceDir, {
    withFileTypes: true,
  })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mergeEpisodeFolder(sourcePath, targetPath);
      continue;
    }

    let shouldCopy = true;

    try {
      const [sourceStat, targetStat] = await Promise.all([
        fsp.stat(sourcePath),
        fsp.stat(targetPath),
      ]);
      shouldCopy = sourceStat.size > targetStat.size;
    } catch {
      shouldCopy = true;
    }

    if (shouldCopy) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

async function normalizeSeriesStorage(
  libraryRoot,
  sourceId,
  preferredTitle = "",
  preferredSourceUrl = "",
) {
  if (!sourceId) {
    return {
      slug: slugify(preferredTitle || "웹툰"),
      title: safeFileName(preferredTitle || "웹툰"),
    };
  }

  const canonicalSlug = `webtoon-${sourceId}`;
  const canonicalDir = path.join(libraryRoot, canonicalSlug);
  const canonicalEpisodesDir = path.join(canonicalDir, "episodes");
  const canonicalMetaPath = path.join(canonicalDir, "series.json");

  await fsp.mkdir(canonicalEpisodesDir, { recursive: true });

  const directoryEntries = await fsp.readdir(libraryRoot, {
    withFileTypes: true,
  });
  const matchingSeries = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) continue;

    const seriesDir = path.join(libraryRoot, entry.name);
    const meta = await readJson(path.join(seriesDir, "series.json"));

    if (!meta) continue;

    const metaSourceId = extractSeriesId(meta.sourceUrl || "");

    if (
      metaSourceId === sourceId ||
      entry.name === canonicalSlug ||
      entry.name.endsWith(`-${sourceId}`)
    ) {
      matchingSeries.push({
        name: entry.name,
        dir: seriesDir,
        meta,
      });
    }
  }

  const episodeMap = new Map();
  let createdAt = new Date().toISOString();
  let fallbackTitle = "";

  for (const series of matchingSeries) {
    fallbackTitle =
      fallbackTitle ||
      safeFileName(series.meta.title || "");

    if (series.meta.createdAt && series.meta.createdAt < createdAt) {
      createdAt = series.meta.createdAt;
    }

    for (const episode of series.meta.episodes || []) {
      const number = Number(episode.number);
      if (!Number.isFinite(number)) continue;

      episodeMap.set(
        number,
        chooseEpisodeMeta(episodeMap.get(number), episode),
      );
    }

    const oldEpisodesDir = path.join(series.dir, "episodes");

    if (fs.existsSync(oldEpisodesDir)) {
      const episodeEntries = await fsp.readdir(oldEpisodesDir, {
        withFileTypes: true,
      });

      for (const episodeEntry of episodeEntries) {
        if (!episodeEntry.isDirectory()) continue;

        await mergeEpisodeFolder(
          path.join(oldEpisodesDir, episodeEntry.name),
          path.join(canonicalEpisodesDir, episodeEntry.name),
        );
      }
    }
  }

  const canonicalTitle = safeFileName(
    preferredTitle || fallbackTitle || "웹툰",
  );
  const canonicalMeta = {
    title: canonicalTitle,
    slug: canonicalSlug,
    sourceUrl:
      preferredSourceUrl ||
      matchingSeries.find((series) => series.meta.sourceUrl)?.meta
        .sourceUrl ||
      "",
    createdAt,
    updatedAt: new Date().toISOString(),
    episodes: [...episodeMap.values()].sort(
      (a, b) => Number(a.number) - Number(b.number),
    ),
  };

  await writeJson(canonicalMetaPath, canonicalMeta);

  for (const series of matchingSeries) {
    if (series.name !== canonicalSlug) {
      await fsp.rm(series.dir, { recursive: true, force: true });
    }
  }

  return {
    slug: canonicalSlug,
    title: canonicalTitle,
  };
}

async function normalizeAllSeriesStorage(libraryRoot) {
  const entries = await fsp.readdir(libraryRoot, {
    withFileTypes: true,
  });
  const sourceGroups = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const meta = await readJson(
      path.join(libraryRoot, entry.name, "series.json"),
    );

    if (!meta) continue;

    const sourceId = extractSeriesId(meta.sourceUrl || "");
    if (!sourceId) continue;

    if (!sourceGroups.has(sourceId)) {
      sourceGroups.set(sourceId, []);
    }

    sourceGroups.get(sourceId).push(meta);
  }

  for (const [sourceId, metas] of sourceGroups) {
    const preferred = metas
      .map((meta) => safeFileName(meta.title || ""))
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0] || "웹툰";

    await normalizeSeriesStorage(
      libraryRoot,
      sourceId,
      preferred,
      metas.find((meta) => meta.sourceUrl)?.sourceUrl || "",
    );
  }
}

async function downloadEpisodes({
  title,
  sourceUrl,
  episodes,
  showBrowser,
  force,
}) {
  cancelRequested = false;

  const selected = (episodes || [])
    .filter((episode) => episode.selected !== false)
    .sort((a, b) => Number(a.number) - Number(b.number));

  if (selected.length === 0) {
    throw new Error("다운로드할 회차를 한 개 이상 선택하세요.");
  }

  const requestedTitle = safeFileName(title || "웹툰");
  const sourceId = extractSeriesId(sourceUrl || selected[0]?.url || "");
  const libraryRoot = await getLibraryRoot();
  const normalizedSeries = await normalizeSeriesStorage(
    libraryRoot,
    sourceId,
    requestedTitle,
    sourceUrl || selected[0]?.url || "",
  );
  const seriesTitle = normalizedSeries.title;
  const seriesSlug = normalizedSeries.slug;

  activeSeriesSlug = seriesSlug;

  const seriesDir = path.join(libraryRoot, seriesSlug);
  const episodesDir = path.join(seriesDir, "episodes");
  const seriesMetaPath = path.join(seriesDir, "series.json");

  await fsp.mkdir(episodesDir, { recursive: true });

  let seriesMeta = await readJson(seriesMetaPath, {
    title: seriesTitle,
    slug: seriesSlug,
    sourceUrl: sourceUrl || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    episodes: [],
  });

  seriesMeta.title = seriesTitle;
  seriesMeta.sourceUrl = sourceUrl || seriesMeta.sourceUrl || "";
  seriesMeta.updatedAt = new Date().toISOString();

  const worker = await createWorkerWindow(showBrowser);
  if (showBrowser) worker.show();

  let completedEpisodes = 0;

  for (let episodeIndex = 0; episodeIndex < selected.length; episodeIndex += 1) {
    if (cancelRequested) break;

    const episode = selected[episodeIndex];
    const number = Number(episode.number);
    const padded = String(number).padStart(4, "0");
    const episodeDir = path.join(episodesDir, padded);
    const manifestPath = path.join(episodeDir, "manifest.json");

    await fsp.mkdir(episodeDir, { recursive: true });

    const existingManifest = await readJson(manifestPath);

    if (existingManifest?.completed && !force) {
      completedEpisodes += 1;

      sendProgress({
        type: "episode-skipped",
        episode: number,
        index: episodeIndex + 1,
        total: selected.length,
        pageCount: existingManifest.pageCount || 0,
      });

      continue;
    }

    sendProgress({
      type: "episode-start",
      episode: number,
      title: episode.title,
      index: episodeIndex + 1,
      total: selected.length,
    });

    await loadRemotePage(episode.url, showBrowser);

    let pageCount = 0;

    for (let retry = 0; retry < 3; retry += 1) {
      pageCount = await getViewerCount(worker.webContents);
      if (pageCount > 0) break;
      await sleep(900);
    }

    if (pageCount === 0) {
      const failedManifest = {
        episode: number,
        title: episode.title,
        url: episode.url,
        completed: false,
        error: "본문 이미지 선택자 0개",
        updatedAt: new Date().toISOString(),
      };

      await writeJson(manifestPath, failedManifest);

      sendProgress({
        type: "episode-error",
        episode: number,
        message: "본문 이미지 요소를 찾지 못했습니다.",
      });

      continue;
    }

    const manifest = {
      episode: number,
      title: episode.title,
      url: episode.url,
      selector: VIEWER_SELECTOR,
      pageCount,
      completed: false,
      pages: [],
      updatedAt: new Date().toISOString(),
    };

    let pageSuccess = 0;

    for (let imageIndex = 0; imageIndex < pageCount; imageIndex += 1) {
      if (cancelRequested) break;

      const pageNumber = imageIndex + 1;
      const outputPath = path.join(
        episodeDir,
        `${String(pageNumber).padStart(4, "0")}.png`,
      );

      if (fs.existsSync(outputPath) && !force) {
        const stat = await fsp.stat(outputPath);

        manifest.pages.push({
          index: pageNumber,
          file: path.basename(outputPath),
          bytes: stat.size,
          existing: true,
        });

        pageSuccess += 1;
      } else {
        try {
          const rect = await prepareViewerImage(
            worker.webContents,
            imageIndex,
          );

          const bytes = await captureElement(
            worker.webContents,
            rect,
            outputPath,
          );

          manifest.pages.push({
            index: pageNumber,
            file: path.basename(outputPath),
            bytes,
            naturalWidth: rect.naturalWidth,
            naturalHeight: rect.naturalHeight,
            src: rect.src,
          });

          pageSuccess += 1;
        } catch (error) {
          manifest.pages.push({
            index: pageNumber,
            error: error.message,
          });
        }
      }

      sendProgress({
        type: "page-progress",
        episode: number,
        page: pageNumber,
        pageTotal: pageCount,
        episodeIndex: episodeIndex + 1,
        episodeTotal: selected.length,
      });

      await sleep(60 + Math.floor(Math.random() * 70));
    }

    manifest.completed =
      !cancelRequested && pageSuccess === pageCount;
    manifest.successCount = pageSuccess;
    manifest.updatedAt = new Date().toISOString();

    await writeJson(manifestPath, manifest);

    const metaEpisode = {
      number,
      title: episode.title || `${number}화`,
      url: episode.url,
      pageCount,
      completed: manifest.completed,
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = seriesMeta.episodes.findIndex(
      (item) => Number(item.number) === number,
    );

    if (existingIndex >= 0) {
      seriesMeta.episodes[existingIndex] = metaEpisode;
    } else {
      seriesMeta.episodes.push(metaEpisode);
    }

    seriesMeta.episodes.sort(
      (a, b) => Number(a.number) - Number(b.number),
    );

    await writeJson(seriesMetaPath, seriesMeta);

    if (manifest.completed) {
      completedEpisodes += 1;

      sendProgress({
        type: "episode-complete",
        episode: number,
        pageCount,
        index: episodeIndex + 1,
        total: selected.length,
      });
    } else {
      sendProgress({
        type: "episode-error",
        episode: number,
        message: `${pageSuccess}/${pageCount}개 저장`,
      });
    }

    await sleep(400 + Math.floor(Math.random() * 300));
  }

  sendProgress({
    type: cancelRequested ? "cancelled" : "all-complete",
    completedEpisodes,
    totalEpisodes: selected.length,
    seriesSlug,
  });

  return {
    completedEpisodes,
    totalEpisodes: selected.length,
    cancelled: cancelRequested,
    seriesSlug,
  };
}

async function listLibrary() {
  const libraryRoot = await getLibraryRoot();
  await normalizeAllSeriesStorage(libraryRoot);

  const entries = await fsp.readdir(libraryRoot, {
    withFileTypes: true,
  });

  const seriesList = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const seriesDir = path.join(libraryRoot, entry.name);
    const meta = await readJson(path.join(seriesDir, "series.json"));

    if (!meta) continue;

    const episodes = (meta.episodes || [])
      .filter((episode) => episode.completed)
      .sort((a, b) => Number(a.number) - Number(b.number));

    let coverUrl = "";

    if (episodes.length > 0) {
      const firstEpisodeDir = path.join(
        seriesDir,
        "episodes",
        String(episodes[0].number).padStart(4, "0"),
      );

      try {
        const firstImage = (await fsp.readdir(firstEpisodeDir))
          .filter((name) => /^\d{4}\.png$/i.test(name))
          .sort()[0];

        if (firstImage) {
          coverUrl = pathToFileURL(
            path.join(firstEpisodeDir, firstImage),
          ).href;
        }
      } catch {
        // No cover.
      }
    }

    seriesList.push({
      ...meta,
      episodes,
      coverUrl,
      completedCount: episodes.length,
    });
  }

  seriesList.sort((a, b) =>
    String(a.title).localeCompare(String(b.title), "ko"),
  );

  return {
    libraryRoot,
    series: seriesList,
  };
}

async function getEpisodeImages(seriesSlug, episodeNumber) {
  const libraryRoot = await getLibraryRoot();
  const episodeDir = path.join(
    libraryRoot,
    safeFileName(seriesSlug),
    "episodes",
    String(episodeNumber).padStart(4, "0"),
  );

  const names = (await fsp.readdir(episodeDir))
    .filter((name) => /^\d{4}\.png$/i.test(name))
    .sort();

  return names.map((name, index) => ({
    index: index + 1,
    name,
    url: pathToFileURL(path.join(episodeDir, name)).href,
  }));
}

async function copyDirectory(source, destination) {
  await fsp.mkdir(destination, { recursive: true });

  for (const entry of await fsp.readdir(source, {
    withFileTypes: true,
  })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else {
      await fsp.copyFile(sourcePath, destinationPath);
    }
  }
}

async function exportStaticReader(seriesSlug) {
  const libraryRoot = await getLibraryRoot();
  const seriesDir = path.join(libraryRoot, seriesSlug);
  const seriesMeta = await readJson(
    path.join(seriesDir, "series.json"),
  );

  if (!seriesMeta) {
    throw new Error("작품 정보를 찾을 수 없습니다.");
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "배포용 리더를 저장할 폴더 선택",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { cancelled: true };
  }

  const destination = path.join(
    result.filePaths[0],
    `${safeFileName(seriesMeta.title)}-reader`,
  );

  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });

  const templateDir = path.join(
    __dirname,
    "..",
    "viewer-template",
  );

  await copyDirectory(templateDir, destination);

  const exportEpisodes = [];

  for (const episode of (seriesMeta.episodes || [])
    .filter((item) => item.completed)
    .sort((a, b) => Number(a.number) - Number(b.number))) {
    const padded = String(episode.number).padStart(4, "0");
    const sourceEpisodeDir = path.join(
      seriesDir,
      "episodes",
      padded,
    );
    const targetEpisodeDir = path.join(
      destination,
      "episodes",
      padded,
    );

    await fsp.mkdir(targetEpisodeDir, { recursive: true });

    const imageNames = (await fsp.readdir(sourceEpisodeDir))
      .filter((name) => /^\d{4}\.png$/i.test(name))
      .sort();

    for (const imageName of imageNames) {
      await fsp.copyFile(
        path.join(sourceEpisodeDir, imageName),
        path.join(targetEpisodeDir, imageName),
      );
    }

    exportEpisodes.push({
      number: episode.number,
      title: episode.title,
      images: imageNames.map(
        (name) => `episodes/${padded}/${name}`,
      ),
    });
  }

  await writeJson(path.join(destination, "data.json"), {
    title: seriesMeta.title,
    sourceUrl: seriesMeta.sourceUrl,
    exportedAt: new Date().toISOString(),
    episodes: exportEpisodes,
  });

  await writeJson(path.join(destination, "vercel.json"), {
    cleanUrls: true,
    trailingSlash: false,
  });

  return {
    cancelled: false,
    destination,
    episodeCount: exportEpisodes.length,
  };
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 930,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0b0d12",
    title: "Toki Reader Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadFile(
    path.join(__dirname, "..", "ui", "index.html"),
  );
}

app.whenReady().then(async () => {
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("settings:get", async () => {
  return readSettings();
});

ipcMain.handle("settings:choose-library", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "보관함 폴더 선택",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { cancelled: true };
  }

  const settings = await readSettings();
  settings.libraryRoot = result.filePaths[0];
  await writeSettings(settings);
  await fsp.mkdir(settings.libraryRoot, { recursive: true });

  return {
    cancelled: false,
    libraryRoot: settings.libraryRoot,
  };
});

ipcMain.handle("settings:open-library", async () => {
  const libraryRoot = await getLibraryRoot();
  await shell.openPath(libraryRoot);
  return libraryRoot;
});

ipcMain.handle("crawler:scan", async (_event, payload) => {
  return scanWorkPage(payload);
});

ipcMain.handle("crawler:start", async (_event, payload) => {
  return downloadEpisodes(payload);
});

ipcMain.handle("crawler:cancel", async () => {
  cancelRequested = true;
  return { ok: true };
});

ipcMain.handle("crawler:toggle-window", async (_event, show) => {
  const worker = await createWorkerWindow(Boolean(show));
  if (show) worker.show();
  else worker.hide();
  return { visible: worker.isVisible() };
});

ipcMain.handle("library:list", async () => {
  return listLibrary();
});

ipcMain.handle(
  "library:episode-images",
  async (_event, seriesSlug, episodeNumber) => {
    return getEpisodeImages(seriesSlug, episodeNumber);
  },
);

ipcMain.handle("library:open-series", async (_event, seriesSlug) => {
  const libraryRoot = await getLibraryRoot();
  const seriesDir = path.join(libraryRoot, seriesSlug);
  await shell.openPath(seriesDir);
  return seriesDir;
});

ipcMain.handle("export:static-reader", async (_event, seriesSlug) => {
  return exportStaticReader(seriesSlug);
});
