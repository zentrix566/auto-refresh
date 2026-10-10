'use strict';

// 把扩展打包成可分发的 zip，只用 Node 内置模块手写 ZIP 容器，不引入第三方依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./crc32');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 只有这些内容会进入分发包，README / LICENSE / tools 等开发用文件不打包
const INCLUDE_FILES = ['manifest.json', 'background.js'];
const INCLUDE_DIRS = ['popup', 'icons'];

function collectFiles() {
  const entries = [];

  INCLUDE_FILES.forEach((name) => {
    const full = path.join(ROOT, name);
    if (!fs.existsSync(full)) throw new Error(`缺少必需文件：${name}`);
    entries.push({ name, full });
  });

  INCLUDE_DIRS.forEach((dir) => {
    const dirPath = path.join(ROOT, dir);
    if (!fs.existsSync(dirPath)) throw new Error(`缺少必需目录：${dir}`);
    fs.readdirSync(dirPath).forEach((file) => {
      const full = path.join(dirPath, file);
      if (fs.statSync(full).isFile()) entries.push({ name: `${dir}/${file}`, full });
    });
  });

  return entries;
}

/** 把时间转成 ZIP 使用的 MS-DOS 时间/日期格式 */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const { time, day } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach((entry) => {
    const raw = fs.readFileSync(entry.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压缩后反而变大时退回不压缩存储
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centrals.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  });

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, end]);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entries = collectFiles();
  const zip = buildZip(entries);

  fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, `auto-refresh-v${manifest.version}.zip`);
  fs.writeFileSync(outFile, zip);

  console.log(`打包完成：${outFile}`);
  console.log(`包含 ${entries.length} 个文件，体积 ${(zip.length / 1024).toFixed(1)} KB`);
  entries.forEach((entry) => console.log(`  - ${entry.name}`));
}

main();
