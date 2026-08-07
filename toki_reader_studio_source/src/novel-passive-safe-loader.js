const fs = require('fs');
const path = require('path');
const Module = require('module');

// v1.1.22의 novel-passive-body-downloader.js에 잘못 이스케이프된
// 정규식 리터럴이 들어가 앱 시작 자체가 실패할 수 있습니다.
// 원본 파일을 읽어 해당 패턴만 교정한 뒤 CommonJS 모듈로 컴파일합니다.
const filename = path.join(__dirname, 'novel-passive-body-downloader.js');
let source = fs.readFileSync(filename, 'utf-8');

// 잘못된 소스: /\\/api\\/|novel|episode|content/i
// 올바른 소스: /\/api\/|novel|episode|content/i
source = source.split('/\\\\/api\\\\/|novel|episode|content/i').join('/\\/api\\/|novel|episode|content/i');

const loaded = new Module(filename, module.parent);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(source, filename);

module.exports = loaded.exports;
