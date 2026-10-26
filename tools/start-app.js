// 开发启动入口：npm run start:soft / npm run start:sw
//
// 不直接写 `electron .` 的两个原因：
//   1. 本机项目目录被下过 Deny ACE，node_modules 里的 electron.exe 建单实例锁文件会
//      ERROR_ACCESS_DENIED；项目外有一份同版本副本（%LOCALAPPDATA%\qfs-electron），
//      优先用它就能绕开。start.bat 的 :pick_electron 是同一套判断。
//   2. 之前 start:soft 用 `--disable-gpu`：它解决不了 GPU 崩溃（Electron 31 仍会拉起
//      GPU 进程），只会把合成器降成软件渲染——预设墙拖动在软件路径上实测慢约 9 倍。
//      这里默认走硬件路径，真遇到 GPU 崩溃再用 `npm run start:sw`（swiftshader）。
//
// 退出码原样透传：单实例被拒绝时主进程退出码是 1，npm / 脚本才能区分
// "没启动" 和 "正常关闭"。输出只用 ASCII，避免 GBK 控制台把提示显示成乱码。
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FLAGS = ['--no-sandbox']; // 本机 profile 的锁文件需要（见 start.bat 头部说明）

function candidates() {
    const list = [];
    const env = (process.env.QF_ELECTRON_BIN || '').trim();
    if (env) list.push({ bin: env, from: 'QF_ELECTRON_BIN' });
    const local = path.join(process.env.LOCALAPPDATA || '', 'qfs-electron', 'dist', 'electron.exe');
    if (fs.existsSync(local)) list.push({ bin: local, from: 'local copy' });
    try { list.push({ bin: require('electron'), from: 'node_modules' }); } catch (_) { /* 没装就跳过 */ }
    return list.filter((c) => c.bin);
}

function flags() {
    const env = (process.env.QF_ELECTRON_FLAGS || '').trim();
    if (env) return env.split(/\s+/).filter(Boolean);
    return process.argv.includes('--sw')
        ? ['--use-gl=swiftshader'].concat(DEFAULT_FLAGS)
        : DEFAULT_FLAGS.slice();
}

function launch(list, index, electronArgs) {
    if (index >= list.length) {
        console.error('[qingframe] no usable Electron binary found. Run "npm ci", or set QF_ELECTRON_BIN.');
        process.exit(1);
    }
    const { bin, from } = list[index];
    console.log('[qingframe] electron: ' + bin + ' (' + from + ')');
    console.log('[qingframe] flags: ' + electronArgs.join(' '));
    const child = spawn(bin, electronArgs, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
    let spawned = false;
    child.on('spawn', () => { spawned = true; });
    child.on('error', (err) => {
        if (spawned) {
            console.error('[qingframe] electron failed: ' + err.message);
            process.exit(1);
        }
        console.error('[qingframe] cannot start ' + bin + ': ' + err.message);
        launch(list, index + 1, electronArgs);
    });
    child.on('close', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}

// 除 --sw 之外的参数原样交给应用（例如 --user-data-dir=...）
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--sw');
launch(candidates(), 0, flags().concat(['.'], passthrough));
