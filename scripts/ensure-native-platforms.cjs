#!/usr/bin/env node
/**
 * Pre-download every native binary we ship in release builds.
 * Host-only optional installs are not enough for electron-builder multi-arch.
 * npm needs explicit --os/--cpu to fetch foreign platform packages.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.PHOTO_CLASSIFIER_SKIP_NATIVE === "1") {
  process.exit(0);
}

const root = path.join(__dirname, "..");
const sharpVer = require(path.join(root, "node_modules/sharp/package.json")).version;
const canvasVer = require(path.join(root, "node_modules/@napi-rs/canvas/package.json")).version;
const libvipsVer =
  require(path.join(root, "node_modules/sharp/package.json")).optionalDependencies[
    "@img/sharp-libvips-darwin-arm64"
  ];

const batches = [
  {
    os: "darwin",
    cpu: "arm64",
    packages: [
      `@img/sharp-darwin-arm64@${sharpVer}`,
      `@img/sharp-libvips-darwin-arm64@${libvipsVer}`,
      `@napi-rs/canvas-darwin-arm64@${canvasVer}`
    ]
  },
  {
    os: "darwin",
    cpu: "x64",
    packages: [
      `@img/sharp-darwin-x64@${sharpVer}`,
      `@img/sharp-libvips-darwin-x64@${libvipsVer}`,
      `@napi-rs/canvas-darwin-x64@${canvasVer}`
    ]
  },
  {
    os: "win32",
    cpu: "x64",
    packages: [
      `@img/sharp-win32-x64@${sharpVer}`,
      `@napi-rs/canvas-win32-x64-msvc@${canvasVer}`
    ]
  },
  {
    os: "win32",
    cpu: "arm64",
    packages: [
      `@img/sharp-win32-arm64@${sharpVer}`,
      `@napi-rs/canvas-win32-arm64-msvc@${canvasVer}`
    ]
  }
];

const requiredDirs = [
  "node_modules/@img/sharp-darwin-arm64",
  "node_modules/@img/sharp-darwin-x64",
  "node_modules/@img/sharp-win32-x64",
  "node_modules/@img/sharp-win32-arm64",
  "node_modules/@img/sharp-libvips-darwin-arm64",
  "node_modules/@img/sharp-libvips-darwin-x64",
  "node_modules/@napi-rs/canvas-darwin-arm64",
  "node_modules/@napi-rs/canvas-darwin-x64",
  "node_modules/@napi-rs/canvas-win32-x64-msvc",
  "node_modules/@napi-rs/canvas-win32-arm64-msvc"
];

function alreadyReady() {
  return requiredDirs.every((dir) => fs.existsSync(path.join(root, dir)));
}

if (alreadyReady()) {
  console.log("Native platform packages already present.");
  process.exit(0);
}

for (const batch of batches) {
  console.log(`Fetching native packages for ${batch.os}-${batch.cpu}…`);
  const result = spawnSync(
    "npm",
    [
      "install",
      "--no-save",
      "--include=optional",
      `--os=${batch.os}`,
      `--cpu=${batch.cpu}`,
      ...batch.packages
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, PHOTO_CLASSIFIER_SKIP_NATIVE: "1" }
    }
  );
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const missing = requiredDirs.filter((dir) => !fs.existsSync(path.join(root, dir)));
if (missing.length) {
  console.error("Missing native packages after install:\n ", missing.join("\n  "));
  process.exit(1);
}

console.log("Native platform packages ready.");
