// 直接读 ACR 的 9×9 白平衡子表（差分解码后），把「灰轴对角线」在 tint / temp
// 两个方向上的逐通道响应打出来。目的：看清 G 通道在这根轴上比 LR 多走了多少，
// 从而决定修法（指数法 vs 换轴法）。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, '..', 'shared', 'acr', 'cr-tables.bin'));
const SIZE = raw.readUInt16LE(4);
const COUNT = raw.readUInt16LE(6);
const STEP = raw.readUInt16LE(8);
const planes = zlib.inflateSync(raw.slice(10));
const src = new Uint8Array(planes.buffer, planes.byteOffset, planes.byteLength);

const CELLS = SIZE * SIZE * SIZE;
const ENTRIES = CELLS * 3;
const level = [];
for (let i = 0; i < SIZE; i++) level.push(Math.round(i * 255 / (SIZE - 1)));

function decodeTable(t) {
  const out = new Uint8Array(ENTRIES);
  for (let ch = 0; ch < 3; ch++) {
    const base = (t * 3 + ch) * CELLS;
    let running = 0;
    for (let cell = 0; cell < CELLS; cell++) {
      running += (src[base + cell] << 24) >> 24;
      const axis = ch === 0 ? (cell / (SIZE * SIZE)) | 0
        : ch === 1 ? ((cell / SIZE) | 0) % SIZE : cell % SIZE;
      const v = level[axis] + running * STEP;
      out[cell * 3 + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

const cache = new Map();
function tbl(off) {
  if (!cache.has(off)) cache.set(off, decodeTable(off));
  return cache.get(off);
}
const cellOf = (i) => i * SIZE * SIZE + i * SIZE + i;
const at = (off, cell) => { const d = tbl(off); return [d[cell * 3], d[cell * 3 + 1], d[cell * 3 + 2]]; };
const wbOff = (row, col) => row * 9 + col;

const mid = (SIZE - 1) >> 1;
const mc = cellOf(mid);
const f = (v) => (v / 255).toFixed(4);

console.log('size', SIZE, 'count', COUNT, 'step', STEP, '格子中点 cell=' + mc, '值=' + (mc && (mid / (SIZE - 1) * 255).toFixed(0)));

console.log('\n【tint 轴】row=4(temp 0)，灰轴中点输出');
let base = at(wbOff(4, 4), mc);
console.log(' col tint     R       G       B      G/G0     B/B0     R/R0');
for (let c = 0; c < 9; c++) {
  const s = at(wbOff(4, c), mc);
  console.log('  ' + c + '  ' + String(-100 + c * 25).padStart(4) + '  ' +
    s.map(f).join('  ') + '  ' + (s[1] / base[1]).toFixed(4) + '  ' + (s[2] / base[2]).toFixed(4) + '  ' + (s[0] / base[0]).toFixed(4));
}

console.log('\n【temp 轴】col=4(tint 0)，灰轴中点输出');
console.log(' row temp     R       G       B      R/R0     G/G0     B/B0');
const tb = at(wbOff(4, 4), mc);
for (let r = 0; r < 9; r++) {
  const s = at(wbOff(r, 4), mc);
  console.log('  ' + r + '  ' + String(-100 + r * 25).padStart(4) + '  ' +
    s.map(f).join('  ') + '  ' + (s[0] / tb[0]).toFixed(4) + '  ' + (s[1] / tb[1]).toFixed(4) + '  ' + (s[2] / tb[2]).toFixed(4));
}

// 端点响应：是不是整根轴都按同一比例缩放？看暗端/亮端
console.log('\n【端点检验】tint 列的 G 增益在灰轴上的分布（相对 row=4,col=4）');
for (const c of [0, 2, 4, 6, 8]) {
  const row = [];
  for (let i = 0; i < SIZE; i += 4) {
    const s = at(wbOff(4, c), cellOf(i));
    const b0 = at(wbOff(4, 4), cellOf(i));
    row.push((s[1] / Math.max(1, b0[1])).toFixed(3));
  }
  console.log('  tint ' + String(-100 + c * 25).padStart(4) + '  G/G0 @i=0,4,8,12,16: ' + row.join(' '));
}
