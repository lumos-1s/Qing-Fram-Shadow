// 测量:导出链的编码/搬运开销 —— toDataURL(base64) vs toBlob → ArrayBuffer
// 用法:
//   node tools/run-electron.js tools/measure-export.js
//
// 背景(OPTIMIZATIONS.md「刻意没做」第 5 条):导出当前是「canvas → toDataURL(同步) →
// base64 字符串 → IPC 结构化克隆 → 主进程 Buffer.from(base64) → 写盘」。
// 改成 toBlob → arrayBuffer → Uint8Array 过 IPC 理论上省掉 base64 的 +33% 体积与一趟编解码,
// 但一直没量过,也担心 toBlob 与 toDataURL 的编码字节不同(静默丢 sRGB 标注)。
// 本工具就是那条「先量后改」:同一张画布两条路各跑一遍,给出耗时/体积/字节是否一致。
//
// 说明:测试进程带 --disable-gpu(run-electron.js 的固定开关),软件光栅下绝对耗时
// 比用户机器(GPU 合成)偏慢;这里看的是**两条路的相对差**,不是绝对吞吐。
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function finish(code) { app.exit(code || 0); }

// 主进程侧:模拟 write-export-files 里把 payload 变成 Buffer 的那一步
ipcMain.handle('bench-b64', (_e, { b64 }) => {
    const t0 = performance.now();
    const buf = Buffer.from(b64, 'base64');
    return { ms: Math.round((performance.now() - t0) * 10) / 10, bytes: buf.length };
});
ipcMain.handle('bench-bin', (_e, { arr }) => {
    const t0 = performance.now();
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    return { ms: Math.round((performance.now() - t0) * 10) / 10, bytes: buf.length };
});

