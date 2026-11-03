const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const releaseDir = path.join(root, "release");
const wipeAll = process.argv.includes("--all");

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
  process.exit(0);
}

const keepCurrentArtifact = (name) => {
  if (!/\.(dmg|zip|exe)$/i.test(name)) return false;
  return name.includes(`-${version}-`);
};

for (const name of fs.readdirSync(releaseDir)) {
  if (!wipeAll && keepCurrentArtifact(name)) continue;
  fs.rmSync(path.join(releaseDir, name), { recursive: true, force: true });
}

fs.mkdirSync(releaseDir, { recursive: true });
console.log(wipeAll ? `release/ wiped for ${version}` : `release/ pruned to ${version}`);
