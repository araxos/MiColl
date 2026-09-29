// Writes src/assets/third-party-licenses.txt, the license list the app shows under
// Settings -> Version. MIT/BSD need the notices inside the shipped app too, not only
// in the repo, so this file gets bundled.
//
//   npm run licenses
//
// Parts: the hand-listed stuff from licenses/ (models, ONNX Runtime, KDA font),
// then the npm packages (license-checker --production), then the Rust crates
// (cargo about, config in src-tauri/about.toml).
// Needs `cargo install cargo-about --features cli` once.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "assets", "third-party-licenses.txt");
const line = "=".repeat(80);

const run = (cmd, cwd = root) =>
  execSync(cmd, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const read = (p) => readFileSync(join(root, p), "utf8").trim();

function block(title, sub, text) {
  return `${line}\n${title}\n${sub ? sub + "\n" : ""}${line}\n\n${text.trim()}\n`;
}

// 1. hand-listed components (not a crate or npm package)
const manual = [
  ["ONNX Runtime (MIT)", "Built into the app through the ort crate.", "licenses/onnxruntime-MIT.txt"],
  ["LaMa inpainting model (Apache-2.0)", "https://github.com/advimman/lama", "licenses/Apache-2.0.txt"],
  [
    "Real-ESRGAN upscaling model (BSD-3-Clause)",
    "https://github.com/xinntao/Real-ESRGAN",
    "licenses/Real-ESRGAN-BSD-3-Clause.txt",
  ],
  [
    "IS-Net / DIS background removal (code: Apache-2.0)",
    "https://github.com/xuebinqin/DIS\nThe weights have no license statement of their own and were trained on the\nnon-commercial DIS5K dataset.",
    "licenses/Apache-2.0.txt",
  ],
  ["KDA font by Bryan Torres (CC BY-SA 4.0)", "https://ko-fi.com/brylark", "licenses/KDA-Font-CC-BY-SA-4.0.txt"],
].map(([title, sub, file]) => block(title, sub, read(file)));

// 2. npm packages that end up in the app
const npm = JSON.parse(run("npx --yes license-checker --production --json --excludePrivatePackages"));
const npmBlocks = Object.entries(npm)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([pkg, info]) => {
    const text = info.licenseFile ? readFileSync(info.licenseFile, "utf8") : "(no license file)";
    return block(`${pkg} (${[].concat(info.licenses).join(", ")})`, info.repository ?? "", text);
  });

// 3. Rust crates (cargo about groups crates with the same license text)
const rust = run("cargo about generate about.hbs", join(root, "src-tauri"));

const text = [
  "MiColl uses the following third-party software. Thanks to all of them!",
  "",
  "#".repeat(80) + "\n# Models, runtime and fonts\n" + "#".repeat(80),
  ...manual,
  "#".repeat(80) + "\n# npm packages\n" + "#".repeat(80),
  ...npmBlocks,
  "#".repeat(80) + "\n# Rust crates\n" + "#".repeat(80),
  rust.trim(),
  "",
].join("\n\n");

writeFileSync(out, text.replace(/\r\n/g, "\n"));
console.log(`wrote ${out} (${Math.round(text.length / 1024)} KB, ${npmBlocks.length} npm packages)`);
