// 临时核对脚本：检查 popup.js 引用的元素 id 是否都存在于 popup.html
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.html'), 'utf8');

const used = new Set([...js.matchAll(/el\('([a-zA-Z]+)'\)/g)].map((m) => m[1]));
const ids = new Set([...html.matchAll(/id="([a-zA-Z]+)"/g)].map((m) => m[1]));

console.log('JS 引用的元素:', [...used].sort().join(', '));
console.log('HTML 里的元素:', [...ids].sort().join(', '));
const missing = [...used].filter((id) => !ids.has(id));
if (missing.length) {
  console.log('!! JS 引用但 HTML 缺失: ' + missing.join(', '));
  process.exit(1);
}
console.log('== 全部对齐，无缺失 ==');
