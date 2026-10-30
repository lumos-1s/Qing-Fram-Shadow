# 第三方素材声明 · Third-Party Assets Notice

本文件说明「清框影 / Frame Studio」仓库中**哪些内容适用 MIT 许可、哪些不适用**。

This file explains which parts of the Qingframe / Frame Studio repository are covered by
the MIT License and which are not.

---

## 1. 代码适用 MIT

`src/` 下的全部源代码，以及仓库根目录的 `LICENSE`（MIT License,
Copyright (c) 2026 lumos-1s），适用 MIT 许可。

## 2. 品牌 Logo 图形不适用 MIT

`shared/brandlogos/` 目录中的全部图形文件**不在 MIT 许可范围内**，也不随本软件的
发行版一起分发（见 `package.json` 中 `build.files` 的 `!shared/brandlogos/**` 排除项）。

这些图形涉及的**商标权与美术作品著作权归各自权利人所有**
（Canon、Nikon、SONY、FUJIFILM、Leica、Hasselblad、RED、Apple、Samsung、Xiaomi 等，
详见该目录下的文件名）。

- 这些图形**仅用于在成品照片上标识该照片的拍摄设备**（依据照片 EXIF 中的品牌信息），
  属于对商标的指示性使用；
- 本软件为个人独立开发，**与上述任何品牌均无授权、合作、赞助或隶属关系**；
- 本软件**不代表**任何品牌方，也未获得任何品牌方的认可或授权；
- 该目录仅供**本地开发与个人使用**。如需对外分发含品牌 Logo 的版本，请自行取得
  相应权利人的许可，或移除该目录。

## 3. 纹理素材

`shared/textures/` 目录中的纹理素材**同样不在 MIT 许可范围内**，其权利归各自权利人
所有。该目录当前随发行版一起分发；如你计划公开发布本软件，建议一并核实这些素材的
来源与授权条款，或替换为可自由使用的素材。

## 4. 内置模板

`shared/presets/` 目录中的 80 个模板为本项目原创的 JSON 参数描述，适用 MIT 许可。
（模板中不内嵌任何第三方图形。）

---

## 3. ACR 实测查找表（`shared/acr/cr-tables.bin`）— MIT

`shared/acr/cr-tables.bin` 是 Photoshop「Camera Raw 滤镜」在各滑块各档位下
对 17³ 色格的实测输出表（763 张，zlib 重压缩）。原始数据来自开源项目
**Compositor**（https://github.com/robbietilton/Compositor ，Wonder Assembly LLC），
依 **MIT License** 发布；本仓库仅做格式转换（LZMA → zlib）与运行时解码
（`src/renderer/js/app-acr.js`），用于让调色管线与 Photoshop 的实测行为对齐。

依 MIT 许可要求，分发本软件时需保留上述出处与许可声明（见仓库根目录 `LICENSE`）。

---

## English Summary

- **Code** (`src/`, MIT License): free to use under the terms of `LICENSE`.
- **`shared/brandlogos/`**: trademarks and artwork belong to their respective owners.
  Not covered by the MIT License. Excluded from distributed builds via
  `build.files` (`!shared/brandlogos/**`). Provided for local development and personal
  use only — these marks are rendered solely to indicate the camera that took a photo,
  based on its EXIF metadata. This software is an independent personal project and is
  **not affiliated with, authorized by, sponsored by, or endorsed by** any of the brands
  referenced.
- **`shared/textures/`**: not covered by the MIT License; rights belong to their
  respective owners. Verify the source and licensing of these assets before public
  distribution.
- **`shared/presets/`**: original parameter descriptions by this project, MIT licensed.
- **`shared/acr/cr-tables.bin`**: measured Camera Raw color tables from the
  [Compositor](https://github.com/robbietilton/Compositor) project (MIT License,
  Copyright (c) 2026 Wonder Assembly LLC), repacked from LZMA to zlib. Used to align
  the grading pipeline with Photoshop's measured Camera Raw Filter behavior.

---

*本文件仅为素材归属说明，不构成法律意见。如需商用或公开分发，请咨询专业知识产权律师。*
