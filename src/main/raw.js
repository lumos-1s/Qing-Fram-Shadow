'use strict';

// RAW 解码与显影（主进程侧）。
//
// 分工：
//   · 本文件负责调度、磁盘缓存、把像素交给 Electron 编成 JPEG；
//   · 真正的解码在一条常驻 worker 线程里（libraw-wasm），主进程不会被 2 秒的解码卡住；
//   · 色调映射在 raw-tonemap.js，纯函数，可在纯 node 下单独验证。
//
// 缓存键包含「文件 mtime + 参数」，所以同一张图反复拖滑块只要参数回过一次就直接命中；
// 换机身/换镜头不影响，换文件内容（mtime 变）自然失效。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const tonemap = require('./raw-tonemap');

// 常见 RAW 扩展名。不求全（Phase One 的 IIQ、适马的 X3F 都在，但老 Kodak 之类没列），
// 目标是覆盖主流机身：索尼/佳能/尼康/富士/松下/奥林巴斯/宾得/徕卡/大疆。
const RAW_EXTS = [
    'arw', 'sr2', 'srf',              // Sony
    'cr2', 'cr3', 'crw',              // Canon
    'nef', 'nrw',                     // Nikon
    'raf',                            // Fujifilm
    'rw2', 'rwl',                     // Panasonic / Leica
    'orf',                            // Olympus
    'pef', 'dng',                     // Pentax / 通用
    'srw',                            // Samsung
    'x3f',                            // Sigma
    '3fr', 'fff',                     // Hasselblad
    'iiq',                            // Phase One
    'mos', 'mrw', 'raw', 'k25', 'kdc', 'mef', 'arq', 'erf', 'dcr'
];
const RAW_EXT_SET = new Set(RAW_EXTS.map((e) => '.' + e));

const isRaw = (p) => RAW_EXT_SET.has(path.extname(String(p || '')).toLowerCase());

// 解码库位置。开发时在 node_modules；打包后 wasm 与 worker 必须落在 asar 之外，
// 否则 ESM import 与 fs 读 wasm 在部分版本上会失败（见 package.json 的 asarUnpack）。
function librawDist() {
    const candidates = [
        // 打包后优先用 asar 外的那份：worker 线程不走主进程的 asar 补丁，
        // 直接 import app.asar 里的 ESM/wasm 会失败（见 package.json asarUnpack）。
        path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'libraw-wasm', 'dist'),
        path.join(__dirname, '..', '..', 'node_modules', 'libraw-wasm', 'dist'),
        path.join(process.resourcesPath || '', 'app.asar', 'node_modules', 'libraw-wasm', 'dist')
    ];
    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, 'libraw.wasm'))) return dir;
        } catch (e) { /* 继续找下一个 */ }
    }
    return candidates[0];
}

// worker 里 require 的色调映射模块也要放在 asar 外：worker_threads 里没有
// Electron 的 asar fs 补丁，app.asar/src/main/raw-tonemap.js 在打包后读不到。
function tonemapPath() {
    const unpacked = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'src', 'main', 'raw-tonemap.js');
    try {
        if (fs.existsSync(unpacked)) return unpacked;
    } catch (e) { /* 开发环境继续用源码路径 */ }
    return path.join(__dirname, 'raw-tonemap.js');
}

// worker 用 eval 字符串启动：避免 asar 里的 .js 能不能被 worker_threads 加载这种环境问题。
// 线程里只做三件事：载入 wasm、解码、缩放 + 套表，然后把 BGRA 整块传回来（零拷贝转移）。
const WORKER_SRC = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const tm = require(workerData.tonemapPath);

let modPromise = null;
function getModule() {
    if (!modPromise) {
        modPromise = (async () => {
            const { pathToFileURL } = require('url');
            const { default: factory } = await import(pathToFileURL(workerData.dist + '/libraw.js').href);
            return factory({ wasmBinary: fs.readFileSync(workerData.dist + '/libraw.wasm') });
        })();
    }
    return modPromise;
}

// 串行执行：LibRaw 单实例解码本来就吃内存，并发只会让峰值翻倍还互相拖慢。
let tail = Promise.resolve();
function run(job) {
    const next = tail.then(() => handle(job), () => handle(job));
    tail = next.then(() => {}, () => {});
    return next;
}

