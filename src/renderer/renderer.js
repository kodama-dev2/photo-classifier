const THEME_KEY = 'photo-classifier-theme';
const VIEW_KEY = 'photo-classifier-view';

const state = {
  inputDir: null,
  outputDir: null,
  referenceDir: null,
  plan: null,
  lastOutput: null,
  selectedIndex: 0,
  selectedByCluster: {},
  mergeIds: new Set(),
  view: localStorage.getItem(VIEW_KEY) || 'preview'
};

const els = {
  modelStatus: document.getElementById('model-status'),
  inputPath: document.getElementById('input-path'),
  outputPath: document.getElementById('output-path'),
  referencePath: document.getElementById('reference-path'),
  threshold: document.getElementById('threshold'),
  thresholdValue: document.getElementById('threshold-value'),
  scanBtn: document.getElementById('scan-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  applyBtn: document.getElementById('apply-btn'),
  undoBtn: document.getElementById('undo-btn'),
  openOutputBtn: document.getElementById('open-output-btn'),
  mergeBtn: document.getElementById('merge-btn'),
  progressWrap: document.getElementById('progress-wrap'),
  progressText: document.getElementById('progress-text'),
  progressCount: document.getElementById('progress-count'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  message: document.getElementById('message'),
  results: document.getElementById('results'),
  stats: document.getElementById('stats'),
  candidateGrid: document.getElementById('candidate-grid'),
  previewEmpty: document.getElementById('preview-empty'),
  fileRows: document.getElementById('file-rows'),
  panelPreview: document.getElementById('panel-preview'),
  panelList: document.getElementById('panel-list'),
  tabPreview: document.getElementById('tab-preview'),
  tabList: document.getElementById('tab-list'),
  themeBtn: document.getElementById('theme-btn')
};

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function mediaUrl(filePath) {
  return window.api.mediaUrl(filePath);
}

function showMessage(text, isError) {
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.classList.toggle('error', Boolean(isError));
}

function setBusy(busy) {
  els.scanBtn.disabled = busy || els.modelStatus.dataset.state !== 'ready';
  els.applyBtn.disabled = busy;
  els.cancelBtn.hidden = !busy;
}

function setModelStatus(status) {
  els.modelStatus.dataset.state = status.state;
  els.modelStatus.textContent = status.message;
  els.scanBtn.disabled = status.state !== 'ready';
}

function shortPath(value, fallback) {
  if (!value) return fallback;
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join('/') || value;
}

function options() {
  return {
    inputDir: state.inputDir,
    outputDir: state.outputDir,
    referenceDir: state.referenceDir,
    threshold: Number(els.threshold.value),
    groupMode: selectedValue('group-mode'),
    action: selectedValue('action')
  };
}

function clusterNames() {
  const names = {};
  for (const cluster of state.plan?.clusters || []) {
    names[cluster.id] = cluster.name;
  }
  return names;
}

function findCluster(id) {
  return state.plan?.clusters.find((cluster) => cluster.id === id) || null;
}

function kindLabel(file, clusters) {
  if (file.kind === 'failed') return '_failed';
  if (file.kind === 'no_face') return '_no_face';
  if (file.kind === 'unknown') return '_unknown';
  if (file.kind === 'group') return '_group';
  const names = file.clusterIds
    .map((id) => clusters.find((cluster) => cluster.id === id)?.name || id)
    .filter(Boolean);
  return names.join(', ') || '_unknown';
}

function filesForCluster(cluster) {
  const paths = cluster.filePaths || cluster.sampleFiles || [];
  return paths
    .map((src) => state.plan.files.find((file) => file.src === src))
    .filter(Boolean);
}

function applyTheme(theme) {
  const next = theme === 'dark' || theme === 'light' ? theme : 'system';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
}

function cycleTheme() {
  const current = document.documentElement.dataset.theme || 'system';
  const order = ['system', 'light', 'dark'];
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
}

function setView(view) {
  state.view = view === 'list' ? 'list' : 'preview';
  localStorage.setItem(VIEW_KEY, state.view);
  const isPreview = state.view === 'preview';
  els.panelPreview.hidden = !isPreview;
  els.panelList.hidden = isPreview;
  els.tabPreview.classList.toggle('active', isPreview);
  els.tabList.classList.toggle('active', !isPreview);
  els.tabPreview.setAttribute('aria-selected', String(isPreview));
  els.tabList.setAttribute('aria-selected', String(!isPreview));
}

function updateMergeUi() {
  const count = state.mergeIds.size;
  els.mergeBtn.hidden = count < 2;
  els.mergeBtn.textContent = count > 1 ? `Gabungkan (${count})` : 'Gabungkan';
}

function setCardHero(card, src) {
  const heroImg = card.querySelector('.candidate-hero img');
  const heroFile = card.querySelector('.hero-file');
  const file = state.plan.files.find((item) => item.src === src);
  if (!heroImg || !file) return;
  heroImg.src = mediaUrl(src);
  heroImg.alt = file.name;
  if (heroFile) heroFile.textContent = file.name;
  for (const thumb of card.querySelectorAll('.candidate-thumb')) {
    thumb.classList.toggle('active', thumb.dataset.src === src);
  }
}

function renderCandidates(plan) {
  const clusters = plan.clusters || [];
  els.previewEmpty.hidden = clusters.length > 0;
  els.candidateGrid.hidden = clusters.length === 0;

  els.candidateGrid.innerHTML = clusters.map((cluster) => {
    const files = filesForCluster(cluster);
    const selectedSrc = state.selectedByCluster[cluster.id] || files[0]?.src || '';
    const selectedFile = files.find((file) => file.src === selectedSrc) || files[0];
    const picked = state.mergeIds.has(cluster.id);

    return `
      <article class="candidate-card${picked ? ' picked' : ''}" data-cluster-id="${escapeHtml(cluster.id)}">
        <div class="candidate-head">
          <input type="checkbox" data-merge-id="${escapeHtml(cluster.id)}" ${picked ? 'checked' : ''} aria-label="Pilih untuk digabung" />
          <input class="candidate-name" data-cluster-id="${escapeHtml(cluster.id)}" value="${escapeHtml(cluster.name)}" />
          <span class="candidate-count">${cluster.faceCount} wajah · ${files.length} foto</span>
        </div>
        <div class="candidate-hero">
          ${selectedFile ? `
            <img src="${escapeHtml(mediaUrl(selectedFile.src))}" alt="${escapeHtml(selectedFile.name)}" />
            <span class="hero-file">${escapeHtml(selectedFile.name)}</span>
          ` : '<span class="hero-file">Tidak ada foto</span>'}
        </div>
        <div class="candidate-thumbs" role="listbox" aria-label="Foto ${escapeHtml(cluster.name)}">
          ${files.map((file) => `
            <button
              type="button"
              class="candidate-thumb${file.src === selectedFile?.src ? ' active' : ''}"
              data-src="${escapeHtml(file.src)}"
              title="${escapeHtml(file.name)}"
            >
              <img src="${escapeHtml(mediaUrl(file.src))}" alt="" loading="lazy" />
            </button>
          `).join('')}
        </div>
      </article>
    `;
  }).join('');

  updateMergeUi();
}

function renderList(plan) {
  const files = plan.files.slice(0, 400);
  const rows = files.map((file, index) => `
    <tr class="file-row${index === state.selectedIndex ? ' active' : ''}" data-index="${index}">
      <td><img class="row-thumb" src="${escapeHtml(mediaUrl(file.src))}" alt="" loading="lazy" /></td>
      <td>${escapeHtml(file.name)}</td>
      <td>${escapeHtml(kindLabel(file, plan.clusters))}</td>
    </tr>
  `);
  if (plan.files.length > 400) {
    rows.push(`<tr><td colspan="3">dan ${plan.files.length - 400} file lainnya</td></tr>`);
  }
  els.fileRows.innerHTML = rows.join('');
}

function renderPlan(plan) {
  state.plan = plan;
  els.results.hidden = !plan;
  if (!plan) return;

  const validIds = new Set(plan.clusters.map((cluster) => cluster.id));
  state.mergeIds = new Set([...state.mergeIds].filter((id) => validIds.has(id)));
  const nextSelected = {};
  for (const cluster of plan.clusters) {
    const files = filesForCluster(cluster);
    const prev = state.selectedByCluster[cluster.id];
    nextSelected[cluster.id] = files.some((file) => file.src === prev) ? prev : (files[0]?.src || '');
  }
  state.selectedByCluster = nextSelected;

  if (state.selectedIndex >= plan.files.length) state.selectedIndex = 0;

  const s = plan.stats;
  els.stats.textContent = [
    `${s.total} foto`,
    `${plan.clusters.length} orang`,
    s.group ? `${s.group} grup` : null,
    s.unknown ? `${s.unknown} tidak dikenal` : null,
    s.noFace ? `${s.noFace} tanpa wajah` : null,
    s.failed ? `${s.failed} gagal` : null
  ].filter(Boolean).join(' · ');

  renderCandidates(plan);
  renderList(plan);
  setView(state.view);
}

function setProgress(data) {
  if (!data) {
    els.progressWrap.hidden = true;
    return;
  }
  els.progressWrap.hidden = false;
  const labels = {
    list: 'Membaca folder',
    references: 'Membaca referensi',
    detect: 'Mendeteksi wajah',
    apply: 'Memindahkan file'
  };
  const current = data.current || 0;
  const total = data.total || 1;
  const pct = Math.round((current / total) * 100);
  els.progressText.textContent = `${labels[data.phase] || data.phase}: ${shortPath(data.file, '')}`;
  els.progressCount.textContent = `${current} / ${total}`;
  els.progressFill.style.width = `${pct}%`;
  els.progressBar.setAttribute('aria-valuenow', String(pct));
}

async function pick(which, title, fallback) {
  const dir = await window.api.pickDir(title);
  if (!dir) return;
  state[which] = dir;
  const el = which === 'inputDir' ? els.inputPath : which === 'outputDir' ? els.outputPath : els.referencePath;
  el.textContent = shortPath(dir, fallback);
  el.title = dir;
}

applyTheme(localStorage.getItem(THEME_KEY) || 'system');
setView(state.view);

els.themeBtn.addEventListener('click', cycleTheme);
els.tabPreview.addEventListener('click', () => setView('preview'));
els.tabList.addEventListener('click', () => setView('list'));

els.candidateGrid.addEventListener('click', (event) => {
  const checkbox = event.target.closest('input[type="checkbox"][data-merge-id]');
  if (checkbox) {
    const id = checkbox.dataset.mergeId;
    if (checkbox.checked) state.mergeIds.add(id);
    else state.mergeIds.delete(id);
    const card = checkbox.closest('.candidate-card');
    if (card) card.classList.toggle('picked', checkbox.checked);
    updateMergeUi();
    return;
  }

  const thumb = event.target.closest('.candidate-thumb');
  if (!thumb) return;
  const card = thumb.closest('.candidate-card');
  if (!card) return;
  const clusterId = card.dataset.clusterId;
  state.selectedByCluster[clusterId] = thumb.dataset.src;
  setCardHero(card, thumb.dataset.src);
});

let renameTimer;
els.candidateGrid.addEventListener('input', (event) => {
  const input = event.target.closest('.candidate-name');
  if (!input || !state.plan) return;
  const cluster = findCluster(input.dataset.clusterId);
  if (!cluster) return;
  cluster.name = input.value.trim() || cluster.name;
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    await window.api.renameCluster({ clusterId: cluster.id, name: cluster.name });
    renderList(state.plan);
  }, 220);
});

