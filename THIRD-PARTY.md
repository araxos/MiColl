# Third-party components

MiColl is built on other people's work. Their licenses are listed here. The full
license texts are in the [`licenses/`](licenses) folder, and every Rust crate and npm
package is in the generated [`src/assets/third-party-licenses.txt`](src/assets/third-party-licenses.txt).
The app shows the same file under **Settings → Version → Third-party licenses**.

## AI models

The models are not in the installer. MiColl downloads them the first time you use the
feature that needs them.

| Model | Used for | License |
| --- | --- | --- |
| [LaMa](https://github.com/advimman/lama) (ONNX export by [Carve](https://huggingface.co/Carve/LaMa-ONNX)) | Object remover in the editor | Apache-2.0 |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (`realesr-general-x4v3`) | Upscaling | BSD-3-Clause, Copyright (c) 2021 Xintao Wang |
| [IS-Net / DIS](https://github.com/xuebinqin/DIS) (`isnet-general-use`, via [rembg](https://github.com/danielgatis/rembg)) | Background removal | Code: Apache-2.0 |

The IS-Net weights come without a license statement of their own. They were trained on
the DIS5K dataset, which is for non-commercial use only.

## Runtime

| Component | License |
| --- | --- |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime), Copyright (c) Microsoft Corporation, built into the app through the [`ort`](https://github.com/pykeio/ort) crate | MIT |

## Fonts

| Font | License |
| --- | --- |
| [Exo 2](https://fonts.google.com/specimen/Exo+2) | SIL Open Font License 1.1 |
| [Orbitron](https://fonts.google.com/specimen/Orbitron) | SIL Open Font License 1.1 |
| [Zen Maru Gothic](https://fonts.google.com/specimen/Zen+Maru+Gothic) | SIL Open Font License 1.1 |
| [Unbounded](https://fonts.google.com/specimen/Unbounded), used as a narrowed copy ("Iri Unbounded Narrow", made with `scripts/make-iri-font.py`) | SIL Open Font License 1.1 |
| KDA, by [Bryan Torres](https://ko-fi.com/brylark) | CC BY-SA 4.0 |

MiColl Cut (the cyberpunk card font) is MiColl's own, made with `scripts/make-cut-font.py`.

## Rust crates and npm packages

Don't edit these by hand. After changing dependencies, run:

```
npm run licenses
```

This runs `cargo about generate` (config in `src-tauri/about.toml`) and
`license-checker --production` and writes `src/assets/third-party-licenses.txt`.
It needs `cargo install cargo-about --features cli` once.