async function handle(job) {
    const t0 = Date.now();
    let raw = null;
    try {
        const mod = await getModule();
        const buf = fs.readFileSync(job.file);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        raw = new mod.LibRaw();
        await raw.open(ab, {
            useCameraWb: true,
            noAutoBright: true,
            outputBps: 8,
            userQual: job.quality || 3,
            halfSize: !!job.halfSize,
            highlight: 0,
            // -1 = 按相机里的翻转标记输出。输出已经是正的，渲染层不能再按 EXIF Orientation 转一次。
            userFlip: -1
        });
        let meta = {};
        try { meta = (await raw.metadata()) || {}; } catch (e) { meta = {}; }
        const img = await raw.imageData();
        const sw = img.width;
        const sh = img.height;
        const ch = img.colors || 3;
        const total = sw * sh;
        const src = img.data;

        // 自动基线按原图算：裁切一块暗角不应该让整张照片的曝光跟着变。
        // 缩放后再算会受插值影响偏亮，所以也在缩放前。
        const gain = tm.autoGain(src, ch, total);
        // 裁切/旋转在缩放前做：代理图先从原图裁出目标区域再缩到 1600，
        // 不会先整图缩小再裁一次。裁切框是归一化坐标，代理/全尺寸共用。
        const view = tm.cropRotate(src, sw, sh, ch, job.crop, job.rotate);
        const vw = view.width;
        const vh = view.height;
        const vch = view.colors;
        let dw = vw;
        let dh = vh;
        if (job.maxEdge > 0) {
            const long = Math.max(vw, vh);
            if (long > job.maxEdge) {
                const k = job.maxEdge / long;
                dw = Math.max(1, Math.round(vw * k));
                dh = Math.max(1, Math.round(vh * k));
            }
        }
        const lut = tm.buildLut(job.params, gain);
        let pixels;
        let colors;
        if (dw !== vw || dh !== vh) {
            pixels = tm.resizeBox(view.data, vw, vh, dw, dh, vch);
            colors = 4;
        } else {
            pixels = view.data;
            colors = vch;
        }
        const bgra = tm.toBgra(pixels, colors, dw, dh, lut);
        parentPort.postMessage({
            id: job.id,
            ok: true,
            width: dw,
            height: dh,
            gain: gain,
            ms: Date.now() - t0,
            meta: {
                make: meta.make || meta.camera_make || '',
                model: meta.model || meta.camera_model || '',
                iso: meta.iso_speed || meta.ISO || 0,
                lens: meta.lens || meta.LensModel || '',
                shutter: meta.shutter || meta.exposure_time || 0,
                aperture: meta.aperture || meta.f_number || 0,
                focal: meta.focal_len || meta.focal_length || 0,
                timestamp: meta.timestamp ? String(meta.timestamp) : ''
            },
            bgra
        }, [bgra.buffer]);
    } catch (e) {
        parentPort.postMessage({ id: job.id, ok: false, error: String((e && e.message) || e) });
    } finally {
        try { if (raw && raw.dispose) raw.dispose(); } catch (e) { /* 忽略 */ }
    }
}

