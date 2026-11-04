#!/usr/bin/env node
/**
 * Local browser dev server with the real face-sorting pipeline.
 * Serves the renderer UI + JSON API so http://127.0.0.1:5179 works before Electron build.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { Worker } = require('worker_threads');

const {
  listPhotos,
  classifyPhotos,
  mergeClusters,
  applyMoves,
  undoMoves
} = require('../src/sorter');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT || 5179);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const sseClients = new Set();
let worker;
let modelStatus = { state: 'loading', message: 'Memuat model…' };
let modelsReady;
let modelsReadyResolve;
let modelsReadyReject;
let nextRequestId = 1;
const pending = new Map();

let busy = false;
let cancelRequested = false;
let lastFileResults = [];
let lastReferences = [];
let lastPlan = null;
let lastLog = null;
let lastOutputDir = null;

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function sendStatus(state, message) {
  modelStatus = { state, message };
  broadcast('models-status', modelStatus);
}

function sendProgress(data) {
  broadcast('progress', data);
}

function modelDir() {
  return path.join(ROOT, 'resources', 'models');
}

function createWorker() {
  modelsReady = new Promise((resolve, reject) => {
    modelsReadyResolve = resolve;
    modelsReadyReject = reject;
  });

  worker = new Worker(path.join(ROOT, 'src', 'worker.js'), {
    workerData: { modelDir: modelDir() }
  });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      const backendLabel =
        msg.backend === 'wasm' ? 'WASM' : msg.backend === 'node' ? 'native' : 'CPU';
      sendStatus('ready', `Dev local siap (${backendLabel})`);
      modelsReadyResolve();
      return;
    }
    if (msg.type === 'ready-error') {
      sendStatus('failed', msg.error);
      modelsReadyReject(new Error(msg.error));
      return;
    }
    if (msg.type === 'described') {
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      job.resolve({
        filePath: msg.filePath,
        ok: msg.ok,
        faces: msg.faces || [],
        error: msg.error || null
      });
    }
  });

  worker.on('error', (err) => {
    sendStatus('failed', err.message);
    if (modelsReadyReject) modelsReadyReject(err);
    for (const job of pending.values()) job.reject(err);
    pending.clear();
  });
}

function describeFile(filePath) {
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'describe', id, filePath });
  });
}

function pickDirNative(title) {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const prompt = String(title || 'Pilih folder').replace(/"/g, '\\"');
      execFile(
        'osascript',
        ['-e', `POSIX path of (choose folder with prompt "${prompt}")`],
        { encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            resolve({ ok: true, path: null, cancelled: true });
            return;
          }
          resolve({ ok: true, path: stdout.trim().replace(/\/$/, '') || null });
        }
      );
      return;
    }
    resolve({
      ok: false,
      error: 'Pilih folder native hanya di macOS. Jalankan Electron (`npm start`) atau set path manual lewat script.'
    });
  });
}

async function loadReferences(referenceDir) {
  if (!referenceDir) return [];
  const entries = await fs.promises.readdir(referenceDir, { withFileTypes: true });
  const people = [];
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  for (const entry of dirs) {
    const personDir = path.join(referenceDir, entry.name);
    const photos = await listPhotos(personDir);
    const descriptors = [];
    for (const filePath of photos) {
      if (cancelRequested) break;
      const result = await describeFile(filePath);
      if (result.ok) descriptors.push(...result.faces);
      sendProgress({
        phase: 'references',
        current: descriptors.length,
        total: Math.max(photos.length, 1),
        file: filePath,
        person: entry.name
      });
    }
    if (descriptors.length) people.push({ name: entry.name, descriptors });
  }
  return people;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

async function handleApi(req, res, urlPath) {
  if (urlPath === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: models-status\ndata: ${JSON.stringify(modelStatus)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (urlPath === '/api/models-status' && req.method === 'GET') {
    sendJson(res, 200, modelStatus);
    return;
  }

  if (urlPath === '/api/app-info' && req.method === 'GET') {
    sendJson(res, 200, {
      version: PKG.version,
      name: PKG.productName || PKG.name,
      packaged: false,
      platform: process.platform,
      arch: process.arch,
      mode: 'dev-browser'
    });
    return;
  }

  if (urlPath === '/api/check-update' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      currentVersion: PKG.version,
      latestVersion: PKG.version,
      newer: false,
      asset: null,
      notes: 'Update in-app tersedia di build Electron.'
    });
    return;
  }

  if (urlPath === '/api/download-update' && req.method === 'POST') {
    sendJson(res, 200, {
      ok: false,
      error: 'Download update hanya di app Electron. Dev browser untuk uji scan/apply.'
    });
    return;
  }

  if (urlPath === '/api/pick-dir' && req.method === 'POST') {
    const body = await readJson(req);
    sendJson(res, 200, await pickDirNative(body.title));
    return;
  }

  if (urlPath === '/api/cancel' && req.method === 'POST') {
    cancelRequested = true;
    sendJson(res, 200, true);
    return;
  }

  if (urlPath === '/api/reveal' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.targetPath) {
      sendJson(res, 200, false);
      return;
    }
    if (process.platform === 'darwin') {
      spawnSync('open', ['-R', body.targetPath]);
    } else if (process.platform === 'win32') {
      spawnSync('explorer', [`/select,${body.targetPath}`]);
    }
    sendJson(res, 200, true);
    return;
  }

  if (urlPath === '/api/scan' && req.method === 'POST') {
    if (busy) {
      sendJson(res, 200, { ok: false, error: 'Pekerjaan lain masih berjalan' });
      return;
    }
    const options = await readJson(req);
    busy = true;
    cancelRequested = false;
    lastPlan = null;
    lastFileResults = [];
    lastReferences = [];
    lastOutputDir = options.outputDir || null;

    try {
      await modelsReady;
      if (!options.inputDir) {
        sendJson(res, 200, { ok: false, error: 'Folder sumber belum dipilih' });
        return;
      }

      sendProgress({ phase: 'list', current: 0, total: 1, file: options.inputDir });
      const files = await listPhotos(options.inputDir, options.outputDir);
      if (!files.length) {
        lastPlan = classifyPhotos([], options);
        sendJson(res, 200, { ok: true, cancelled: false, plan: lastPlan });
        return;
      }

      lastReferences = await loadReferences(options.referenceDir || null);
      if (cancelRequested) {
        sendJson(res, 200, { ok: true, cancelled: true, plan: null });
        return;
      }

      const results = [];
      for (let i = 0; i < files.length; i += 1) {
        if (cancelRequested) break;
        results.push(await describeFile(files[i]));
        sendProgress({
          phase: 'detect',
          current: i + 1,
          total: files.length,
          file: files[i]
        });
      }

      lastFileResults = results;
      lastPlan = classifyPhotos(results, {
        threshold: options.threshold,
        groupMode: options.groupMode,
        references: lastReferences
      });
      sendJson(res, 200, { ok: true, cancelled: cancelRequested, plan: lastPlan });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    } finally {
      busy = false;
    }
    return;
  }

  if (urlPath === '/api/reclassify' && req.method === 'POST') {
    const options = await readJson(req);
    if (!lastFileResults.length) {
      sendJson(res, 200, { ok: false, error: 'Belum ada hasil pindai' });
      return;
    }
    lastPlan = classifyPhotos(lastFileResults, {
      threshold: options.threshold,
      groupMode: options.groupMode,
      references: lastReferences
    });
    sendJson(res, 200, { ok: true, plan: lastPlan });
    return;
  }

  if (urlPath === '/api/merge-clusters' && req.method === 'POST') {
    const options = await readJson(req);
    if (!lastPlan) {
      sendJson(res, 200, { ok: false, error: 'Belum ada hasil pindai' });
      return;
    }
    const result = mergeClusters(lastPlan, options.clusterIds || [], options.name || '');
    if (result.ok) lastPlan = result.plan;
    sendJson(res, 200, result);
    return;
  }

  if (urlPath === '/api/rename-cluster' && req.method === 'POST') {
    const options = await readJson(req);
    if (!lastPlan) {
      sendJson(res, 200, { ok: false, error: 'Belum ada hasil pindai' });
      return;
    }
    const cluster = lastPlan.clusters.find((item) => item.id === options.clusterId);
    if (!cluster) {
      sendJson(res, 200, { ok: false, error: 'Orang tidak ditemukan' });
      return;
    }
    cluster.name = String(options.name || '').trim() || cluster.name;
    lastPlan = { ...lastPlan, clusters: lastPlan.clusters.slice() };
    sendJson(res, 200, { ok: true, plan: lastPlan });
    return;
  }

  if (urlPath === '/api/apply' && req.method === 'POST') {
    if (busy) {
      sendJson(res, 200, { ok: false, error: 'Pekerjaan lain masih berjalan' });
      return;
    }
    const options = await readJson(req);
    if (!lastPlan) {
      sendJson(res, 200, { ok: false, error: 'Belum ada hasil pindai' });
      return;
    }
    if (!options.outputDir) {
      sendJson(res, 200, { ok: false, error: 'Folder tujuan belum dipilih' });
      return;
    }

    busy = true;
    try {
      const namedClusters = lastPlan.clusters.map((cluster) => ({
        ...cluster,
        name: options.clusterNames?.[cluster.id] || cluster.name
      }));
      const plan = { ...lastPlan, clusters: namedClusters };
      lastOutputDir = options.outputDir;
      lastLog = await applyMoves(
        plan,
        {
          outputDir: options.outputDir,
          action: options.action,
          skipClusterIds: options.skipClusterIds || []
        },
        sendProgress
      );
      sendJson(res, 200, { ok: true, log: lastLog });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    } finally {
      busy = false;
    }
    return;
  }

  if (urlPath === '/api/undo' && req.method === 'POST') {
    if (!lastLog) {
      sendJson(res, 200, { ok: false, error: 'Tidak ada pekerjaan yang bisa diurungkan' });
      return;
    }
    if (busy) {
      sendJson(res, 200, { ok: false, error: 'Pekerjaan lain masih berjalan' });
      return;
    }
    busy = true;
    try {
      const result = await undoMoves(lastLog);
      lastLog = null;
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    } finally {
      busy = false;
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function serveMedia(req, res, url) {
  const filePath = url.searchParams.get('p');
  if (!filePath || !path.isAbsolute(filePath)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
}

function injectDevClient(html) {
  let out = html;
  out = out.replace(
    /content="default-src 'self';[^"]*"/,
    `content="default-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self';"`
  );
  if (!out.includes('/dev-client.js')) {
    out = out.replace(
      '<script src="renderer.js"></script>',
      '<script src="/dev-client.js"></script>\n    <script src="renderer.js"></script>'
    );
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const urlPath = decodeURIComponent(url.pathname);

    if (urlPath.startsWith('/api/')) {
      await handleApi(req, res, urlPath);
      return;
    }

    if (urlPath === '/media') {
      serveMedia(req, res, url);
      return;
    }

    if (urlPath === '/dev-client.js') {
      const data = fs.readFileSync(path.join(__dirname, 'dev-client.js'));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(data);
      return;
    }

    let filePath = path.join(RENDERER, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(RENDERER)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      const html = injectDevClient(fs.readFileSync(filePath, 'utf8'));
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

createWorker();
modelsReady.catch(() => {});

server.listen(PORT, HOST, () => {
  console.log(`Photo Classifier DEV  http://${HOST}:${PORT}`);
  console.log(`Models: ${modelDir()}`);
  console.log('Scan includes all subfolders. Pick folders via native dialog (macOS).');
});
