const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const previousLoadURL = BrowserWindow.prototype.loadURL;

function isStringKeyEpisode(value) {
  try {
    const path = new URL(String(value || '')).pathname;
    const match = path.match(/^\/(webtoon|manhwa|novel)\/([^/]+)\/([^/]+)\/?$/);
    return Boolean(match && !/^\d+$/.test(match[2]));
  } catch {
    return false;
  }
}

async function stabilizeStringViewer(contents) {
  let previousCount = -1;
  let stable = 0;

  for (let round = 0; round < 28; round += 1) {
    const count = Number(await contents.executeJavaScript(`
      (() => {
        const lazy = ['data-src','data-original','data-lazy','data-url','data-img'];
        const selectors = [
          '.vw-imgs img.viewer-ratio-img', '.vw-imgs img', '.view-padding img',
          '.view-content img', '#toon_img img', '.viewer img', '.webtoon-viewer img',
          '.manhwa-viewer img', '.episode-viewer img', 'img[alt^="page "]'
        ];
        const excluded = ['logo','icon','favicon','avatar','profile','banner','advert','/ads/','emoji','loading','spinner'];
        const images = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
        const valid = [];

        for (const image of images) {
          image.loading = 'eager';
          if (!image.src || image.naturalWidth === 0) {
            for (const attr of lazy) {
              const value = image.getAttribute(attr);
              if (value) { image.src = value; break; }
            }
          }
          if (image.closest('header,nav,footer,button')) continue;
          const src = String(image.currentSrc || image.src || '').toLowerCase();
          if (excluded.some((part) => src.includes(part))) continue;
          image.classList.add('viewer-ratio-img');
          image.setAttribute('data-ntk-viewer-page', 'true');
          valid.push(image);
        }

        const root = document.scrollingElement || document.documentElement;
        const viewport = Math.max(window.innerHeight || 800, 600);
        if (root) root.scrollTop = Math.min(root.scrollTop + Math.round(viewport * 0.8), root.scrollHeight);
        window.scrollBy(0, Math.round(viewport * 0.8));
        return valid.length;
      })()
    `).catch(() => 0)) || 0;

    if (count > 0 && count === previousCount) stable += 1;
    else { previousCount = count; stable = 0; }
    if (count > 0 && stable >= 3) return count;
    await sleep(180);
  }

  return Math.max(previousCount, 0);
}

BrowserWindow.prototype.loadURL = async function stringKeyRecoveredLoadURL(url, ...args) {
  const result = await previousLoadURL.call(this, url, ...args);
  if (!isStringKeyEpisode(url) || this.isDestroyed() || this.webContents.isDestroyed()) return result;

  await sleep(600);
  await stabilizeStringViewer(this.webContents);
  return result;
};
