(() => {
  const progressListeners = new Set();
  const modelListeners = new Set();
  const updateListeners = new Set();

  function emit(set, payload) {
    for (const cb of set) {
      try {
        cb(payload);
      } catch (_) {
        /* ignore */
      }
    }
  }

  const es = new EventSource('/api/events');
  es.addEventListener('models-status', (event) => {
    emit(modelListeners, JSON.parse(event.data));
  });
  es.addEventListener('progress', (event) => {
    emit(progressListeners, JSON.parse(event.data));
  });
  es.addEventListener('update-progress', (event) => {
    emit(updateListeners, JSON.parse(event.data));
  });

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body)
    });
    return res.json();
  }

  async function get(url) {
    const res = await fetch(url);
    return res.json();
  }

  window.api = {
    pickDir: async (title) => {
      const result = await post('/api/pick-dir', { title });
      if (result.cancelled) return null;
      if (!result.ok) {
        window.alert(result.error || 'Gagal pilih folder');
        return null;
      }
      return result.path;
    },
    getModelsStatus: () => get('/api/models-status'),
    getAppInfo: () => get('/api/app-info'),
    checkUpdate: () => get('/api/check-update'),
    downloadUpdate: () => post('/api/download-update', {}),
    mediaUrl: (filePath) => `/media?p=${encodeURIComponent(filePath)}`,
    onModelsStatus: (callback) => {
      modelListeners.add(callback);
      return () => modelListeners.delete(callback);
    },
    onProgress: (callback) => {
      progressListeners.add(callback);
      return () => progressListeners.delete(callback);
    },
    onUpdateProgress: (callback) => {
      updateListeners.add(callback);
      return () => updateListeners.delete(callback);
    },
    scan: (options) => post('/api/scan', options),
    reclassify: (options) => post('/api/reclassify', options),
    mergeClusters: (options) => post('/api/merge-clusters', options),
    renameCluster: (options) => post('/api/rename-cluster', options),
    cancel: () => post('/api/cancel', {}),
    apply: (options) => post('/api/apply', options),
    undo: () => post('/api/undo', {}),
    reveal: (targetPath) => post('/api/reveal', { targetPath })
  };
})();