els.mergeBtn.addEventListener('click', async () => {
  if (state.mergeIds.size < 2) return;
  const ids = [...state.mergeIds];
  const first = findCluster(ids[0]);
  const result = await window.api.mergeClusters({
    clusterIds: ids,
    name: first?.name || ''
  });
  if (!result.ok) {
    showMessage(result.error || 'Gagal menggabungkan.', true);
    return;
  }
  state.mergeIds = new Set();
  renderPlan(result.plan);
  showMessage(`Digabung menjadi ${findCluster(ids[0])?.name || 'satu orang'}.`);
});

els.fileRows.addEventListener('click', (event) => {
  const row = event.target.closest('.file-row');
  if (!row || !state.plan) return;
  const index = Number(row.dataset.index);
  state.selectedIndex = index;
  const file = state.plan.files[index];
  const clusterId = file?.clusterIds?.[0];
  if (clusterId) {
    state.selectedByCluster[clusterId] = file.src;
    setView('preview');
    renderCandidates(state.plan);
    const card = els.candidateGrid.querySelector(`[data-cluster-id="${clusterId}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  renderList(state.plan);
});

document.getElementById('pick-input').addEventListener('click', () => {
  pick('inputDir', 'Pilih folder foto', 'Pilih folder foto');
});
document.getElementById('pick-output').addEventListener('click', () => {
  pick('outputDir', 'Pilih folder tujuan', 'Pilih folder hasil');
});
document.getElementById('pick-reference').addEventListener('click', () => {
  pick('referenceDir', 'Pilih folder referensi', 'Subfolder per orang, atau kosongkan');
});

function syncThresholdUi() {
  const min = Number(els.threshold.min);
  const max = Number(els.threshold.max);
  const value = Number(els.threshold.value);
  const pct = ((value - min) / (max - min)) * 100;
  els.thresholdValue.textContent = value.toFixed(2);
  els.threshold.style.setProperty('--threshold-pct', `${pct}%`);
}

els.threshold.addEventListener('input', syncThresholdUi);
syncThresholdUi();

let reclassifyTimer;
function scheduleReclassify() {
  if (!state.plan) return;
  clearTimeout(reclassifyTimer);
  reclassifyTimer = setTimeout(async () => {
    const result = await window.api.reclassify({
      threshold: Number(els.threshold.value),
      groupMode: selectedValue('group-mode')
    });
    if (result.ok) {
      state.mergeIds = new Set();
      renderPlan(result.plan);
    }
  }, 280);
}

els.threshold.addEventListener('change', scheduleReclassify);
for (const input of document.querySelectorAll('input[name="group-mode"]')) {
  input.addEventListener('change', scheduleReclassify);
}

els.scanBtn.addEventListener('click', async () => {
  const opts = options();
  if (!opts.inputDir) {
    showMessage('Pilih folder sumber dulu.', true);
    return;
  }
  showMessage('');
  setBusy(true);
  setProgress({ phase: 'list', current: 0, total: 1, file: opts.inputDir });
  const result = await window.api.scan(opts);
  setBusy(false);
  if (!result.ok) {
    showMessage(result.error || 'Pindai gagal.', true);
    return;
  }
  if (result.cancelled) {
    showMessage('Pindai dibatalkan.');
    if (result.plan) renderPlan(result.plan);
    return;
  }
  setProgress(null);
  state.selectedIndex = 0;
  state.selectedByCluster = {};
  state.mergeIds = new Set();
  setView('preview');
  renderPlan(result.plan);
  showMessage(result.plan.stats.total
    ? 'Pratinjau siap. Centang beberapa kartu lalu Gabungkan jika salah pisah.'
    : 'Tidak ada foto di folder itu.');
});

els.cancelBtn.addEventListener('click', () => {
  window.api.cancel();
});

els.applyBtn.addEventListener('click', async () => {
  const opts = options();
  if (!opts.outputDir) {
    showMessage('Pilih folder tujuan dulu.', true);
    return;
  }
  if (!state.plan) return;
  showMessage('');
  setBusy(true);
  const result = await window.api.apply({
    outputDir: opts.outputDir,
    action: opts.action,
    clusterNames: clusterNames()
  });
  setBusy(false);
  setProgress(null);
  if (!result.ok) {
    showMessage(result.error || 'Gagal menerapkan.', true);
    return;
  }
  state.lastOutput = opts.outputDir;
  els.undoBtn.hidden = false;
  els.openOutputBtn.hidden = false;
  const errorCount = result.log.errors.length;
  showMessage(errorCount ? `Selesai dengan ${errorCount} error. Cek errors.log.` : 'File sudah dikelompokkan.');
});

els.undoBtn.addEventListener('click', async () => {
  setBusy(true);
  const result = await window.api.undo();
  setBusy(false);
  if (!result.ok) {
    showMessage(result.error, true);
    return;
  }
  els.undoBtn.hidden = true;
  showMessage(`Urungkan: ${result.undone} operasi. ${result.failed.length ? `${result.failed.length} tidak bisa dikembalikan.` : ''}`);
});

els.openOutputBtn.addEventListener('click', () => {
  if (state.lastOutput) window.api.reveal(state.lastOutput);
});

window.api.onModelsStatus(setModelStatus);
window.api.onProgress(setProgress);
window.api.getModelsStatus().then(setModelStatus);
