// 统一给 Electron 测试补上必需的命令行开关。
//
// 之前 package.json 里所有用例都是裸 `electron tools/xxx.js`,在这台机器上第一个用例
// (test:brand)就直接死在启动阶段:
//   ERROR:gpu_process_host.cc GPU process launch failed: error_code=18
//   FATAL:gpu_data_manager_impl_private.cc(449)] GPU process isn't usable. Goodbye.
// 于是 `npm test` 整条 && 链在第 8 个脚本就断了 —— 也就是说这个"能跑全量测试"的命令
// 从来没被真正跑通过,后面的用例是否有效根本没被验证过。
//
// 开关放在脚本路径**之前**,确保由 Electron 自己解析(放后面依赖 Chromium 兜底解析 argv)。
// 开关只影响测试进程,不碰 npm start / 打包后的应用。
const { spawn } = require('child_process');

const SWITCHES = [
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--no-sandbox'
];

// 允许整组替换开关：不同环境对 GPU 的耐受度差很多（本机 --disable-gpu 会 segfault，
// 换成 --use-gl=swiftshader 才起得来；CI 上又是另一套）。示例：
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" npm run test:wall
const envFlags = (process.env.QF_ELECTRON_FLAGS || '').trim();
const switches = envFlags ? envFlags.split(/\s+/).filter(Boolean) : SWITCHES;

// 允许换二进制：本机 node_modules/electron 那份起不来（start.bat 里记过：
// 项目目录被下过 Deny ACE，electron.exe 拿不到文件权限），但外面有一份同样版本的副本。
// CI 上不需要设，npm ci 装出来的就是好的。
const envBin = (process.env.QF_ELECTRON_BIN || '').trim();
const electron = envBin || require('electron');

const args = process.argv.slice(2);
if (!args.length) {
    console.error('用法: node tools/run-electron.js <script.js> [额外参数...]');
    process.exit(2);
}

const child = spawn(electron, [...switches, ...args], { stdio: 'inherit', windowsHide: true });
child.on('close', (code, signal) => {
    // 被信号打断时也必须以非 0 退出,否则 npm 的 && 链会把"崩了"当成"通过"。
    process.exit(code === null ? (signal ? 1 : 1) : code);
});
child.on('error', (err) => {
    console.error('启动 Electron 失败:', err && err.message);
    process.exit(1);
});