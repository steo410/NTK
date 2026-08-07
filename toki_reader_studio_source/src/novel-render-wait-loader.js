const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'novel-passive-body-downloader.js');
let source = fs.readFileSync(filename, 'utf-8');

source = source.split('/\\\\/api\\\\/|novel|episode|content/i').join('/\\/api\\/|novel|episode|content/i');
source = source.replace(
  'for (let round = 0; round < 28; round += 1) {',
  'for (let round = 0; round < 180; round += 1) {'
);

const loaded = new Module(filename, module.parent);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(source, filename);

module.exports = loaded.exports;
