const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'novel-passive-body-downloader.js');
let source = fs.readFileSync(filename, 'utf-8');

source = source.split('/\\\\/api\\\\/|novel|episode|content/i').join('/\\/api\\/|novel|episode|content/i');
source = source.replace(
  "const { app, BrowserWindow } = require('electron');",
  "const { app, BrowserWindow, clipboard } = require('electron');"
);
source = source.replace(
  'for (let round = 0; round < 28; round += 1) {',
  'for (let round = 0; round < 240; round += 1) {'
);
source = source.replace(
  'for (let round = 0; round < 180; round += 1) {',
  'for (let round = 0; round < 240; round += 1) {'
);

const nativeHelper = String.raw`
function isolateNativeNovelText(rawValue) {
  const raw = String(rawValue || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');

  const lines = raw.split('\n').map((line) => line.trim());
  if (!lines.length) return '';

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '기본') start = index + 1;
  }

  if (start < 0) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/^글자$/.test(lines[index])) {
        const nearby = lines.slice(index, index + 8);
        const basicOffset = nearby.findIndex((line) => line === '기본');
        if (basicOffset >= 0) {
          start = index + basicOffset + 1;
          break;
        }
      }
    }
  }

  if (start < 0) return '';

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^댓글(?:\s+\d+\s*개)?$/.test(line)
      || /^댓글을 작성하려면/.test(line)
      || /^아직 댓글이 없어요/.test(line)) {
      end = index;
      break;
    }
  }

  const uiLines = new Set([
    '‹ 이전화', '이전화', '목록', '책갈피', '다음화 ›', '다음화',
    '최상단', '한 화면 위로', '한 화면 아래로', '댓글', '최하단',
    '음성 읽기', '설정', '글자', '−', '-', '+', '기본'
  ]);

  const bodyLines = lines.slice(start, end).filter((line) => {
    if (!line) return true;
    if (uiLines.has(line)) return false;
    if (/^\d+\s*px$/i.test(line)) return false;
    if (/^댓글\s*\d+\s*개$/.test(line)) return false;
    if (/^(로그인|회원가입)$/.test(line)) return false;
    return true;
  });

  return bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function snapshotClipboard() {
  const saved = [];
  try {
    for (const format of clipboard.availableFormats()) {
      try { saved.push({ format, data: clipboard.readBuffer(format) }); } catch {}
    }
  } catch {}
  return saved;
}

function restoreClipboard(saved) {
  try { clipboard.clear(); } catch {}
  if (!Array.isArray(saved) || saved.length === 0) return;
  for (const item of saved) {
    try { clipboard.writeBuffer(item.format, item.data); } catch {}
  }
}

async function extractNativePageText(contents, episodeUrl) {
  const savedClipboard = snapshotClipboard();
  let copied = '';

  try {
    if (typeof contents.focus === 'function') contents.focus();
    if (typeof contents.selectAll !== 'function' || typeof contents.copy !== 'function') {
      return { text: '', selector: '', length: 0 };
    }

    contents.selectAll();
    await sleep(160);
    contents.copy();
    await sleep(220);
    copied = clipboard.readText();
  } catch {
    copied = '';
  } finally {
    try {
      if (typeof contents.unselect === 'function') contents.unselect();
    } catch {}
    restoreClipboard(savedClipboard);
  }

  const text = isolateNativeNovelText(copied);
  return {
    text,
    selector: 'native-select-all-copy',
    length: text.length,
    sourceUrl: episodeUrl,
  };
}
`;

const loadMarker = 'async function loadEpisodeAndExtract(window, episodeUrl) {';
if (!source.includes('async function extractNativePageText(')) {
  source = source.replace(loadMarker, `${nativeHelper}\n${loadMarker}`);
}

const replayMarker = '  const replay = await inspectAndReplayResources(window.webContents);';
if (source.includes(replayMarker) && !source.includes("method: 'native-page-copy'")) {
  source = source.replace(
    replayMarker,
    `  const nativeCopy = await extractNativePageText(window.webContents, episodeUrl);\n  const nativeScore = candidateScore(nativeCopy.text, nativeCopy.selector, episodeUrl);\n  if (nativeCopy.text.length >= 100 && nativeScore >= 1800) {\n    return {\n      text: nativeCopy.text,\n      method: 'native-page-copy',\n      selector: nativeCopy.selector,\n      sourceUrl: episodeUrl,\n      responseCount: 0,\n      resourceCount: 0,\n      loadError,\n    };\n  }\n\n${replayMarker}`
  );
}

const loaded = new Module(filename, module.parent);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(source, filename);

module.exports = loaded.exports;
