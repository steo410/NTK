const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const previousLoadURL = BrowserWindow.prototype.loadURL;
const attachedSessions = new WeakSet();
const activeNovelLoads = new Map();

function isNovelEpisodeUrl(value) {
  try {
    return /^\/novel\/\d+\/[^/?#]+\/?$/.test(new URL(String(value || '')).pathname);
  } catch {
    return false;
  }
}

function diagnosticsPath() {
  const root = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'novel-network-latest.jsonl');
}

function appendRecord(record) {
  try {
    fs.appendFileSync(
      diagnosticsPath(),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      'utf-8',
    );
  } catch {}
}

function shouldRecord(details) {
  const active = activeNovelLoads.get(details.webContentsId);
  if (!active) return null;
  if (Date.now() - active.startedAt > 90_000) {
    activeNovelLoads.delete(details.webContentsId);
    return null;
  }

  const type = String(details.resourceType || '').toLowerCase();
  const url = String(details.url || '');
  const interesting = ['xhr', 'fetch'].includes(type)
    || /\/api\//i.test(url)
    || /novel/i.test(url);
  return interesting ? active : null;
}

function attachSession(session) {
  if (!session || attachedSessions.has(session)) return;
  attachedSessions.add(session);

  session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    const active = shouldRecord(details);
    if (!active) return;
    appendRecord({
      kind: 'completed',
      pageUrl: active.pageUrl,
      webContentsId: details.webContentsId,
      resourceType: details.resourceType,
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      fromCache: Boolean(details.fromCache),
      ip: details.ip || '',
    });
  });

  session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    const active = shouldRecord(details);
    if (!active) return;
    appendRecord({
      kind: 'error',
      pageUrl: active.pageUrl,
      webContentsId: details.webContentsId,
      resourceType: details.resourceType,
      method: details.method,
      url: details.url,
      error: details.error || '',
    });
  });
}

BrowserWindow.prototype.loadURL = async function ntkNovelNetworkDiagnosticLoadURL(url, ...args) {
  if (isNovelEpisodeUrl(url) && !this.isDestroyed() && !this.webContents.isDestroyed()) {
    attachSession(this.webContents.session);
    activeNovelLoads.set(this.webContents.id, {
      pageUrl: String(url),
      startedAt: Date.now(),
    });

    try {
      fs.writeFileSync(diagnosticsPath(), '', 'utf-8');
      appendRecord({
        kind: 'episode-load-start',
        pageUrl: String(url),
        webContentsId: this.webContents.id,
      });
    } catch {}
  }

  return previousLoadURL.call(this, url, ...args);
};
