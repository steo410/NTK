const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalLoadURL = BrowserWindow.prototype.loadURL;
const hydratedKeys = new Map();

function isNovelEpisodeUrl(value) {
  try {
    return /^\/novel\/\d+\/[^/?#]+/.test(new URL(String(value || '')).pathname);
  } catch {
    return false;
  }
}

function extractNovelToken(serialized) {
  const text = String(serialized || '');

  const tokenPatterns = [
    /\\?"token\\?"\s*:\s*\\?"([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\\?"/,
    /token[^A-Za-z0-9_-]{1,20}([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/,
  ];

  const cookiePatterns = [
    /\\?"cookieName\\?"\s*:\s*\\?"([A-Za-z0-9_-]{1,40})\\?"/,
    /cookieName[^A-Za-z0-9_-]{1,20}([A-Za-z0-9_-]{1,40})/,
  ];

  let token = '';
  let cookieName = 'nv';

  for (const pattern of tokenPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      token = match[1];
      break;
    }
  }

  for (const pattern of cookiePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      cookieName = match[1];
      break;
    }
  }

  return { token, cookieName };
}

async function readTokenInfo(window) {
  try {
    const serialized = await window.webContents.executeJavaScript(`
      (() => {
        const scripts = [...document.scripts]
          .map((script) => script.textContent || '')
          .filter((text) => /token|cookieName|NovelContent/.test(text));
        return scripts.join('\\n').slice(-350000);
      })()
    `);
    return extractNovelToken(serialized);
  } catch {
    return { token: '', cookieName: 'nv' };
  }
}

async function cookieAlreadyMatches(window, pageUrl, cookieName, token) {
  try {
    const cookies = await window.webContents.session.cookies.get({
      url: new URL(pageUrl).origin,
      name: cookieName,
    });
    return cookies.some((cookie) => cookie.value === token);
  } catch {
    return false;
  }
}

async function setNovelCookie(window, pageUrl, cookieName, token) {
  const parsed = new URL(pageUrl);
  const base = `${parsed.protocol}//${parsed.host}`;

  await window.webContents.session.cookies.set({
    url: base,
    name: cookieName || 'nv',
    value: token,
    path: '/',
    secure: parsed.protocol === 'https:',
    sameSite: 'lax',
  });

  await window.webContents.executeJavaScript(`
    (() => {
      try {
        document.cookie = ${JSON.stringify(`${cookieName || 'nv'}=${token}; Path=/; SameSite=Lax`)};
      } catch {}
    })()
  `).catch(() => undefined);
}

BrowserWindow.prototype.loadURL = async function ntkNovelTokenLoadURL(url, ...args) {
  const result = await originalLoadURL.call(this, url, ...args);

  if (!isNovelEpisodeUrl(url) || this.isDestroyed() || this.webContents.isDestroyed()) {
    return result;
  }

  await sleep(250);
  const { token, cookieName } = await readTokenInfo(this);
  if (!token) return result;

  const key = `${String(url)}|${cookieName}|${token}`;
  const lastTime = hydratedKeys.get(key) || 0;
  if (Date.now() - lastTime < 60_000) return result;

  const matches = await cookieAlreadyMatches(this, url, cookieName, token);
  if (matches) {
    hydratedKeys.set(key, Date.now());
    return result;
  }

  try {
    await setNovelCookie(this, url, cookieName, token);
    hydratedKeys.set(key, Date.now());

    // NovelContent가 토큰 쿠키를 읽을 수 있도록 동일 회차를 원본 loadURL로 한 번만 재로딩합니다.
    await originalLoadURL.call(this, url, ...args);
    await sleep(900);
  } catch (error) {
    console.warn('[NTK novel token hydration] 쿠키 보정 실패:', error?.message || error);
  }

  return result;
};
