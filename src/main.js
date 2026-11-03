const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { listPhotos, classifyPhotos, mergeClusters, applyMoves, undoMoves } = require('./sorter');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pcimg',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
]);

let win;
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

function modelDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(__dirname, '..', 'resources', 'models');
}

function sendStatus(state, message) {
  modelStatus = { state, message };
  if (win && !win.isDestroyed()) {
    win.webContents.send('models-status', modelStatus);
  }
}

function sendProgress(data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress', data);
  }
}

function createWorker() {
  modelsReady = new Promise((resolve, reject) => {
    modelsReadyResolve = resolve;
    modelsReadyReject = reject;
  });

  worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { modelDir: modelDir() }
  });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      sendStatus('ready', msg.backend === 'node' ? 'Model siap' : 'Model siap (CPU)');
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

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 860,
    minHeight: 680,
    backgroundColor: '#e8ecf1',
    title: 'Photo Classifier',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  protocol.handle('pcimg', (request) => {
    try {
      const parsed = new URL(request.url);
      const filePath = decodeURIComponent(parsed.searchParams.get('p') || '');
      if (!filePath || !path.isAbsolute(filePath)) {
        return new Response('Bad path', { status: 400 });
      }
      return net.fetch(pathToFileURL(filePath).href);
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }
  });
  createWorker();
  createWindow();
  modelsReady.catch(() => {});
});

app.on('window-all-closed', () => {
  if (worker) worker.terminate();
  app.quit();
});

ipcMain.handle('models-status', () => modelStatus);

ipcMain.handle('pick-dir', async (_event, { title }) => {
  const result = await dialog.showOpenDialog(win, {
    title: title || 'Pilih folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('cancel', () => {
  cancelRequested = true;
  return true;
});

ipcMain.handle('reveal', async (_event, targetPath) => {
  if (!targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

async function loadReferences(referenceDir) {
  if (!referenceDir) return [];
  const entries = await fs.promises.readdir(referenceDir, { withFileTypes: true });
  const people = [];
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  let current = 0;
  for (const entry of dirs) {
    const personDir = path.join(referenceDir, entry.name);
    const photos = await listPhotos(personDir);
    const descriptors = [];
    for (const filePath of photos) {
      if (cancelRequested) break;
      const result = await describeFile(filePath);
      if (result.ok) descriptors.push(...result.faces);
      current += 1;
      sendProgress({
        phase: 'references',
        current,
        total: Math.max(photos.length, 1),
        file: filePath,
        person: entry.name
      });
    }
    if (descriptors.length) {
      people.push({ name: entry.name, descriptors });
    }
  }
  return people;
}

ipcMain.handle('scan', async (_event, options) => {
  if (busy) return { ok: false, error: 'Pekerjaan lain masih berjalan' };
  busy = true;
  cancelRequested = false;
  lastPlan = null;
  lastFileResults = [];
  lastReferences = [];
  lastOutputDir = options.outputDir || null;

  try {
    await modelsReady;
    if (!options.inputDir) return { ok: false, error: 'Folder sumber belum dipilih' };

    sendProgress({ phase: 'list', current: 0, total: 1, file: options.inputDir });
    const files = await listPhotos(options.inputDir, options.outputDir);
    if (!files.length) {
      lastPlan = classifyPhotos([], options);
      return { ok: true, cancelled: false, plan: lastPlan };
    }

    lastReferences = await loadReferences(options.referenceDir || null);
    if (cancelRequested) return { ok: true, cancelled: true, plan: null };

    const results = [];
    for (let i = 0; i < files.length; i += 1) {
      if (cancelRequested) break;
      const result = await describeFile(files[i]);
      results.push(result);
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

    return { ok: true, cancelled: cancelRequested, plan: lastPlan };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
});

ipcMain.handle('reclassify', async (_event, options) => {
  if (!lastFileResults.length) return { ok: false, error: 'Belum ada hasil pindai' };
  lastPlan = classifyPhotos(lastFileResults, {
    threshold: options.threshold,
    groupMode: options.groupMode,
    references: lastReferences
  });
  return { ok: true, plan: lastPlan };
});

ipcMain.handle('merge-clusters', async (_event, options) => {
  if (!lastPlan) return { ok: false, error: 'Belum ada hasil pindai' };
  const result = mergeClusters(lastPlan, options.clusterIds || [], options.name || '');
  if (result.ok) lastPlan = result.plan;
  return result;
});

ipcMain.handle('rename-cluster', async (_event, options) => {
  if (!lastPlan) return { ok: false, error: 'Belum ada hasil pindai' };
  const cluster = lastPlan.clusters.find((item) => item.id === options.clusterId);
  if (!cluster) return { ok: false, error: 'Orang tidak ditemukan' };
  cluster.name = String(options.name || '').trim() || cluster.name;
  lastPlan = { ...lastPlan, clusters: lastPlan.clusters.slice() };
  return { ok: true, plan: lastPlan };
});

ipcMain.handle('apply', async (_event, options) => {
  if (busy) return { ok: false, error: 'Pekerjaan lain masih berjalan' };
  if (!lastPlan) return { ok: false, error: 'Belum ada hasil pindai' };
  if (!options.outputDir) return { ok: false, error: 'Folder tujuan belum dipilih' };

  busy = true;
  try {
    const namedClusters = lastPlan.clusters.map((cluster) => ({
      ...cluster,
      name: options.clusterNames?.[cluster.id] || cluster.name
    }));
    const plan = { ...lastPlan, clusters: namedClusters };
    lastOutputDir = options.outputDir;
    lastLog = await applyMoves(plan, {
      outputDir: options.outputDir,
      action: options.action
    }, sendProgress);
    return { ok: true, log: lastLog };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
});

ipcMain.handle('undo', async () => {
  if (!lastLog) return { ok: false, error: 'Tidak ada pekerjaan yang bisa diurungkan' };
  if (busy) return { ok: false, error: 'Pekerjaan lain masih berjalan' };
  busy = true;
  try {
    const result = await undoMoves(lastLog);
    lastLog = null;
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
});
