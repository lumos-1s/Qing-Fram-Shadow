'use strict';
/*
 * 把 PoC 扩展装到本地 Photoshop 的 CEP 扩展目录，并打开未签名扩展调试模式。
 * 用法：npm run ps:poc:install
 * 需要：Photoshop 已安装；写入 Program Files 可能需要管理员权限。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_ID = 'com.qingframe.ps.bridge.poc';
const REG_KEY = 'HKCU\\Software\\Adobe\\CSXS.12';

function photoshopDirs() {
    const out = [];
    // 支持：npm run ps:poc:install -- --ps "D:\PS2026\Adobe Photoshop 2026"
    // 或环境变量 QF_PS_DIR
    const argIdx = process.argv.indexOf('--ps');
    const custom = (argIdx >= 0 && process.argv[argIdx + 1]) || process.env.QF_PS_DIR || '';
    if (custom) {
        if (!fs.existsSync(custom)) {
            console.error('指定的 Photoshop 目录不存在：' + custom);
            process.exit(1);
        }
        out.push(path.join(custom, 'Required', 'CEP', 'extensions'));
        return out;
    }
    const roots = ['C:\\Program Files\\Adobe', 'C:\\Program Files (x86)\\Adobe'];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        fs.readdirSync(root).forEach((name) => {
            if (/^Adobe Photoshop/i.test(name)) {
                const dir = path.join(root, name, 'Required', 'CEP', 'extensions');
                if (fs.existsSync(path.dirname(path.dirname(dir)))) out.push(dir);
            }
        });
    }
    return out;
}

function main() {
    const dirs = photoshopDirs();
    if (!dirs.length) {
        console.error('没找到 Photoshop 安装目录。请手动把 ps-plugin 整个目录拷到：');
        console.error('  <PS 安装目录>\\Required\\CEP\\extensions\\' + EXT_ID);
        process.exit(1);
    }
    const destRoot = dirs[0];
    const dest = path.join(destRoot, EXT_ID);
    try {
        fs.mkdirSync(destRoot, { recursive: true });
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(ROOT, dest, { recursive: true });
        console.log('已复制扩展 → ' + dest);
    } catch (e) {
        console.error('复制失败（可能需要管理员权限）：' + e.message);
        console.error('请手动复制到：' + dest);
        process.exit(1);
    }

    try {
        execFileSync('reg', ['add', REG_KEY, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'],
            { stdio: 'ignore' });
        console.log('已打开 CSXS.12 未签名扩展调试模式');
    } catch (e) {
        console.warn('设置注册表失败，请手动添加 ' + REG_KEY + ' 下的 PlayerDebugMode=1');
    }

    if (dirs.length > 1) console.log('检测到多个 Photoshop 版本，本次只装到第一个；其他目录：\n  ' + dirs.slice(1).join('\n  '));
    console.log('\n请重启 Photoshop，然后：窗口 → 扩展功能 → 清框影 PS 桥接 PoC');
}

main();
