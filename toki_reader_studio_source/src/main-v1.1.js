const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
} = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pathToFileURL } = require("url");

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

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function getLibraryRoot() {
  const settingsPath = path.join(
    app.getPath("userData"),
    "settings.json",
  );
  const settings = await readJson(settingsPath, {});
  const libraryRoot =
    settings.libraryRoot ||
    path.join(app.getPath("userData"), "library");

  await fsp.mkdir(libraryRoot, { recursive: true });
  return libraryRoot;
}

function sendProgress(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("crawler:progress", payload);
    }
  }
}

async function waitForPrintImages(printWindow) {
  await printWindow.webContents.executeJavaScript(`
    Promise.all(
      [...document.images].map((image) => {
        if (image.complete && image.naturalWidth > 0) {
          return Promise.resolve();
        }

        return new Promise((resolve) => {
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
      }),
    )
  `);
}

function buildEpisodePdfHtml(seriesTitle, episode, imagePaths) {
  const pages = imagePaths.map((imagePath, index) => {
    const imageUrl = pathToFileURL(imagePath).href;

    return `
      <section class="pdf-page">
        <img
          src="${imageUrl}"
          alt="${Number(episode.number)}화 ${index + 1}페이지"
        >
      </section>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${safeFileName(seriesTitle)} ${Number(episode.number)}화</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 0;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: white;
    }

    .pdf-page {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 210mm;
      height: 297mm;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
      background: white;
    }

    .pdf-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }

    .pdf-page img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  </style>
</head>
<body>${pages}</body>
</html>`;
}

async function createEpisodePdf(
  seriesTitle,
  episode,
  imagePaths,
  outputPath,
) {
  const printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const temporaryHtmlPath = path.join(
    app.getPath("temp"),
    `toki-pdf-${process.pid}-${Date.now()}.html`,
  );

  try {
    const html = buildEpisodePdfHtml(
      seriesTitle,
      episode,
      imagePaths,
    );

    await fsp.writeFile(temporaryHtmlPath, html, "utf-8");
    await printWindow.loadFile(temporaryHtmlPath);
    await waitForPrintImages(printWindow);
    await sleep(300);

    const pdfData = await printWindow.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: "A4",
      preferCSSPageSize: true,
    });

    await fsp.writeFile(outputPath, pdfData);
    return pdfData.length;
  } finally {
    await fsp.rm(temporaryHtmlPath, { force: true });

    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }
}

async function exportSeriesPdf(seriesSlug) {
  const libraryRoot = await getLibraryRoot();
  const seriesDir = path.join(libraryRoot, seriesSlug);
  const seriesMeta = await readJson(
    path.join(seriesDir, "series.json"),
  );

  if (!seriesMeta) {
    throw new Error("작품 정보를 찾을 수 없습니다.");
  }

  const result = await dialog.showOpenDialog({
    title: "PDF를 저장할 폴더 선택",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { cancelled: true };
  }

  const destination = path.join(
    result.filePaths[0],
    `${safeFileName(seriesMeta.title)}-PDF`,
  );

  await fsp.mkdir(destination, { recursive: true });

  const completedEpisodes = (seriesMeta.episodes || [])
    .filter((item) => item.completed)
    .sort((a, b) => Number(a.number) - Number(b.number));

  if (completedEpisodes.length === 0) {
    throw new Error("PDF로 내보낼 완료 회차가 없습니다.");
  }

  let exportedCount = 0;
  const failedEpisodes = [];

  for (let index = 0; index < completedEpisodes.length; index += 1) {
    const episode = completedEpisodes[index];
    const padded = String(episode.number).padStart(4, "0");
    const episodeDir = path.join(
      seriesDir,
      "episodes",
      padded,
    );

    const imageNames = (await fsp.readdir(episodeDir))
      .filter((name) => /^\d{4}\.png$/i.test(name))
      .sort();

    if (imageNames.length === 0) {
      failedEpisodes.push(Number(episode.number));
      continue;
    }

    const imagePaths = imageNames.map((name) =>
      path.join(episodeDir, name),
    );
    const outputPath = path.join(
      destination,
      `${padded}화.pdf`,
    );

    sendProgress({
      type: "pdf-progress",
      episode: Number(episode.number),
      index: index + 1,
      total: completedEpisodes.length,
    });

    try {
      await createEpisodePdf(
        seriesMeta.title,
        episode,
        imagePaths,
        outputPath,
      );
      exportedCount += 1;
    } catch (error) {
      failedEpisodes.push(Number(episode.number));
      sendProgress({
        type: "warning",
        message: `${episode.number}화 PDF 생성 실패: ${error.message}`,
      });
    }
  }

  return {
    cancelled: false,
    destination,
    episodeCount: exportedCount,
    failedEpisodes,
  };
}

async function deleteSeriesFromLibrary(seriesSlug, seriesTitle) {
  const libraryRoot = await getLibraryRoot();
  const rootPath = path.resolve(libraryRoot);
  const seriesDir = path.resolve(libraryRoot, String(seriesSlug || ""));

  if (
    !seriesSlug ||
    seriesDir === rootPath ||
    !seriesDir.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new Error("삭제할 작품 경로가 올바르지 않습니다.");
  }

  const confirmation = await dialog.showMessageBox({
    type: "warning",
    title: "보관함에서 삭제",
    message: `“${String(seriesTitle || seriesSlug)}” 작품을 삭제할까요?`,
    detail: "저장된 모든 회차 이미지와 작품 정보가 함께 삭제됩니다.",
    buttons: ["취소", "삭제"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (confirmation.response !== 1) {
    return { deleted: false, cancelled: true };
  }

  await fsp.rm(seriesDir, { recursive: true, force: true });
  return { deleted: true, cancelled: false };
}

ipcMain.handle(
  "library:delete-series",
  async (_event, seriesSlug, seriesTitle) => {
    return deleteSeriesFromLibrary(seriesSlug, seriesTitle);
  },
);

ipcMain.handle("export:pdf", async (_event, seriesSlug) => {
  return exportSeriesPdf(seriesSlug);
});

require("./main.js");
