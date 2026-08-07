const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'novel-passive-body-downloader.js');
let source = fs.readFileSync(filename, 'utf-8');

// v1.1.22 계열에서 남아 있을 수 있는 잘못된 정규식 이스케이프를 먼저 교정합니다.
source = source.split('/\\\\/api\\\\/|novel|episode|content/i').join('/\\/api\\/|novel|episode|content/i');

// 네이티브 선택/복사 fallback에서 Electron clipboard를 사용합니다.
source = source.replace(
  "const { app, BrowserWindow } = require('electron');",
  "const { app, BrowserWindow, clipboard } = require('electron');"
);

// 동적 NovelContent가 늦게 나타나는 경우를 위해 최대 60초까지 DOM을 확인합니다.
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

  // novel-viewer의 도구 막대는 본문 바로 앞에 "기본" 버튼을 갖습니다.
  // 화면 전체 선택 시 이 위치 이후부터 댓글 영역 직전까지가 실제 소설 본문입니다.
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '기본') start = index + 1;
  }

  if (start < 0) {
    // 사이트 표현이 바뀐 경우 "글자 - 16px + 기본" 주변을 보조 기준으로 찾습니다.
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

  return bodyLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractNativePageText(contents, episodeUrl) {
  let previousClipboard = '';
  let copied = '';

  try { previousClipboard = clipboard.readText(); } catch {}

  try {
    if (typeof contents.focus === 'function') contents.focus();
    if (typeof contents.selectAll !== 'function' || typeof contents.copy !== 'function') {
      return { text: '', selector: '', length: 0 };
    }

    contents.selectAll();
    await sleep(120);
    contents.copy();
    await sleep(160);
    copied = clipboard.readText();
  } catch {
    copied = '';
  } finally {
    try {
      if (typeof contents.unselect === 'function') contents.unselect();
    } catch {}
    try {
      // 사용자의 기존 클립보드 텍스트를 즉시 복원합니다.
      clipboard.writeText(previousClipboard);
    } catch {}
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
    `  // NovelContent는 JSON + WASM으로 복원된 글을 닫힌/보호된 렌더링 영역에 표시할 수 있어\n  // document.outerHTML이나 일반 DOM 탐색에는 본문이 보이지 않을 수 있습니다.\n  // 이 경우 Chromium의 실제 화면 선택/복사 명령으로 사용자가 읽는 텍스트를 그대로 가져옵니다.\n  const nativeCopy = await extractNativePageText(window.webContents, episodeUrl);\n  const nativeScore = candidateScore(nativeCopy.text, nativeCopy.selector, episodeUrl);\n  if (nativeCopy.text.length >= 100 && nativeScore >= 1800) {\n    return {\n      text: nativeCopy.text,\n      method: 'native-page-copy',\n      selector: nativeCopy.selector,\n      sourceUrl: episodeUrl,\n      responseCount: 0,\n      resourceCount: 0,\n      loadError,\n    };\n  }\n\n${replayMarker}`
  );
}

const loaded = new Module(filename, module.parent);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(source, filename);

module.exports = loaded.exports;
