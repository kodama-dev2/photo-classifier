const { parentPort, workerData } = require('worker_threads');
const { loadModels, describeFaces } = require('./face');

let queue = Promise.resolve();

(async () => {
  try {
    const backend = await loadModels(workerData.modelDir);
    parentPort.postMessage({ type: 'ready', backend });
  } catch (err) {
    parentPort.postMessage({ type: 'ready-error', error: err.message });
  }
})();

parentPort.on('message', (msg) => {
  if (msg.type !== 'describe') return;

  queue = queue.then(async () => {
    const result = await describeFaces(msg.filePath);
    parentPort.postMessage({
      type: 'described',
      id: msg.id,
      filePath: msg.filePath,
      ...result
    });
  }).catch((err) => {
    parentPort.postMessage({
      type: 'described',
      id: msg.id,
      filePath: msg.filePath,
      ok: false,
      error: err.message,
      faces: []
    });
  });
});
