'use strict';

// 生成扩展图标（绿底 + 白色环形刷新箭头），只用 Node 内置模块，不引入图形库依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./crc32');

const BG = [22, 163, 74];
const FG = [255, 255, 255];

const CX = 0.5;
const CY = 0.5;
const RING_R = 0.285;
const RING_T = 0.075;
const ARROW_SIZE = 0.13;

// 两段圆弧的角度区间（度）。图像坐标 y 轴向下，角度顺时针增大。
const ARCS = [
  [50, 210],
  [240, 400]
];
// 箭头三角形挂在每段弧的顺时针末端
const ARROW_ANGLES = [210, 400];

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 有向距离场：圆角矩形，返回值为负表示在形状内部
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  );
}

// 有向距离场：凸多边形。到各边的最短距离即距离值，在内部时取负号
function convexPolygonSdf(px, py, points) {
  let minDistance = Infinity;
  let positive = 0;
  let negative = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    minDistance = Math.min(minDistance, distanceToSegment(px, py, ax, ay, bx, by));
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 0) positive += 1;
    else negative += 1;
  }

  const inside = positive === 0 || negative === 0;
  return inside ? -minDistance : minDistance;
}

/** 圆环被角度区间截断后的有向距离场，缺口处用弧端点近似 */
function arcSdf(px, py, startDeg, endDeg) {
  const dx = px - CX;
  const dy = py - CY;
  const ring = Math.abs(Math.hypot(dx, dy) - RING_R) - RING_T;

  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += Math.PI * 2;

  const start = (startDeg * Math.PI) / 180;
  const span = ((endDeg - startDeg) * Math.PI) / 180;
  let delta = angle - start;
  while (delta < 0) delta += Math.PI * 2;
  while (delta >= Math.PI * 2) delta -= Math.PI * 2;

  if (delta <= span) return ring;

  // 落在缺口里：距离取沿圆周走到最近端点的弧长
  const gap = Math.min(delta - span, Math.PI * 2 - delta);
  return Math.max(ring, gap * RING_R);
}

/** 在指定角度处生成一个沿顺时针切线方向的箭头三角形 */
function arrowPoints(deg) {
  const a = (deg * Math.PI) / 180;
  const px = CX + RING_R * Math.cos(a);
  const py = CY + RING_R * Math.sin(a);
  // 顺时针切线方向
  const tx = -Math.sin(a);
  const ty = Math.cos(a);
  // 径向（指向圆环外侧）
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const s = ARROW_SIZE;

  return [
    [px + tx * s * 1.1, py + ty * s * 1.1],
    [px - tx * s * 0.35 + nx * s * 0.95, py - ty * s * 0.35 + ny * s * 0.95],
    [px - tx * s * 0.35 - nx * s * 0.95, py - ty * s * 0.35 - ny * s * 0.95]
  ];
}

function refreshSdf(nx, ny) {
  let distance = ARCS.reduce(
    (acc, [start, end]) => Math.min(acc, arcSdf(nx, ny, start, end)),
    Infinity
  );
  ARROW_ANGLES.forEach((deg) => {
    distance = Math.min(distance, convexPolygonSdf(nx, ny, arrowPoints(deg)));
  });
  return distance;
}

// 把距离值换算成像素覆盖率，形成 1 像素宽的抗锯齿过渡带
function coverage(distance, aa) {
  return Math.max(0, Math.min(1, 0.5 - distance / aa));
}

// 以 source-over 方式把一层颜色叠到当前像素上
function over(pixel, color, alpha) {
  if (alpha <= 0) return;
  const outAlpha = alpha + pixel.a * (1 - alpha);
  if (outAlpha <= 0) {
    pixel.r = 0;
    pixel.g = 0;
    pixel.b = 0;
    pixel.a = 0;
    return;
  }
  pixel.r = (color[0] * alpha + pixel.r * pixel.a * (1 - alpha)) / outAlpha;
  pixel.g = (color[1] * alpha + pixel.g * pixel.a * (1 - alpha)) / outAlpha;
  pixel.b = (color[2] * alpha + pixel.b * pixel.a * (1 - alpha)) / outAlpha;
  pixel.a = outAlpha;
}

function buildPixels(size) {
  const aa = 1 / size;
  const rows = [];

  for (let y = 0; y < size; y += 1) {
    const row = [Buffer.from([0])];
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const pixel = { r: 0, g: 0, b: 0, a: 0 };

      over(pixel, BG, coverage(roundedRectSdf(nx, ny, 0.5, 0.5, 0.5, 0.5, 0.2), aa));
      over(pixel, FG, coverage(refreshSdf(nx, ny), aa));

      row.push(
        Buffer.from([
          Math.round(pixel.r),
          Math.round(pixel.g),
          Math.round(pixel.b),
          Math.round(pixel.a * 255)
        ])
      );
    }
    rows.push(Buffer.concat(row));
  }

  return Buffer.concat(rows);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function writePng(filePath, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(buildPixels(size))),
    chunk('IEND', Buffer.alloc(0))
  ]);

  fs.writeFileSync(filePath, png);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[16, 48, 128].forEach((size) => {
  const file = path.join(outDir, `icon${size}.png`);
  writePng(file, size);
  console.log(`generated ${file}`);
});
