'use strict';

let table = null;

function buildTable() {
  const result = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    result[n] = c >>> 0;
  }
  return result;
}

/** 标准 CRC-32（PNG 与 ZIP 格式共用同一套多项式） */
function crc32(buffer) {
  if (!table) table = buildTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = { crc32 };
