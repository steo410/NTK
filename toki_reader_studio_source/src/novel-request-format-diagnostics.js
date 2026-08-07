const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let installed = false;
let active = false;
let activeOrigin = '';
let activeSourceUrl = '';
let logPath = '';
let summaryPath = '';
let startedAt = '';
const pending = new Map();
const records = [];

function now() {
  return new Date().toISOString();
}

function diagnosticsDir() {
  return path.join(app.getPath('userData'), 'diagnostics');
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    // Query parameter values can contain short-lived tokens. Keep only parameter names.
    const names = [...url.searchParams.keys()];
    url.search = '';
    if (names.length) url.search = `?${[...new Set(names)].map((name) => `${encodeURIComponent(name)}=<redacted>`).join('&')}`;
    return url.toString();
  } catch {
    return String(value || '').slice(0, 1000);
  }
}

function redactHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (['cookie', 'authorization', 'proxy-authorization', 'set-cookie'].includes(lower)) {
      output[key] = '<redacted>';
    } else if (lower.includes('token') || lower.includes('secret') || lower.includes('key')) {
      output[key] = '<redacted>';
    } else {
      output[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
  }
  return output;
}

function headerValue(headers = {}, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return '';
}

function summarizeUpload(uploadData = [], requestHeaders = {}) {
  if (!Array.isArray(uploadData) || uploadData.length === 0) return null;
  const contentType = headerValue(requestHeaders, 'content-type');
  const result = {
    contentType,
    parts: uploadData.length,
    totalBytes: 0,
    structure: [],
  };

  for (const item of uploadData) {
    if (item?.bytes) {
      const buffer = Buffer.from(item.bytes);
      result.totalBytes += buffer.length;
      if (buffer.length <= 128 * 1024) {
        const text = buffer.toString('utf8');
        if (/json/i.test(contentType)) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              result.structure.push({ type: 'json', keys: Object.keys(parsed).slice(0, 80) });
            } else {
              result.structure.push({ type: 'json', valueType: Array.isArray(parsed) ? 'array' : typeof parsed });
            }
          } catch {
            result.structure.push({ type: 'bytes', length: buffer.length });
          }
        } else if (/x-www-form-urlencoded/i.test(contentType)) {
          try {
            const params = new URLSearchParams(text);
            result.structure.push({ type: 'form', keys: [...new Set([...params.keys()])].slice(0, 80) });
          } catch {
            result.structure.push({ type: 'bytes', length: buffer.length });
          }
        } else {
          result.structure.push({ type: 'bytes', length: buffer.length });
        }
      } else {
        result.structure.push({ type: 'bytes', length: buffer.length });
      }
    } else if (item?.file) {
      result.structure.push({ type: 'file', present: true });
    } else if (item?.blobUUID) {
      result.structure.push({ type: 'blob', present: true });
    }
  }
  return result;
}

