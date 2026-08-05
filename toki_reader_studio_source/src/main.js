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

  await sleep(3500);
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
    throw new Error("작품 목록 URL 또는 회차 URL 목록을 입력하세요.");
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

        for (const anchor of document.querySelectorAll("a[href]")) {
          const text = (anchor.innerText || anchor.textContent || "")
            .replace(/\\s+/g, " ")
            .trim();

          let href = "";

          try {
            href = new URL(anchor.getAttribute("href"), location.href).href;
          } catch {
            continue;
          }

          const parsed = new URL(href);
          const pattern = new RegExp("^/webtoon/" + seriesId + "/[^/]+/?$");

          if (!pattern.test(parsed.pathname)) continue;

          const match = text.match(/(?<!\\d)(\\d{1,5})(?:\\.\\d+)?\\s*화/);

          if (!match) continue;

          output.push({
            number: Number(match[1]),
            title: text,
            url: href,
          });
        }

        return output;
      })()
    `);

    for (const item of found) {
      if (item.number < minValue || item.number > maxValue) continue;
      episodeMap.set(item.url, {
        ...item,
        selected: true,
      });
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
        const distance = Math.max(window.innerHeight * 0.85, 650);
        root.scrollTop = Math.min(root.scrollTop + distance, root.scrollHeight);
        window.scrollBy(0, distance);
      })()
    `);

    await sleep(550);
  }

  const pageInfo = await worker.webContents.executeJavaScript(`
    (() => {
      const heading =
        document.querySelector("h1")?.innerText ||
        document.querySelector('[class*="title"]')?.innerText ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        "";

      return {
        title: String(heading)
          .replace(/^\\d+\\s*[-–]\\s*/, "")
          .replace(/\\s*\\|.*$/, "")
          .trim(),
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
          const timer = setTimeout(resolve, 30000);
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

      await new Promise((resolve) => setTimeout(resolve, 250));

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

  const seriesTitle = safeFileName(title || "웹툰");
  const sourceId = extractSeriesId(sourceUrl || selected[0]?.url || "");
  const seriesSlug = slugify(
    sourceId ? `${seriesTitle}-${sourceId}` : seriesTitle,
  );

  activeSeriesSlug = seriesSlug;

  const libraryRoot = await getLibraryRoot();
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

    for (let retry = 0; retry < 4; retry += 1) {
      pageCount = await getViewerCount(worker.webContents);
      if (pageCount > 0) break;
      await sleep(2000);
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

      await sleep(180 + Math.floor(Math.random() * 180));
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

    await sleep(1200 + Math.floor(Math.random() * 1000));
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