parentPort.on('message', (job) => { if (job && job.id != null) run(job); });
`;

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
}

function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { dist: librawDist(), tonemapPath: tonemapPath() },
        resourceLimits: { maxOldGenerationSizeMb: 2048 }
    });
    w.on('message', (m) => {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m);
        else p.reject(new Error(m.error || 'RAW 解码失败'));
    });
    w.on('error', (e) => {
        worker = null;
        failAll(e instanceof Error ? e : new Error(String(e)));
    });
    w.on('exit', () => {
        worker = null;
        failAll(new Error('RAW 解码线程已退出'));
    });
    // 线程不该拖住应用退出；有任务时 request 会自己保活。
    if (typeof w.unref === 'function') w.unref();
    worker = w;
    return w;
}

function decode(job) {
    const w = ensureWorker();
    return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, ...job });
    });
}

// ── 磁盘缓存 ────────────────────────────────────────────────────────────────
// 只缓存"解码结果"，不缓存用户照片编辑：参数变了就是另一个键，天然不会串味。
let cacheRoot = '';
function setCacheRoot(dir) { cacheRoot = dir; }
function cacheDir() {
    if (!cacheRoot) throw new Error('RAW 缓存目录未初始化');
    return cacheRoot;
}

function cacheKey(file, stat, params, maxEdge, view) {
    const h = crypto.createHash('sha1');
    h.update(String(file));
    h.update('|' + stat.size + '|' + Math.round(stat.mtimeMs));
    h.update('|' + JSON.stringify(params) + '|' + maxEdge);
    // 裁切/旋转也是显影参数的一部分：同一组滑块、不同裁切框必须分开缓存。
    h.update('|' + JSON.stringify(view || null));
    return h.digest('hex');
}

function readCache(key) {
    const jpg = path.join(cacheDir(), key + '.jpg');
    const side = path.join(cacheDir(), key + '.json');
    try {
        const buf = fs.readFileSync(jpg);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(side, 'utf8')); } catch (e) { /* 没 sidecar 也能用 */ }
        // 命中时把访问时间推一下，LRU 清理按 mtime 排队。
        const now = new Date();
        try { fs.utimesSync(jpg, now, now); } catch (e) { /* 只读盘就算了 */ }
        return { buf, meta, cached: true };
    } catch (e) {
        return null;
    }
}

function writeCache(key, buf, meta) {
    const dir = cacheDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ }
    const jpg = path.join(dir, key + '.jpg');
    const side = path.join(dir, key + '.json');
    // 先写临时名再 rename：解码过程中退出应用，也不会留下半张 JPEG 被当成缓存。
    try {
        const tmp = jpg + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, jpg);
        fs.writeFileSync(side, JSON.stringify(meta || {}));
    } catch (e) { /* 写不进缓存不影响这次显示 */ }
}

let pruneTimer = 0;
function pruneCache(limitBytes) {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => {
        pruneTimer = 0;
        try {
            const dir = cacheDir();
            const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg'));
            if (names.length <= 24) return;
            const files = names.map((n) => {
                const fp = path.join(dir, n);
                const st = fs.statSync(fp);
                return { fp, size: st.size, mtime: st.mtimeMs, side: fp.replace(/\.jpg$/, '.json') };
            }).sort((a, b) => a.mtime - b.mtime);
            let total = files.reduce((s, f) => s + f.size, 0);
            const cap = limitBytes || 900 * 1024 * 1024;
            let i = 0;
            while (total > cap && i < files.length - 8) {
                const f = files[i++];
                total -= f.size;
                try { fs.unlinkSync(f.fp); } catch (e) { /* 正在读就算了 */ }
                try { fs.unlinkSync(f.side); } catch (e) { /* 同上 */ }
            }
        } catch (e) { /* 清理失败不影响主流程 */ }
    }, 4000);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
}

// ── 对外接口 ────────────────────────────────────────────────────────────────

let encoder = null;
function jpegEncoder() {
    if (!encoder) encoder = require('electron').nativeImage;
    return encoder;
}

/**
 * 显影一张 RAW，返回 JPEG Buffer。
 * @param {string} file   RAW 文件路径
 * @param {object} opts   { params, maxEdge, quality, halfSize, cache }
 */
async function develop(file, opts) {
    const o = opts || {};
    const params = tonemap.normalize(o.params);
    // view 也要经过同一套裁剪：URL、草稿、旧版本都可能塞进越界值。
    const view = tonemap.normalizeView(o.crop, o.rotate);
    const maxEdge = Math.max(0, Number(o.maxEdge) || 0);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new Error('文件不存在：' + path.basename(file));

    const key = cacheKey(file, stat, params, maxEdge, view);
    if (o.cache !== false) {
        const hit = readCache(key);
        if (hit) return { jpg: hit.buf, meta: hit.meta, cached: true, width: hit.meta.width, height: hit.meta.height };
    }

    const res = await decode({
        file,
        params,
        maxEdge,
        quality: o.quality || 3,
        halfSize: !!o.halfSize,
        crop: view.crop,
        rotate: view.rotate
    });

    const img = jpegEncoder().createFromBitmap(Buffer.from(res.bgra.buffer, res.bgra.byteOffset, res.bgra.byteLength), {
        width: res.width,
        height: res.height
    });
    const jpg = img.toJPEG(maxEdge && maxEdge <= 2048 ? 90 : 93);
    const meta = {
        width: res.width,
        height: res.height,
        gain: Number(res.gain.toFixed(3)),
        camera: [res.meta.make, res.meta.model].filter(Boolean).join(' ').trim()
    };
    if (o.cache !== false) {
        writeCache(key, jpg, meta);
        pruneCache(o.cacheLimit);
    }
    return { jpg, meta, cached: false, width: res.width, height: res.height, ms: res.ms };
}

function dispose() {
    if (worker) {
        try { worker.terminate(); } catch (e) { /* 忽略 */ }
        worker = null;
    }
    failAll(new Error('RAW 解码线程已停止'));
}

module.exports = {
    RAW_EXTS,
    RAW_EXT_SET,
    isRaw,
    develop,
    dispose,
    setCacheRoot,
    cacheDir,
    _cacheKey: cacheKey
};
