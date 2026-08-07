const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const previousLoadURL = BrowserWindow.prototype.loadURL;

async function stabilizeViewer(contents) {
  let previousCount = -1;
  let stableRounds = 0;

  for (let round = 0; round < 24; round += 1) {
    let count = 0;

    try {
      count = Number(await contents.executeJavaScript(`
        (() => {
          const lazyAttributes = ['data-src','data-original','data-lazy','data-url','data-img'];
          const explicitSelectors = [
            '.vw-imgs img.viewer-ratio-img',
            '.vw-imgs img',
            '.view-padding img',
            '.view-content img',
            '#toon_img img',
            '#novel_content img',
            '.viewer img',
            '.webtoon-viewer img',
            '.manhwa-viewer img',
            '.novel-viewer img',
            '.episode-viewer img',
            '.view-wrap img',
            'img[alt^="page "]',
            '[data-ntk-viewer-page="true"]'
          ];
          const excludedParts = [
            'logo','icon','favicon','avatar','profile','banner','advert','/ads/',
            'emoji','loading','spinner','blank.','transparent.'
          ];

          function forceLoad(image) {
            image.loading = 'eager';
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

          function isExcluded(image) {
            if (image.closest('header, nav, footer, button')) return true;
            const source = String(
              image.currentSrc || image.src || image.getAttribute('data-src') || ''
            ).toLowerCase();
            return excludedParts.some((part) => source.includes(part));
          }

          const explicit = [...new Set(
            explicitSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
          )];

          let candidates = explicit;

          if (candidates.length === 0) {
            const roots = [
              ...document.querySelectorAll(
                "main, article, [class*='viewer'], [class*='view-content'], [class*='toon'], [class*='manhwa'], [class*='novel']"
              )
            ];
            if (document.body) roots.push(document.body);

            let best = [];
            let bestScore = -1;

            for (const root of roots) {
              const images = [...root.querySelectorAll('img')].filter((image) => {
                forceLoad(image);
                if (isExcluded(image)) return false;
                const rect = image.getBoundingClientRect();
                const width = Math.max(rect.width, image.naturalWidth || 0);
                const height = Math.max(rect.height, image.naturalHeight || 0);
                return width >= 260 && height >= 180;
              });
              const score = images.reduce((sum, image) => {
                const rect = image.getBoundingClientRect();
                return sum + Math.max(rect.height, image.naturalHeight || 0, 1);
              }, 0);

              if (images.length > best.length || (images.length === best.length && score > bestScore)) {
                best = images;
                bestScore = score;
              }
            }

            candidates = best;
          }

          const unique = [];
          const seen = new Set();

          for (const image of candidates) {
            forceLoad(image);
            if (isExcluded(image)) continue;
            const key = image.currentSrc || image.src || image;
            if (seen.has(key)) continue;
            seen.add(key);
            image.classList.add('viewer-ratio-img');
            image.setAttribute('data-ntk-viewer-page', 'true');
            unique.push(image);
          }

          const root = document.scrollingElement || document.documentElement;
          const viewport = Math.max(window.innerHeight || 800, 600);
          if (root) {
            root.scrollTop = Math.min(root.scrollTop + Math.round(viewport * 0.8), root.scrollHeight);
          }
          window.scrollBy(0, Math.round(viewport * 0.8));
          return unique.length;
        })()
      `)) || 0;
    } catch {
      count = 0;
    }

    if (count > 0 && count === previousCount) stableRounds += 1;
    else {
      stableRounds = 0;
      previousCount = count;
    }

    if (count > 0 && stableRounds >= 3) return count;
    await sleep(180);
  }

  return Math.max(previousCount, 0);
}

BrowserWindow.prototype.loadURL = async function recoveredLoadURL(url, options) {
  let result;
  let loadError = null;

  try {
    result = await previousLoadURL.call(this, url, options);
  } catch (error) {
    loadError = error;
  }

  try {
    const parsed = new URL(url);
    if (/^\/(webtoon|manhwa|novel)\/\d+\/[^/]+\/?$/.test(parsed.pathname)) {
      await sleep(600);
      await stabilizeViewer(this.webContents);
    }
  } catch {
    // 로컬 앱 페이지나 이미 닫힌 창은 그대로 둡니다.
  }

  if (loadError && !this.isDestroyed()) return undefined;
  return result;
};
