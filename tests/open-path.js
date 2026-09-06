'use strict';
// Reads the launcher's default landing path without starting it.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'launcher.js'), 'utf8');
const m = src.match(/OPEN_PATH\s*=\s*process\.env\.OPEN_PATH\s*\|\|\s*'([^']*)'/);
module.exports = m ? m[1] : null;
