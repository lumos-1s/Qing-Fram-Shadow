'use strict';
// 调色预设的磁盘存储：userData/grade-presets/<名称>.json
//
// 与「样式模板」分开存：
//   · 模板是整帧外观（边框 + 文字 + Logo），体积可以到几十 MB，含 base64 图片；
//   · 调色预设只保存全局调色参数（不含蒙版），通常几 KB，可以频繁读写、方便分享。
// 文件名就是预设名，保存/重命名/删除都先经过 safeLeafName，杜绝 ../ 越界。
const fs = require('fs');
const path = require('path');
const { safeLeafName } = require('./export-path');

// 调色参数在 UI 上是有限个滑块 + 曲线点，正常远小于 512KB；
// 留 4MB 余量，同时防止被构造的分享码撑爆主进程内存。
const MAX_BYTES = 4 * 1024 * 1024;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function list(dir) {
    try {
        ensureDir(dir);
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort((a, b) => a.localeCompare(b, 'zh'));
    } catch (_) {
        return [];
    }
}

function load(dir, name) {
    const safe = safeLeafName(name, '');
    if (!safe) return null;
    try {
        const file = path.join(dir, safe + '.json');
        if (!fs.existsSync(file)) return null;
        if (fs.statSync(file).size > MAX_BYTES) return null;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (_) {
        return null;
    }
}

function save(dir, name, data) {
    const safe = safeLeafName(name, '');
    if (!safe) return { ok: false, error: '预设名称不合法' };
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: '预设内容无效' };
    }
    if (!data.grade || typeof data.grade !== 'object' || Array.isArray(data.grade)) {
        return { ok: false, error: '预设缺少调色参数' };
    }
    try {
        ensureDir(dir);
        // 文件名可能被 safeLeafName 改过（Windows 保留名 / 末尾点空格），
        // 文件内的显示名同步成实际文件名，避免列表显示的名字和磁盘对不上。
        data.name = safe;
        const json = JSON.stringify(data, null, 2);
        if (Buffer.byteLength(json, 'utf-8') > MAX_BYTES) {
            return { ok: false, error: '调色预设超过 4MB，已拒绝保存' };
        }
        fs.writeFileSync(path.join(dir, safe + '.json'), json, 'utf-8');
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function remove(dir, name) {
    const safe = safeLeafName(name, '');
    if (!safe) return { ok: false, error: '预设名称不合法' };
    try {
        const file = path.join(dir, safe + '.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function rename(dir, oldName, newName) {
    const fromName = safeLeafName(oldName, '');
    const toName = safeLeafName(newName, '');
    if (!fromName || !toName) return { ok: false, error: '预设名称不合法' };
    if (fromName === toName) return { ok: true };
    const from = path.join(dir, fromName + '.json');
    const to = path.join(dir, toName + '.json');
    try {
        if (!fs.existsSync(from)) return { ok: false, error: '源预设不存在' };
        if (fs.existsSync(to)) return { ok: false, error: '已存在同名预设' };
        // 顺手把文件内的显示名改掉，避免重命名后列表仍显示旧名称。
        let data = null;
        try { data = JSON.parse(fs.readFileSync(from, 'utf-8')); } catch (_) { data = null; }
        if (data && typeof data === 'object') {
            data.name = toName;
            data.updatedAt = new Date().toISOString();
            ensureDir(dir);
            fs.writeFileSync(to, JSON.stringify(data, null, 2), 'utf-8');
            fs.unlinkSync(from);
        } else {
            fs.renameSync(from, to);
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

module.exports = { MAX_BYTES, list, load, save, remove, rename };