function looksRelated(details = {}, requestHeaders = {}) {
  if (!active) return false;
  const url = String(details.url || '');
  const type = String(details.resourceType || '');
  const referrer = String(details.referrer || headerValue(requestHeaders, 'referer') || '');
  const initiator = String(details.initiator || '');

  if (activeOrigin && url.startsWith(activeOrigin)) {
    if (type === 'xhr' || type === 'fetch' || type === 'other') return true;
    if (/\/novel\//i.test(url) || /api|content|episode|chapter|reader/i.test(url)) return true;
  }
  if (type === 'xhr' || type === 'fetch') {
    if (/\/novel\//i.test(referrer) || /\/novel\//i.test(initiator)) return true;
    if (activeOrigin && (referrer.startsWith(activeOrigin) || initiator.startsWith(activeOrigin))) return true;
  }
  return false;
}

async function append(record) {
  if (!active || !logPath) return;
  records.push(record);
  if (records.length > 2000) records.shift();
  try {
    await fsp.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {}
}

function install() {
  if (installed) return;
  installed = true;
  const webRequest = session.defaultSession.webRequest;

  webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (active && looksRelated(details)) {
      const state = pending.get(details.id) || {};
      Object.assign(state, {
        id: details.id,
        startedAt: now(),
        method: details.method,
        url: safeUrl(details.url),
        rawUrlHost: (() => { try { return new URL(details.url).host; } catch { return ''; } })(),
        resourceType: details.resourceType,
        referrer: safeUrl(details.referrer || ''),
        initiator: safeUrl(details.initiator || ''),
        uploadData: details.uploadData || null,
      });
      pending.set(details.id, state);
    }
    callback({});
  });

  webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    if (active && (pending.has(details.id) || looksRelated(details, details.requestHeaders))) {
      const state = pending.get(details.id) || {
        id: details.id,
        startedAt: now(),
        method: details.method,
        url: safeUrl(details.url),
        resourceType: details.resourceType,
      };
      state.requestHeaders = redactHeaders(details.requestHeaders);
      state.referrer = state.referrer || safeUrl(headerValue(details.requestHeaders, 'referer'));
      state.originHeader = safeUrl(headerValue(details.requestHeaders, 'origin'));
      state.requestBody = summarizeUpload(state.uploadData || details.uploadData || [], details.requestHeaders);
      delete state.uploadData;
      pending.set(details.id, state);
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    if (active && pending.has(details.id)) {
      const state = pending.get(details.id);
      state.statusCode = details.statusCode;
      state.statusLine = details.statusLine || '';
      state.responseHeaders = redactHeaders(details.responseHeaders);
      state.contentType = headerValue(details.responseHeaders, 'content-type');
      state.contentLength = headerValue(details.responseHeaders, 'content-length');
      state.responseUrl = safeUrl(details.url);
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (!active || !pending.has(details.id)) return;
    const state = pending.get(details.id);
    pending.delete(details.id);
    state.completedAt = now();
    state.statusCode = state.statusCode || details.statusCode;
    state.fromCache = Boolean(details.fromCache);
    state.ip = details.ip || '';
    append(state);
  });

  webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    if (!active || !pending.has(details.id)) return;
    const state = pending.get(details.id);
    pending.delete(details.id);
    state.completedAt = now();
    state.error = details.error || 'request failed';
    append(state);
  });
}

function notify(message) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('crawler:progress', { type: 'status', message });
  }
}

async function begin(sourceUrl = '') {
  install();
  activeSourceUrl = String(sourceUrl || '');
  try { activeOrigin = new URL(activeSourceUrl).origin; } catch { activeOrigin = ''; }
  startedAt = now();
  records.length = 0;
  pending.clear();
  const dir = diagnosticsDir();
  await fsp.mkdir(dir, { recursive: true });
  logPath = path.join(dir, 'novel-request-format-latest.jsonl');
  summaryPath = path.join(dir, 'novel-request-format-summary.json');
  await fsp.writeFile(logPath, '', 'utf8');
  active = true;
  notify(`소설 요청 형식 진단 시작 · ${logPath}`);
  return { logPath, summaryPath };
}

async function end() {
  if (!active) return { logPath, summaryPath, count: records.length };
  active = false;

  const interesting = records.filter((item) => {
    const type = String(item.resourceType || '');
    return type === 'xhr' || type === 'fetch' || /api|content|episode|chapter|novel|reader/i.test(String(item.url || ''));
  });

  const summary = {
    type: 'novel-request-format-diagnostic',
    sourceUrl: safeUrl(activeSourceUrl),
    origin: activeOrigin,
    startedAt,
    completedAt: now(),
    requestCount: records.length,
    interestingCount: interesting.length,
    contentTypes: [...new Set(interesting.map((item) => item.contentType).filter(Boolean))],
    statusCodes: [...new Set(interesting.map((item) => item.statusCode).filter(Boolean))],
    likelyContentRequests: interesting
      .map((item) => ({
        method: item.method,
        url: item.url,
        resourceType: item.resourceType,
        statusCode: item.statusCode,
        contentType: item.contentType || '',
        contentLength: item.contentLength || '',
        referrer: item.referrer || '',
        origin: item.originHeader || '',
        requestBody: item.requestBody || null,
        error: item.error || '',
      }))
      .slice(0, 300),
  };

  try { await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8'); } catch {}
  notify(`소설 요청 형식 진단 완료 · 요청 ${records.length}개 · ${summaryPath}`);
  return { logPath, summaryPath, count: records.length, interestingCount: interesting.length };
}

module.exports = { begin, end, install };
