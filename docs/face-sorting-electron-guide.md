# Building a Reliable Electron App That Sorts Photos by Face

This guide explains how to build an Electron desktop app that reads faces from a folder of photos and moves each photo into a folder per person. It focuses on the decisions that make the app stable, because most failed attempts break on the same few issues.

## 1. Architecture

```
Renderer (UI only)  ──IPC──▶  Main process  ──▶  Worker thread (face detection)
   pick folders                 file dialogs        load models once
   show progress                job queue           detect + describe faces
   show results                 fs moves            return descriptors
```

- **Run face detection in Node, not in the renderer.** Use the main process or, better, a `worker_threads` worker started by the main process. The renderer stays responsive and never touches the filesystem directly.
- **Keep the renderer sandboxed.** Use `contextIsolation: true`, `nodeIntegration: false`, and expose only a few functions through a preload script with `contextBridge`.
- **Talk over IPC.** The renderer calls `ipcRenderer.invoke('scan', { inputDir, outputDir })`; the main process sends progress back with `webContents.send('progress', {...})`.

## 2. Library choice

Use **`@vladmandic/face-api`**, the actively maintained fork of `face-api.js`. It has the same API as `face-api.js` but works with current TensorFlow.js and Node versions. The original `face-api.js` package has not been updated in years and often fails to install or run with newer Electron and Node releases.

```bash
npm install @vladmandic/face-api @tensorflow/tfjs-node canvas
npm install --save-dev electron electron-builder @electron/rebuild
npx electron-rebuild
```

- `@tensorflow/tfjs-node` gives native CPU speed. If it will not build on a target machine, fall back to `@tensorflow/tfjs` (pure JS, slower) with `@vladmandic/face-api/dist/face-api.node-wasm.js`.
- `canvas` (or `sharp` plus manual tensor creation) is needed to decode images in Node.
- Run `electron-rebuild` after every install or Electron upgrade so native modules match Electron's Node ABI.

## 3. Load models locally, never download on each launch

Ship the model files inside the app instead of fetching them from a CDN.

1. Copy the needed models from `node_modules/@vladmandic/face-api/model/` into `resources/models/`:
   - `ssd_mobilenetv1_model.*` (detection)
   - `face_landmark_68_model.*` (landmarks)
   - `face_recognition_model.*` (128-number face descriptors)
2. Tell electron-builder to ship them outside the asar archive:

```json
"build": {
  "extraResources": [{ "from": "resources/models", "to": "models" }],
  "asarUnpack": ["**/node_modules/@tensorflow/**", "**/node_modules/canvas/**"]
}
```

3. Resolve the path the same way in development and in the packaged app:

```js
const path = require('path');
const { app } = require('electron');

const modelDir = app.isPackaged
  ? path.join(process.resourcesPath, 'models')
  : path.join(__dirname, '..', 'resources', 'models');
```

## 4. Load models in the `ready` event, once

```js
// main.js
const { app, BrowserWindow } = require('electron');
const { loadModels } = require('./face');

let modelsReady;

app.whenReady().then(async () => {
  modelsReady = loadModels(modelDir);   // start loading immediately
  createWindow();
  try {
    await modelsReady;
    win.webContents.send('models-status', 'ready');
  } catch (err) {
    win.webContents.send('models-status', `failed: ${err.message}`);
  }
});
```

```js
// face.js
const tf = require('@tensorflow/tfjs-node');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
faceapi.env.monkeyPatch({ Canvas: canvas.Canvas, Image: canvas.Image, ImageData: canvas.ImageData });

async function loadModels(dir) {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
}
module.exports = { loadModels, faceapi, tf, canvas };
```

Every scan job must `await modelsReady` before detecting, so no detection ever runs against a half-loaded model.

## 5. Wrap every file access in try/catch

One corrupted, truncated, or unsupported photo must never stop the whole run.

```js
async function describeFaces(filePath) {
  let tensor;
  try {
    const buf = await fs.promises.readFile(filePath);
    tensor = tf.node.decodeImage(buf, 3);           // throws on bad files
    const results = await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    return { ok: true, faces: results.map(r => r.descriptor) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tensor) tensor.dispose();                    // avoid memory leaks
  }
}
```

- Process files through a queue with a small concurrency (1 to 2) instead of `Promise.all` over thousands of photos.
- Log failures to an `errors.log` and put those photos in `_failed/` so the user can review them.
- Resize very large photos (for example to a longest side of 1600 px) before detection to save memory and time.

## 6. Classify and move files with `fs`

1. Collect one or more reference photos per person into `faceapi.LabeledFaceDescriptors`.
2. Build a matcher: `new faceapi.FaceMatcher(labeled, 0.5)` (lower threshold means stricter matching).
3. For each photo, match every detected face and pick the destination:
   - one known person goes to `output/<Name>/`
   - several known people go to each person's folder (copy) or `output/_group/`
   - faces found but none matched go to `output/_unknown/`
   - no face goes to `output/_no_face/`
4. Move safely:

```js
async function moveSafe(src, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(src));
  let n = 1;
  while (fs.existsSync(dest)) {                      // never overwrite
    const { name, ext } = path.parse(src);
    dest = path.join(destDir, `${name} (${n++})${ext}`);
  }
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {                      // different drive
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
    } else throw err;
  }
  return dest;
}
```

Offer a "copy instead of move" option and a dry-run preview, and keep a move log (source and destination) so a run can be undone.

Without reference photos, group faces automatically: compare descriptors with `faceapi.euclideanDistance` and put faces closer than about 0.5 into the same cluster, then let the user name each cluster.

## 7. Common pitfalls behind repeated failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| Works in dev, fails after build | Models or native modules packed inside asar, or wrong path | `extraResources`, `asarUnpack`, `process.resourcesPath` |
| `NODE_MODULE_VERSION` mismatch | Native module built for system Node, not Electron | `npx electron-rebuild` after every install or upgrade |
| `fetch is not defined` or models download from a URL | Using `loadFromUri` in Node | Use `loadFromDisk` with a local folder |
| UI freezes during scan | Detection in renderer or blocking the main thread | Move detection to a worker thread |
| App crashes on one photo | No try/catch around read and decode | Per-file try/catch and a `_failed/` folder |
| Memory grows until crash | Tensors never disposed, huge images | `tensor.dispose()` in `finally`, resize first, low concurrency |
| Sideways faces not detected | EXIF rotation ignored | Auto-rotate with `sharp().rotate()` before detection |
| HEIC or WebP photos fail | Decoder does not support the format | Convert with `sharp` (or skip and log) |
| Everyone matched as the same person | Threshold too loose or one weak reference photo | Threshold around 0.45 to 0.5, 3 to 5 references per person |
| Files lost or overwritten | Name collisions and `rename` across drives | Unique names and the `EXDEV` copy-then-delete fallback |
| Original `face-api.js` will not install | Package unmaintained, old tfjs pin | Use `@vladmandic/face-api` |

## 8. Suggested project layout

```
electron-face-sorter/
├─ resources/models/        # shipped model files
├─ src/main.js              # app lifecycle, IPC, file dialogs
├─ src/preload.js           # contextBridge API
├─ src/worker.js            # face detection worker
├─ src/face.js              # model loading and detection
├─ src/sorter.js            # matching and moveSafe
└─ src/renderer/            # UI
```
