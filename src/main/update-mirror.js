// 更新镜像：清单仍来自 GitHub（sha512 可信），只有**二进制下载地址**换成用户指定的镜像。
//
// 为什么这样拆分是安全的：electron-updater 的 latest.yml 由 GitHub 提供，里面有每个产物的
// sha512；改走镜像只是替换下载 URL，下载完仍按 GitHub 的 sha512 校验。镜像能做的坏事只剩
// "给一个对不上的文件"，而那种情况下校验会失败、文件被丢弃。
// 反过来，如果清单也从镜像取（旧版把整个 github.com 改写到 ghproxy），镜像就能同时伪造清单和
// 二进制，校验形同虚设 —— 那是这次去掉镜像的原因。
//
// 本模块刻意不依赖 electron，便于用 node 直接单测（tools/test-update-mirror.js）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const MAX_MIRROR_LEN = 2048;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 30000;

/** 镜像地址是否指向本机（测试用；只有本机才允许 http） */
function isLoopbackHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/**
 * 校验并规范化镜像串。
 * - 空串 → { ok: true, value: '' }（表示走 GitHub 直连）
 * - 必须是 http(s)；http 只允许回环地址（避免明文传输中间人替换）
 * - 允许两处占位：{url}（整条原始地址，会被 encodeURIComponent）
 * @returns {{ok: boolean, value: string, error?: string}}
 */
function normalizeMirror(raw) {
    if (raw == null) return { ok: true, value: '' };
    if (typeof raw !== 'string') return { ok: false, value: '', error: '镜像地址必须是字符串' };
    const s = raw.trim();
    if (!s) return { ok: true, value: '' };
    if (s.length > MAX_MIRROR_LEN) return { ok: false, value: '', error: '镜像地址过长' };
    if (/\s/.test(s)) return { ok: false, value: '', error: '镜像地址不能包含空格' };
    const probe = s.replace('{url}', encodeURIComponent('https://github.com/x/y'));
    let u;
    try { u = new URL(probe); } catch (_) { return { ok: false, value: '', error: '镜像地址不是合法 URL' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, value: '', error: '镜像地址必须以 http(s):// 开头' };
    if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return { ok: false, value: '', error: '出于安全，只有本机地址可以用 http' };
    return { ok: true, value: s };
}

/**
 * 把 GitHub 产物地址换成镜像地址。
 * 三种写法（按顺序匹配）：
 *   https://ghproxy.net/{url}     → {url} 原样替换（ghproxy 类要求原始地址，不能编码）
 *   https://x/{urlEnc}            → 编码后的整条地址（少数反代要求）
 *   https://cdn.example.com/      → 直接拼后缀（自建反代常见）
 */
function mirrorUrlFor(originalUrl, mirror) {
    const m = String(mirror || '').trim();
    if (!m) return originalUrl;
    if (m.includes('{urlEnc}')) return m.replace('{urlEnc}', encodeURIComponent(originalUrl));
    if (m.includes('{url}')) return m.replace('{url}', originalUrl);
    return m.replace(/\/+$/, '') + '/' + originalUrl;
}

function sha512Base64(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        const rs = fs.createReadStream(file);
        rs.on('data', (c) => hash.update(c));
        rs.on('error', reject);
        rs.on('end', () => resolve(hash.digest('base64')));
    });
}

/** 跟随重定向拿到最终响应（Node 的 http/https 不会自动跟） */
function openStream(url, redirectsLeft, onStart) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (_) { reject(new Error('下载地址不合法')); return; }
        const mod = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null);
        if (!mod) { reject(new Error('只支持 http(s) 下载')); return; }
        const req = mod.get(u, { headers: { 'User-Agent': 'qingframe-updater' } }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('重定向次数过多')); return; }
                resolve(openStream(new URL(res.headers.location, u).toString(), redirectsLeft - 1, onStart));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error('下载失败（HTTP ' + status + '）'));
                return;
            }
            onStart && onStart(res);
            resolve(res);
        });
        req.setTimeout(IDLE_TIMEOUT_MS, () => { req.destroy(new Error('下载超时（' + Math.round(IDLE_TIMEOUT_MS / 1000) + 's 无数据）')); });
        req.on('error', (e) => reject(e));
    });
}

/**
 * 下载到 dest（先写 .part，校验通过再 rename），边下边算 sha512。
 * @param {object} opts
 * @param {string} opts.url        最终下载地址（可以是镜像）
 * @param {string} opts.sha512     GitHub 清单里的 sha512（base64）
 * @param {string} opts.dest       落盘路径
 * @param {number} [opts.total]    期望大小（用于进度百分比，缺省用 content-length）
 * @param {(p:{transferred:number,total:number,percent:number,bytesPerSecond:number})=>void} [opts.onProgress]
 * @returns {Promise<{file:string, bytes:number}>}
 */
async function downloadVerified(opts) {
    const { url, sha512, dest, total } = opts || {};
    if (!url) throw new Error('缺少下载地址');
    if (!sha512) throw new Error('缺少校验值（清单不完整）');
    if (!dest) throw new Error('缺少落盘路径');

    const part = dest + '.part';
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try { await fs.promises.unlink(part); } catch (_) { /* 没有就算了 */ }

    const res = await openStream(url, MAX_REDIRECTS);
    const declared = Number(res.headers['content-length']) || Number(total) || 0;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(part);

    let transferred = 0;
    const startedAt = Date.now();
    const report = () => {
        if (typeof opts.onProgress !== 'function') return;
        const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
        opts.onProgress({
            transferred,
            total: declared,
            percent: declared ? Math.min(100, (transferred / declared) * 100) : 0,
            bytesPerSecond: transferred / secs
        });
    };

    await new Promise((resolve, reject) => {
        let lastTick = 0;
        res.on('data', (chunk) => {
            transferred += chunk.length;
            hash.update(chunk);
            const now = Date.now();
            if (now - lastTick > 200) { lastTick = now; report(); }
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.pipe(out);
    }).catch(async (e) => {
        try { await fs.promises.unlink(part); } catch (_) { /* ignore */ }
        throw e;
    });

    report();
    const actual = hash.digest('base64');
    if (actual !== String(sha512)) {
        try { await fs.promises.unlink(part); } catch (_) { /* ignore */ }
        throw new Error('校验失败：文件与 GitHub 清单不符（镜像可能被替换），已丢弃');
    }
    await fs.promises.rename(part, dest);
    return { file: dest, bytes: transferred };
}

/** GitHub Releases 里某个产物的原始地址 */
function releaseAssetUrl({ owner, repo, version, file }) {
    const tag = String(version || '').startsWith('v') ? version : 'v' + version;
    return 'https://github.com/' + owner + '/' + repo + '/releases/download/' + tag + '/' + encodeURIComponent(file);
}

module.exports = { normalizeMirror, mirrorUrlFor, downloadVerified, releaseAssetUrl, sha512Base64 };
