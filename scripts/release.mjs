// Builds a signed MiColl installer + the latest.json the updater reads.
//
//   npm run release -- --version 0.1.1 --notes "What's new…" [--publish]
//
// Uploads: the installer, a signed portable zip (MiColl.exe + portable marker) and latest.json.
// Multi-line notes: use --notes-file, cmd cuts --notes at the first line break.
//
// --version   sets the version in tauri.conf.json, package.json and Cargo.toml.
//             Must be higher than the last one or the updater ignores it.
//             Leave it out to build the current version.
// --notes     text shown in the update prompt (or --notes-file <path>)
// --publish   uploads installer + latest.json as a GitHub release on araxos/MiColl
//             (with your gh login). Without it the command is only printed.
//
// Signing key: TAURI_SIGNING_PRIVATE_KEY, or else ~/.micoll/micoll-updater.key.
// Never put it in the repo. If it's lost, installed copies can't be updated anymore.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES_REPO = "araxos/MiColl";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const pkgPath = join(root, "package.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

/* ---- version ------------------------------------------------------------ */

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const wanted = opt("--version");
if (wanted !== undefined) {
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) die(`"${wanted}" isn't a version like 0.1.1`);
  const cmp = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  if (cmp(wanted, conf.version) <= 0)
    die(`${wanted} isn't higher than the current ${conf.version} — the updater would ignore it`);
  // only replace the version line so the files keep their formatting
  const bump = (path, re) => {
    const text = readFileSync(path, "utf8");
    if (!re.test(text)) die(`couldn't find the version in ${path}`);
    writeFileSync(path, text.replace(re, (m, pre) => `${pre}${wanted}"`));
  };
  bump(confPath, /("version":\s*")[^"]+"/);
  bump(pkgPath, /("version":\s*")[^"]+"/);
  bump(cargoPath, /^(version\s*=\s*")[^"]+"/m);
  conf.version = wanted;
  console.log(`release: version set to ${wanted}`);
}
const version = conf.version;

/* ---- notes -------------------------------------------------------------- */

const notesFile = opt("--notes-file");
const notes = (notesFile ? readFileSync(notesFile, "utf8") : opt("--notes") ?? "").trim();
if (!notes) console.warn("release: no --notes given — the update prompt will show none");

/* ---- signing key -------------------------------------------------------- */

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(homedir(), ".micoll", "micoll-updater.key");
  if (!existsSync(keyPath)) die(`no signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${keyPath}`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

/* ---- build -------------------------------------------------------------- */

// only the NSIS installer (that's what the updater runs). shell so npx works on Windows
const built = spawnSync("npx", ["tauri", "build", "--bundles", "nsis"], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.status !== 0) die("the build failed");

const outDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const setup = `${conf.productName}_${version}_x64-setup.exe`;
const setupPath = join(outDir, setup);
const sigPath = `${setupPath}.sig`;
if (!existsSync(setupPath) || !existsSync(sigPath))
  die(`expected ${setup} and its .sig in ${outDir}`);

/* ---- portable zip ------------------------------------------------------- */

// micoll.exe + the portable marker, so it runs without installing and keeps
// its data next to the exe
const exePath = join(root, "src-tauri", "target", "release", "micoll.exe");
if (!existsSync(exePath)) die(`expected ${exePath}`);
const portable = `${conf.productName}_${version}_x64-portable.zip`;
const portablePath = join(outDir, portable);
const stage = join(outDir, "portable", conf.productName);
rmSync(join(outDir, "portable"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(exePath, join(stage, "MiColl.exe"));
writeFileSync(join(stage, "micoll-portable.txt"), "This file makes MiColl portable: its data stays in this folder.\n");
rmSync(portablePath, { force: true });
const zipped = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}' -DestinationPath '${portablePath}'`],
  { stdio: "inherit" },
);
if (zipped.status !== 0 || !existsSync(portablePath)) die("couldn't make the portable zip");
console.log(`release: wrote ${portablePath}`);
// signed with the updater key, so portable copies can check it before swapping their exe
const signed = spawnSync("npx", ["tauri", "signer", "sign", portablePath], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const portableSig = `${portablePath}.sig`;
if (signed.status !== 0 || !existsSync(portableSig)) die("couldn't sign the portable zip");

/* ---- latest.json -------------------------------------------------------- */

const tag = `v${version}`;
const url = `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${setup}`;
const platform = { signature: readFileSync(sigPath, "utf8").trim(), url };
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": platform,
    "windows-x86_64-nsis": platform,
  },
};
const manifestPath = join(outDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`release: wrote ${manifestPath}`);

/* ---- publish ------------------------------------------------------------ */

const ghArgs = [
  "release",
  "create",
  tag,
  "--repo",
  RELEASES_REPO,
  "--title",
  `MiColl v${version}`,
  "--notes",
  notes || `MiColl v${version}`,
  setupPath,
  portablePath,
  portableSig,
  manifestPath,
];
if (flag("--publish")) {
  execFileSync("gh", ghArgs, { stdio: "inherit" });
  console.log(`release: published ${tag} on ${RELEASES_REPO}`);
} else {
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  console.log("\nTo publish:\n  gh " + ghArgs.map(q).join(" "));
}