const BENCH = `
(params) => (async () => {
  const { ipcRenderer } = require('electron');
  const W = params.W, H = params.H;

  function makeCanvas() {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#1d3f60'); grd.addColorStop(0.5, '#a8743c'); grd.addColorStop(1, '#2f6045');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const n = Math.min(40000, Math.round(W * H / 600));
    for (let i = 0; i < n; i++) {
      g.fillStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.2) + ')';
      g.fillRect(rnd() * W, rnd() * H, 3 + rnd() * 30, 3 + rnd() * 20);
    }
    g.fillStyle = '#ffffff'; g.font = 'bold ' + Math.round(W * 0.05) + 'px Arial';
    g.fillText('清框影 export bench', W * 0.04, H * 0.55);
    return cv;
  }

  const cv = makeCanvas();
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return Math.round(b[b.length >> 1] * 10) / 10; };
  const run = (f) => { const s = performance.now(); const r = f(); return { ms: performance.now() - s, r }; };

  cv.toDataURL('image/jpeg', 0.92); // 预热

  // ① toDataURL(同步,现状)
  let b64 = '', tData = [];
  for (let i = 0; i < params.reps; i++) { const x = run(() => cv.toDataURL('image/jpeg', 0.92)); b64 = x.r.split(',')[1]; tData.push(x.ms); }

  // ② toBlob(异步)
  let blob = null; const tBlob = [];
  for (let i = 0; i < params.reps; i++) {
    const s = performance.now();
    blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
    tBlob.push(performance.now() - s);
  }
  // arrayBuffer() 是把 blob 变成可过 IPC 的字节那一步,单独计时(先预热一次避免冷启动噪声)
  await blob.arrayBuffer();
  const s2 = performance.now();
  const ab = await blob.arrayBuffer();
  const arrayBufferMs = performance.now() - s2;

  // ③ 像素一致性:两条路各自解码后抽样比对(抓“编码器换了/丢了标注”这类静默差异)
  async function decodeHash(src) {
    const im = new Image();
    const url = (src instanceof Blob) ? URL.createObjectURL(src) : src;
    await new Promise((r) => { im.onload = r; im.onerror = r; im.src = url; });
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0, 256, 256);
    const d = g.getImageData(0, 0, 256, 256).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
    if (src instanceof Blob) URL.revokeObjectURL(url);
    return h;
  }
  const b64url = 'data:image/jpeg;base64,' + b64;
  const hData = await decodeHash(b64url);
  const hBlob = await decodeHash(blob);

  // ④ JPEG 标记清单:APP0(JFIF)/APP2(ICC_PROFILE) 等标注是否两条路一致
  function markersFrom(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = []; let off = 2;
    while (off + 4 <= u8.length) {
      if (u8[off] !== 0xFF) break;
      const m = u8[off + 1];
      if (m === 0xD8 || m === 0xD9) { off += 2; continue; }
      if (m === 0xDA) { out.push('SOS'); break; }
      const len = dv.getUint16(off + 2);
      if (m >= 0xE0 && m <= 0xEF) {
        const sig = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7], u8[off + 8]);
        out.push('APP' + (m - 0xE0) + ':' + sig + '(' + len + ')');
      } else out.push('FF' + m.toString(16).toUpperCase());
      off += 2 + len;
    }
    return out.join(' ');
  }
  function u8of(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  const mkData = markersFrom(u8of(b64));
  const mkBlob = markersFrom(new Uint8Array(ab));

  // ⑥ 字节级:两条路是否产生完全相同的字节(编码确定的前提下,等于"换路不改产物")
  const uD = u8of(b64), uB = new Uint8Array(ab);
  let firstDiff = -1, bytesEqual = uD.length === uB.length;
  if (bytesEqual) {
    for (let i = 0; i < uD.length; i++) if (uD[i] !== uB[i]) { bytesEqual = false; firstDiff = i; break; }
  } else firstDiff = Math.min(uD.length, uB.length);
  // 编码确定性:同一画布两次 toDataURL 是否逐字节一致
  const uD2 = u8of(cv.toDataURL('image/jpeg', 0.92).split(',')[1]);
  let detEqual = uD2.length === uD.length;
  if (detEqual) for (let i = 0; i < uD.length; i++) if (uD2[i] !== uD[i]) { detEqual = false; break; }

  // ⑤ IPC 往返(base64 字符串 vs Uint8Array 的结构化克隆 + 主进程落 Buffer)
  const u8 = new Uint8Array(ab);
  const s3 = performance.now();
  const ipcB64 = await ipcRenderer.invoke('bench-b64', { b64 });
  const ipcB64Ms = performance.now() - s3;
  const s4 = performance.now();
  const ipcBin = await ipcRenderer.invoke('bench-bin', { arr: u8 });
  const ipcBinMs = performance.now() - s4;

  return {
    W, H, mp: Math.round(W * H / 1e6 * 10) / 10,
    tData: med(tData), tBlob: med(tBlob),
    b64Chars: b64.length, b64MB: Math.round(b64.length / 1048576 * 10) / 10,
    blobBytes: blob.size, blobMB: Math.round(blob.size / 1048576 * 10) / 10,
    arrayBufferMs: Math.round(arrayBufferMs * 10) / 10,
    hashData: hData, hashBlob: hBlob, same: hData === hBlob && bytesEqual,
    bytesEqual, detEqual, firstDiff, uLengths: [uD.length, uB.length],
    mkData, mkBlob,
    ipcB64Ms: Math.round(ipcB64Ms * 10) / 10, ipcB64Decode: ipcB64.ms,
    ipcBinMs: Math.round(ipcBinMs * 10) / 10, ipcBinBytes: ipcBin.bytes
  };
})()
`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 900, height: 700, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false }
    });
    await win.loadURL('about:blank');
    console.log('导出链体检 · toDataURL(base64) vs toBlob(ArrayBuffer)  [q92, JPEG]');
    console.log('='.repeat(90));
    console.log('尺寸'.padEnd(14) + 'MP'.padStart(6) + 'toDataURL'.padStart(11) + 'toBlob'.padStart(9) + 'b64 MB'.padStart(9) + 'blob MB'.padStart(9) + 'base64 膨胀'.padStart(11) + '像素一致'.padStart(9) + '字节一致'.padStart(9));
    console.log('-'.repeat(100));
    const rows = [];
    for (const [W, H, reps] of [[6000, 4000, 2], [8192, 5461, 1]]) {
        const r = await win.webContents.executeJavaScript(`(${BENCH})(${JSON.stringify({ W, H, reps })})`).catch(e => ({ err: String((e && e.message) || e) }));
        if (r.err) { console.log('  运行失败: ' + r.err); finish(1); return; }
        rows.push(r);
        console.log((W + 'x' + H).padEnd(14) + String(r.mp).padStart(6) + (r.tData + 'ms').padStart(11) + (r.tBlob + 'ms').padStart(9) +
            String(r.b64MB).padStart(9) + String(r.blobMB).padStart(9) + (Math.round(r.b64Chars / Math.max(1, r.blobBytes) * 1000) / 1000 + 'x').padStart(11) +
            (r.hashData === r.hashBlob ? '是' : '否').padStart(9) + (r.bytesEqual ? '是' : '否@' + r.firstDiff).padStart(9));
    }
    console.log('='.repeat(100));
    console.log('编码确定性: 同一画布两次 toDataURL 逐字节一致 = ' + (rows.every(r => r.detEqual) ? '是' : '否'));
    for (const r of rows) if (!r.bytesEqual) console.log(`  [${r.W}x${r.H}] 两条路首个差异字节偏移 ${r.firstDiff},长度 ${r.uLengths.join(' vs ')}`);
    console.log('='.repeat(90));
    for (const r of rows) {
        console.log(`[${r.W}x${r.H}] JPEG 标注  toDataURL: ${r.mkData}`);
        console.log(`              toBlob   : ${r.mkBlob}`);
    }
    console.log('='.repeat(90));
    for (const r of rows) {
        console.log(`[${r.W}x${r.H}] arrayBuffer() ${r.arrayBufferMs}ms   IPC 往返: base64 ${r.ipcB64Ms}ms(主进程解码 ${r.ipcB64Decode}ms) vs Uint8Array ${r.ipcBinMs}ms`);
    }
    console.log('='.repeat(90));
    console.log('注:主进程侧对比的是「Buffer.from(base64)」与「Buffer.from(arrayBuffer)」的耗时;');
    console.log('    write-export-files 两步之后都还要过 exif-write(头部读 + 一次 concat),两条路完全一致。');
    finish(0);
}).catch(e => { console.error(e); process.exit(1); });
