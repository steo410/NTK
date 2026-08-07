const { app, ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fsp.readFile(filePath, 'utf-8')); }
  catch { return fallback; }
}

async function getLibraryRoot() {
  const settings = await readJson(path.join(app.getPath('userData'), 'settings.json'), {});
  const root = settings.libraryRoot || path.join(app.getPath('userData'), 'library');
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function inferContentType(meta = {}, slug = '') {
  const direct = String(meta.contentType || '').toLowerCase();
  if (['webtoon', 'manhwa', 'novel'].includes(direct)) return direct;

  const urls = [
    meta.sourceUrl,
    ...(Array.isArray(meta.episodes) ? meta.episodes.slice(0, 4).map((episode) => episode?.url) : []),
  ];

  for (const value of urls) {
    try {
      const first = new URL(String(value || '')).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
      if (['webtoon', 'manhwa', 'novel'].includes(first)) return first;
    } catch {}
  }

  const lowerSlug = String(slug || meta.slug || '').toLowerCase();
  if (lowerSlug.startsWith('novel-')) return 'novel';
  if (lowerSlug.startsWith('manhwa-')) return 'manhwa';
  if (lowerSlug.startsWith('webtoon-')) return 'webtoon';
  return 'webtoon';
}

function timeValue(meta = {}) {
  const values = [meta.updatedAt, meta.downloadedAt, meta.createdAt]
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

async function findCover(seriesDir, episodes, contentType) {
  if (contentType === 'novel') return '';
  for (const episode of episodes.slice(0, 4)) {
    const episodeDir = path.join(seriesDir, 'episodes', String(episode.number).padStart(4, '0'));
    try {
      const firstImage = (await fsp.readdir(episodeDir))
        .filter((name) => /^\d{4}\.png$/i.test(name))
        .sort()[0];
      if (firstImage) return pathToFileURL(path.join(episodeDir, firstImage)).href;
    } catch {}
  }
  return '';
}

async function listLibraryEnhanced() {
  const libraryRoot = await getLibraryRoot();
  const entries = await fsp.readdir(libraryRoot, { withFileTypes: true });
  const series = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const seriesDir = path.join(libraryRoot, entry.name);
    const meta = await readJson(path.join(seriesDir, 'series.json'));
    if (!meta) continue;

    const episodes = (meta.episodes || [])
      .filter((episode) => episode?.completed)
      .sort((a, b) => Number(a.number) - Number(b.number));
    const contentType = inferContentType(meta, entry.name);
    const coverUrl = await findCover(seriesDir, episodes, contentType);
    const sortTime = timeValue(meta);

    series.push({
      ...meta,
      slug: meta.slug || entry.name,
      contentType,
      episodes,
      coverUrl,
      completedCount: episodes.length,
      librarySortTime: sortTime,
    });
  }

  // 기본 보관함은 종류를 섞어서 가장 최근에 다운로드/갱신한 작품부터 표시합니다.
  series.sort((a, b) => {
    const timeDiff = Number(b.librarySortTime || 0) - Number(a.librarySortTime || 0);
    if (timeDiff) return timeDiff;
    return String(a.title || '').localeCompare(String(b.title || ''), 'ko');
  });

  return { libraryRoot, series };
}

ipcMain.removeHandler('library:list');
ipcMain.handle('library:list', async () => listLibraryEnhanced());

module.exports = { listLibraryEnhanced, inferContentType };
