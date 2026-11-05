// 解析 Compositor 的 CameraRawShadows.bin（CRS2），打印指定档位的系数
const fs = require('fs');
const path = require('path');
const BIN = process.argv[2] || 'C:/Users/lumos/AppData/Local/Temp/compositor-ref/Compositor/Resources/CameraRawShadows.bin';
const buf = fs.readFileSync(BIN);

const magic = buf.slice(0, 4).toString('ascii');
const sets = buf.readInt16LE(4), amounts = buf.readInt16LE(6);
const xCount = buf.readInt16LE(8), kCount = buf.readInt16LE(10), terms = buf.readInt16LE(12);
const normalFrom = buf.readFloatLE(14), xLow = buf.readFloatLE(18), xStep = buf.readFloatLE(22);
const kLow = buf.readFloatLE(26), kStep = buf.readFloatLE(30);
const per = xCount * kCount * terms, header = 34;
console.log({ magic, sets, amounts, xCount, kCount, terms, normalFrom, xLow, xStep, kLow, kStep, bytes: buf.length });
console.log('expect', header + amounts * 4 + sets * amounts * per * 4);

const values = [];
for (let i = 0; i < amounts; i++) values.push(buf.readFloatLE(header + i * 4));
console.log('amounts =', values.join(', '));

const start = header + amounts * 4;
const coeff = (s, a, i) => buf.readFloatLE(start + ((s * amounts + a) * per + i) * 4);

// 双线性混合两个已拟合档位；0 档视为「无变化」
function coeffsAt(amount, set) {
  const pts = values.map((v, i) => [v, i]).filter((p) => p[0] !== 0);
  pts.push([0, -1]);
  pts.sort((p, q) => p[0] - q[0]);
  const v = Math.min(pts[pts.length - 1][0], Math.max(pts[0][0], amount));
  let i = 0;
  while (i < pts.length - 2 && v > pts[i + 1][0]) i++;
  const [lo, loIdx] = pts[i], [hi, hiIdx] = pts[i + 1];
  const t = (v - lo) / (hi - lo);
  const out = [];
  for (let j = 0; j < per; j++) {
    const a = loIdx < 0 ? 0 : coeff(set, loIdx, j);
    const b = hiIdx < 0 ? 0 : coeff(set, hiIdx, j);
    out.push(a * (1 - t) + b * t);
  }
  return out;
}

const amt = Number(process.argv[3] || -30);
const set = Number(process.argv[4] || 1);
const c = coeffsAt(amt, set);
const plane = xCount * kCount;
console.log(`\namount ${amt} set ${set}: kCount=${kCount} xCount=${xCount}`);
for (let t = 0; t < terms; t++) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let j = 0; j < plane; j++) { const v = c[t * plane + j]; mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
  console.log(`term${t}: min ${mn.toFixed(3)} max ${mx.toFixed(3)} mean ${(sum / plane).toFixed(3)}`);
}
// 打印 term0 在 K=0（最暗参考）行的 x 曲线
const kRow = Number(process.argv[5] || 0);
for (let t = 0; t < 3; t++) {
  const row = [];
  for (let x = 0; x < xCount; x++) row.push(c[t * plane + kRow * xCount + x].toFixed(2));
  console.log(`term${t} k=${kRow}:`, row.join(' '));
}
