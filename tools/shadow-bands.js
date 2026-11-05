// 比较三张已落盘的整图：直方图尾部、高光裁切比例、区域亮度对照
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const dir = path.join(__dirname, 'out');
const files = { none: 'sh_none.jpg', spatial: 'sh_spatial.jpg', lr: 'sh_lr.jpg' };

const read = (f) => jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, maxMemoryUsageInMB: 4096 });
const imgs = {};
for (const [k, f] of Object.entries(files)) imgs[k] = read(f);
const W = imgs.lr.width, H = imgs.lr.height;
const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

const stat = (img) => {
  const d = img.data;
  const hist = new Float64Array(256);
  let n = 0, sum = 0, clip = 0, near = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = luma(d, i);
    hist[Math.min(255, Math.round(l))]++;
    sum += l; n++;
    if (d[i] >= 254 && d[i + 1] >= 254 && d[i + 2] >= 254) clip++;
    if (l >= 245) near++;
  }
  return { mean: +(sum / n).toFixed(1), clip: +(clip / n * 100).toFixed(2), near245: +(near / n * 100).toFixed(2), hist };
};

const S = {};
for (const k of Object.keys(imgs)) S[k] = stat(imgs[k]);
for (const k of Object.keys(S)) {
  console.log(k.padEnd(8), '均值', S[k].mean, '三通道全 255 占比', S[k].clip + '%', '亮度≥245', S[k].near245 + '%');
}

// 按 LR 的亮度分带，看各自的均值与像素占比
const bands = [[0, 32], [32, 64], [64, 96], [96, 128], [128, 160], [160, 192], [192, 224], [224, 256]];
const acc = bands.map(() => ({ n: 0, lr: 0, none: 0, sp: 0 }));
for (let i = 0; i < imgs.lr.data.length; i += 4) {
  const l = luma(imgs.lr.data, i);
  const bi = Math.min(bands.length - 1, (l / 32) | 0);
  const a = acc[bi];
  a.n++; a.lr += l;
  a.none += luma(imgs.none.data, i);
  a.sp += luma(imgs.spatial.data, i);
}
console.log('\n参照亮度带  像素占比   LR均值  去阴影   空间阴影   差(去阴影)  差(空间)');
bands.forEach((b, i) => {
  const a = acc[i];
  if (!a.n) return;
  const pct = (a.n / (W * H) * 100).toFixed(1) + '%';
  console.log((b[0] + '-' + b[1]).padEnd(10), pct.padStart(8),
    (a.lr / a.n).toFixed(1).padStart(9), (a.none / a.n).toFixed(1).padStart(9), (a.sp / a.n).toFixed(1).padStart(9),
    ((a.none - a.lr) / a.n).toFixed(1).padStart(11), ((a.sp - a.lr) / a.n).toFixed(1).padStart(9));
});
