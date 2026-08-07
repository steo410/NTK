const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let active = false;
let sourceUrl = '';
let capturePromise = null;
let captureResult = null;

function diagnosticsRoot() {
  return path.join(app.getPath('userData'), 'diagnostics');
}

function bundleDir() {
  return path.join(diagnosticsRoot(), 'novel-diagnostic-bundle-latest');
}

function notify(message) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('crawler:progress', { type: 'status', message });
    }
  }
}

function isNovelEpisodeUrl(value) {
  try {
    const parts = new URL(String(value || '')).pathname.split('/').filter(Boolean);
    return parts[0] === 'novel' && Boolean(parts[1]) && Boolean(parts[2]);
  } catch {
    return false;
  }
}

function cleanSnippet(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 900);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function analyzeChunk(text) {
  const source = String(text || '');
  const endpointPatterns = [
    /["'`]((?:https?:\/\/[^"'`\s]+|\/[^"'`\s]+)(?:api|novel|episode|content|chapter|reader)[^"'`\s]*)["'`]/gi,
    /["'`]([^"'`\s]*(?:api|novel|episode|content|chapter|reader)[^"'`\s]*)["'`]/gi,
  ];

  const endpoints = [];
  for (const regex of endpointPatterns) {
    let match;
    while ((match = regex.exec(source)) && endpoints.length < 200) {
      const value = String(match[1] || '');
      if (value.length >= 3 && value.length <= 500) endpoints.push(value);
    }
  }

  const keywords = [
    'NovelContent', 'fetch(', 'XMLHttpRequest', 'episodeRef', 'episodeId',
    'novelId', 'cookieName', 'credentials', 'application/json', 'text/html',
    '/api/', 'content', 'token',
  ];

  const contexts = [];
  for (const keyword of keywords) {
    let offset = 0;
    let count = 0;
    while (count < 8) {
      const index = source.indexOf(keyword, offset);
      if (index < 0) break;
      const start = Math.max(0, index - 320);
      const end = Math.min(source.length, index + keyword.length + 520);
      contexts.push({ keyword, snippet: cleanSnippet(source.slice(start, end)) });
      offset = index + keyword.length;
      count += 1;
    }
  }

  const moduleIds = unique([
    ...(source.match(/\b\d{3,6}:\s*(?:function|\([^)]*\)=>|[^,]{0,40}=>)/g) || [])
      .map((value) => value.match(/^\d+/)?.[0] || ''),
  ]).slice(0, 200);

  return {
    length: source.length,
    endpoints: unique(endpoints).slice(0, 200),
    contexts: contexts.slice(0, 100),
    moduleIds,
    hasNovelContent: source.includes('NovelContent'),
    hasFetch: source.includes('fetch('),
    hasXHR: source.includes('XMLHttpRequest'),
    hasEpisodeRef: source.includes('episodeRef'),
    hasCookieName: source.includes('cookieName'),
  };
}

