const fs = require('fs');
const path = require('path');
const https = require('https');
const { app, shell } = require('electron');

const REPO = { owner: 'kodama-dev2', repo: 'photo-classifier' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`;

function parseVersion(raw) {
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function platformAssetNeedle() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64.dmg' : 'mac-x64.dmg';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'win-arm64.zip' : 'win-x64.zip';
  }
  return null;
}

function normalizeAssetName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '.');
}

function pickAsset(assets) {
  const needle = platformAssetNeedle();
  if (!needle) return null;
  const want = needle.toLowerCase();
  return (assets || []).find((asset) => normalizeAssetName(asset.name).includes(want)) || null;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PhotoClassifier-Updater',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetJson(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl) => {
      const req = https.get(
        currentUrl,
        {
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': 'PhotoClassifier-Updater'
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download gagal (HTTP ${res.statusCode})`));
            return;
          }
          const total = Number(res.headers['content-length'] || 0);
          let received = 0;
          const out = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress) {
              onProgress({
                received,
                total,
                percent: total ? Math.round((received / total) * 100) : 0
              });
            }
          });
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(destPath)));
          out.on('error', reject);
          res.on('error', reject);
        }
      );
      req.on('error', reject);
    };
    follow(url);
  });
}

async function checkForUpdate() {
  const currentVersion = app.getVersion();
  const release = await httpsGetJson(API);
  const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
  const asset = pickAsset(release.assets || []);
  const newer = compareVersions(latestVersion, currentVersion) > 0;

  return {
    ok: true,
    currentVersion,
    latestVersion,
    newer,
    releaseUrl: release.html_url || null,
    asset: asset
      ? {
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size
        }
      : null,
    notes: release.body || ''
  };
}

async function downloadUpdate(onProgress) {
  const info = await checkForUpdate();
  if (!info.newer) {
    return { ok: true, skipped: true, reason: 'Sudah versi terbaru', ...info };
  }
  if (!info.asset) {
    return {
      ok: false,
      error: `Tidak ada file rilis untuk ${process.platform}-${process.arch}`,
      ...info
    };
  }

  const downloads = app.getPath('downloads');
  const destPath = path.join(downloads, info.asset.name);
  await downloadFile(info.asset.url, destPath, onProgress);
  await shell.openPath(destPath);

  return {
    ok: true,
    skipped: false,
    path: destPath,
    currentVersion: info.currentVersion,
    latestVersion: info.latestVersion,
    releaseUrl: info.releaseUrl
  };
}

module.exports = {
  checkForUpdate,
  downloadUpdate,
  compareVersions
};
