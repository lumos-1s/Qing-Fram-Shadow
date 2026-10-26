把要用于预设墙封面的照片放在这个目录里，文件名直接用分类名：

    个性.jpg
    艺术.webp
    氛围.png
    复古.jpg
    ...

支持 jpg / jpeg / png / webp。目录里没有的任意分类，继续使用
tools/preset-wall.config.json 里 tagSamples 指定的默认示例图。

放好后重新生成封面（需要关闭正在运行的应用吗？不需要，生成器是独立进程）：

    npm run gen:wall

想临时换一批照片、又不想提交到仓库，也可以直接指定目录：

    node tools/run-electron.js tools/gen-preset-wall.js --samples D:\photos\wall

生成结果：
    src/renderer/assets/preset-wall/covers/*.webp
    src/renderer/assets/preset-wall/preset-wall-data.js

只想换某一两张预设的封面、不想重新生成时，把图片放进应用数据目录下的
wall-covers/<预设名>.webp（应用启动页点「换封面」会打开这个目录），重启应用即生效。