function extractRscProps(html) {
  const source = String(html || '');
  const get = (name) => {
    const regex = new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`, 'i');
    return source.match(regex)?.[1] || '';
  };

  const token = get('token');
  return {
    novelId: get('novelId'),
    episodeId: get('episodeId'),
    episodeRef: get('episodeRef'),
    episodeNo: get('episodeNo'),
    cookieName: get('cookieName'),
    tokenPresent: Boolean(token),
    tokenLength: token.length,
    tokenPrefix: token ? `${token.slice(0, 12)}...` : '',
  };
}

async function waitForNovelWindow() {
  for (let round = 0; round < 60 && active; round += 1) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      const current = window.webContents.getURL();
      if (!isNovelEpisodeUrl(current)) continue;

      const page = await window.webContents.executeJavaScript(`
        (() => ({
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          html: document.documentElement?.outerHTML || '',
          scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
          viewerText: String(document.querySelector('.novel-viewer')?.innerText || '').slice(0, 4000),
        }))()
      `).catch(() => null);

      if (!page) continue;
      const novelScripts = page.scripts.filter((url) => /_next\/static\/chunks\/app\/novel\//i.test(url));
      if (page.readyState !== 'loading' && novelScripts.length) {
        return { window, page, novelScripts };
      }
    }
    await sleep(500);
  }
  return null;
}

async function captureClientCode() {
  const found = await waitForNovelWindow();
  if (!found) {
    return { ok: false, error: '소설 회차 작업 브라우저 또는 전용 JS 청크를 찾지 못했습니다.' };
  }

  const { window, page, novelScripts } = found;
  const root = bundleDir();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fsp.mkdir(root, { recursive: true });

  const analysis = {
    type: 'novel-client-chunk-analysis',
    capturedAt: new Date().toISOString(),
    sourceUrl,
    pageUrl: page.url,
    pageTitle: page.title,
    readyState: page.readyState,
    viewerTextLength: page.viewerText.length,
    viewerTextPreview: page.viewerText.slice(0, 1000),
    rscProps: extractRscProps(page.html),
    scripts: page.scripts,
    novelScripts,
    chunks: [],
  };

  for (let index = 0; index < Math.min(novelScripts.length, 6); index += 1) {
    const scriptUrl = novelScripts[index];
    const item = { url: scriptUrl, status: 0, contentType: '', error: '' };
    try {
      const response = await window.webContents.session.fetch(scriptUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
      });
      item.status = response.status;
      item.contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      item.analysis = analyzeChunk(text);

      if (index === 0 || /NovelContent|episodeRef|cookieName/.test(text)) {
        const rawName = `novel-client-chunk-${index + 1}.js`;
        await fsp.writeFile(path.join(root, rawName), text, 'utf8');
        item.savedAs = rawName;
      }
    } catch (error) {
      item.error = String(error?.message || error);
    }
    analysis.chunks.push(item);
  }

  await fsp.writeFile(
    path.join(root, 'novel-client-chunk-analysis.json'),
    JSON.stringify(analysis, null, 2),
    'utf8',
  );

  return { ok: true, bundlePath: root, analysis };
}

async function copyIfExists(source, destination) {
  try {
    await fsp.copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

async function copyLatestFailureBundle(root) {
  let entries = [];
  try { entries = await fsp.readdir(diagnosticsRoot(), { withFileTypes: true }); } catch {}
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/novel-(?:passive|body|1)/i.test(entry.name)) continue;
    const full = path.join(diagnosticsRoot(), entry.name);
    try {
      const stat = await fsp.stat(full);
      candidates.push({ full, mtime: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const latest = candidates[0]?.full;
  if (!latest) return '';

  for (const name of ['diagnostic.json', 'page.html', 'visible-page.png']) {
    await copyIfExists(path.join(latest, name), path.join(root, name));
  }
  return latest;
}

async function begin(value = '') {
  active = true;
  sourceUrl = String(value || '');
  captureResult = null;
  capturePromise = captureClientCode()
    .then((result) => { captureResult = result; return result; })
    .catch((error) => {
      captureResult = { ok: false, error: String(error?.message || error) };
      return captureResult;
    });
}

async function end(requestDiagnostic = {}) {
  active = false;
  const result = capturePromise ? await capturePromise : captureResult;
  const root = result?.bundlePath || bundleDir();
  await fsp.mkdir(root, { recursive: true });

  const requestFiles = [
    ['novel-request-format-summary.json', requestDiagnostic.summaryPath],
    ['novel-request-format-latest.jsonl', requestDiagnostic.logPath],
  ];
  for (const [name, explicit] of requestFiles) {
    const source = explicit || path.join(diagnosticsRoot(), name);
    await copyIfExists(source, path.join(root, name));
  }

  const failureFolder = await copyLatestFailureBundle(root);
  const manifest = {
    type: 'novel-diagnostic-bundle',
    createdAt: new Date().toISOString(),
    sourceUrl,
    clientChunkCapture: result || null,
    requestDiagnostic: {
      count: requestDiagnostic.count || 0,
      interestingCount: requestDiagnostic.interestingCount || 0,
    },
    copiedFailureFolder: failureFolder,
    filesToShare: [
      'novel-client-chunk-analysis.json',
      'novel-request-format-summary.json',
      'novel-request-format-latest.jsonl',
      'diagnostic.json',
      'page.html',
    ],
  };
  await fsp.writeFile(path.join(root, 'README-diagnostic.json'), JSON.stringify(manifest, null, 2), 'utf8');

  notify(`소설 진단 묶음 저장 완료 · ${root}`);
  return { bundlePath: root, ...manifest };
}

module.exports = { begin, end };
