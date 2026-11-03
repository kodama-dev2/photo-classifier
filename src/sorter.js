const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
  '.bmp', '.gif', '.tif', '.tiff'
]);

const SPECIAL_FOLDERS = new Set(['_group', '_unknown', '_no_face', '_failed']);

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function averageDescriptor(members) {
  const size = members[0].descriptor.length;
  const centroid = new Array(size).fill(0);
  for (const member of members) {
    for (let i = 0; i < size; i += 1) {
      centroid[i] += member.descriptor[i];
    }
  }
  for (let i = 0; i < size; i += 1) {
    centroid[i] /= members.length;
  }
  return centroid;
}

function safeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '-')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || 'unnamed';
}

async function listPhotos(dir, skipDir) {
  const out = [];
  const skip = skipDir ? path.resolve(skipDir) : null;

  async function walk(current) {
    if (skip && path.resolve(current) === skip) return;
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  await walk(dir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function minDistanceToCluster(face, cluster) {
  let best = Infinity;
  for (const member of cluster.members) {
    const dist = euclideanDistance(face.descriptor, member.descriptor);
    if (dist < best) best = dist;
  }
  return best;
}

function mergeCloseClusters(clusters, threshold) {
  const next = clusters.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < next.length; i += 1) {
      for (let j = i + 1; j < next.length; j += 1) {
        const centroidDist = euclideanDistance(next[i].centroid, next[j].centroid);
        let memberDist = Infinity;
        for (const left of next[i].members) {
          for (const right of next[j].members) {
            memberDist = Math.min(
              memberDist,
              euclideanDistance(left.descriptor, right.descriptor)
            );
          }
        }
        if (centroidDist <= threshold || memberDist <= threshold) {
          next[i].members.push(...next[j].members);
          next[i].centroid = averageDescriptor(next[i].members);
          next.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return next;
}

function clusterFaces(allFaces, threshold) {
  const clusters = [];

  for (const face of allFaces) {
    let best = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const dist = minDistanceToCluster(face, cluster);
      if (dist < bestDist) {
        bestDist = dist;
        best = cluster;
      }
    }
    if (best && bestDist <= threshold) {
      best.members.push(face);
      best.centroid = averageDescriptor(best.members);
    } else {
      clusters.push({
        members: [face],
        centroid: face.descriptor.slice()
      });
    }
  }

  return mergeCloseClusters(clusters, threshold).map((cluster, index) => ({
    id: `person-${index + 1}`,
    name: `Person ${index + 1}`,
    members: cluster.members,
    centroid: cluster.centroid
  }));
}

function findBestMatch(descriptor, people, threshold) {
  let best = { label: 'unknown', distance: Infinity };
  for (const person of people) {
    for (const ref of person.descriptors) {
      const dist = euclideanDistance(descriptor, ref);
      if (dist < best.distance) {
        best = { label: person.name, distance: dist };
      }
    }
  }
  if (best.distance > threshold) {
    return { label: 'unknown', distance: best.distance };
  }
  return best;
}

function buildStats(files) {
  const stats = {
    total: files.length,
    people: 0,
    group: 0,
    unknown: 0,
    noFace: 0,
    failed: 0
  };
  for (const file of files) {
    if (file.kind === 'person') stats.people += 1;
    else if (file.kind === 'group') stats.group += 1;
    else if (file.kind === 'unknown') stats.unknown += 1;
    else if (file.kind === 'no_face') stats.noFace += 1;
    else if (file.kind === 'failed') stats.failed += 1;
  }
  return stats;
}

function fileEntry(src, kind, clusterIds, error) {
  return {
    src,
    name: path.basename(src),
    kind,
    clusterIds,
    error: error || null
  };
}

function classifyByClustering(fileResults, threshold, groupMode) {
  const allFaces = [];
  for (const result of fileResults) {
    if (!result.ok) continue;
    result.faces.forEach((descriptor, faceIndex) => {
      allFaces.push({ filePath: result.filePath, faceIndex, descriptor });
    });
  }

  const clusters = clusterFaces(allFaces, threshold);
  const faceOwner = new Map();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      faceOwner.set(`${member.filePath}#${member.faceIndex}`, cluster.id);
    }
  }

  const files = fileResults.map((result) => {
    if (!result.ok) return fileEntry(result.filePath, 'failed', [], result.error);
    if (!result.faces.length) return fileEntry(result.filePath, 'no_face', []);

    const ids = [];
    result.faces.forEach((_descriptor, faceIndex) => {
      const id = faceOwner.get(`${result.filePath}#${faceIndex}`);
      if (id && !ids.includes(id)) ids.push(id);
    });

    if (ids.length === 1) return fileEntry(result.filePath, 'person', ids);
    if (ids.length > 1) {
      return fileEntry(result.filePath, groupMode === 'copy-each' ? 'person' : 'group', ids);
    }
    return fileEntry(result.filePath, 'unknown', []);
  });

  return {
    mode: 'cluster',
    groupMode,
    clusters: clusters.map((cluster) => {
      const filePaths = [...new Set(cluster.members.map((member) => member.filePath))];
      return {
        id: cluster.id,
        name: cluster.name,
        faceCount: cluster.members.length,
        filePaths,
        sampleFiles: filePaths.slice(0, 3)
      };
    }),
    files,
    stats: buildStats(files)
  };
}

function classifyWithReferences(fileResults, people, threshold, groupMode) {
  const clusters = people.map((person, index) => ({
    id: `ref-${index + 1}`,
    name: person.name,
    faceCount: 0,
    sampleFiles: []
  }));
  const idByName = new Map(clusters.map((cluster) => [cluster.name, cluster.id]));

  const files = fileResults.map((result) => {
    if (!result.ok) return fileEntry(result.filePath, 'failed', [], result.error);
    if (!result.faces.length) return fileEntry(result.filePath, 'no_face', []);

    const names = [];
    for (const descriptor of result.faces) {
      const match = findBestMatch(descriptor, people, threshold);
      if (match.label !== 'unknown' && !names.includes(match.label)) {
        names.push(match.label);
        const cluster = clusters.find((item) => item.name === match.label);
        if (cluster) {
          cluster.faceCount += 1;
          if (cluster.sampleFiles.length < 3) cluster.sampleFiles.push(result.filePath);
        }
      }
    }

    const clusterIds = names.map((name) => idByName.get(name)).filter(Boolean);
    if (names.length === 1) return fileEntry(result.filePath, 'person', clusterIds);
    if (names.length > 1) {
      return fileEntry(result.filePath, groupMode === 'copy-each' ? 'person' : 'group', clusterIds);
    }
    return fileEntry(result.filePath, 'unknown', []);
  });

  return {
    mode: 'reference',
    groupMode,
    clusters: clusters.map((cluster) => ({
      ...cluster,
      filePaths: [...new Set(cluster.sampleFiles || [])]
    })),
    files,
    stats: buildStats(files)
  };
}

function classifyPhotos(fileResults, options) {
  const threshold = Number(options.threshold) || 0.58;
  const groupMode = options.groupMode === 'copy-each' ? 'copy-each' : 'group';
  if (options.references && options.references.length) {
    return classifyWithReferences(fileResults, options.references, threshold, groupMode);
  }
  return classifyByClustering(fileResults, threshold, groupMode);
}

function rebuildFileKinds(files, groupMode) {
  return files.map((file) => {
    if (file.kind === 'failed' || file.kind === 'no_face' || file.kind === 'unknown') {
      return file;
    }
    if (!file.clusterIds.length) {
      return { ...file, kind: 'unknown' };
    }
    if (file.clusterIds.length === 1) {
      return { ...file, kind: 'person' };
    }
    return {
      ...file,
      kind: groupMode === 'copy-each' ? 'person' : 'group'
    };
  });
}

function mergeClusters(plan, clusterIds, name) {
  const ids = [...new Set(clusterIds || [])].filter((id) =>
    plan.clusters.some((cluster) => cluster.id === id)
  );
  if (ids.length < 2) {
    return { ok: false, error: 'Pilih minimal dua orang untuk digabung', plan };
  }

  const keepId = ids[0];
  const mergeSet = new Set(ids);
  const selected = plan.clusters.filter((cluster) => mergeSet.has(cluster.id));
  const keep = selected.find((cluster) => cluster.id === keepId);
  const mergedName = (name && String(name).trim()) || keep.name;
  const filePaths = [...new Set(selected.flatMap((cluster) => cluster.filePaths || cluster.sampleFiles || []))];
  const faceCount = selected.reduce((sum, cluster) => sum + (cluster.faceCount || 0), 0);

  const clusters = plan.clusters
    .filter((cluster) => !mergeSet.has(cluster.id) || cluster.id === keepId)
    .map((cluster) => {
      if (cluster.id !== keepId) return cluster;
      return {
        ...cluster,
        name: mergedName,
        faceCount,
        filePaths,
        sampleFiles: filePaths.slice(0, 3)
      };
    });

  const files = rebuildFileKinds(
    plan.files.map((file) => {
      const mapped = [];
      for (const id of file.clusterIds) {
        const next = mergeSet.has(id) ? keepId : id;
        if (!mapped.includes(next)) mapped.push(next);
      }
      return { ...file, clusterIds: mapped };
    }),
    plan.groupMode || 'group'
  );

  return {
    ok: true,
    plan: {
      ...plan,
      clusters,
      files,
      stats: buildStats(files)
    }
  };
}

function uniqueDest(destDir, baseName) {
  let dest = path.join(destDir, baseName);
  if (!fs.existsSync(dest)) return dest;
  const parsed = path.parse(baseName);
  let n = 1;
  do {
    dest = path.join(destDir, `${parsed.name} (${n})${parsed.ext}`);
    n += 1;
  } while (fs.existsSync(dest));
  return dest;
}

async function moveSafe(src, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const dest = uniqueDest(destDir, path.basename(src));
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
  return dest;
}

async function copySafe(src, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const dest = uniqueDest(destDir, path.basename(src));
  await fs.promises.copyFile(src, dest);
  return dest;
}

function destinationsFor(file, clusters, outputDir) {
  if (file.kind === 'failed') return [path.join(outputDir, '_failed')];
  if (file.kind === 'no_face') return [path.join(outputDir, '_no_face')];
  if (file.kind === 'unknown') return [path.join(outputDir, '_unknown')];
  if (file.kind === 'group') return [path.join(outputDir, '_group')];

  const folders = file.clusterIds
    .map((id) => clusters.find((cluster) => cluster.id === id))
    .filter(Boolean)
    .map((cluster) => path.join(outputDir, safeFolderName(cluster.name)));

  return folders.length ? [...new Set(folders)] : [path.join(outputDir, '_unknown')];
}

async function applyMoves(plan, options, onProgress) {
  const action = options.action === 'copy' ? 'copy' : 'move';
  const outputDir = path.resolve(options.outputDir);
  const operations = [];
  const errors = [];

  for (let i = 0; i < plan.files.length; i += 1) {
    const file = plan.files[i];
    const destDirs = destinationsFor(file, plan.clusters, outputDir);
    try {
      const dests = [];
      if (action === 'copy' || destDirs.length > 1) {
        for (const destDir of destDirs) {
          dests.push(await copySafe(file.src, destDir));
        }
        operations.push({ op: 'copy', src: file.src, dests });
        if (action === 'move' && destDirs.length > 1) {
          await fs.promises.unlink(file.src);
          operations.push({ op: 'delete-src', src: file.src });
        }
      } else {
        const dest = await moveSafe(file.src, destDirs[0]);
        operations.push({ op: 'move', src: file.src, dests: [dest] });
      }
    } catch (err) {
      errors.push({ src: file.src, error: err.message });
    }
    if (onProgress) {
      onProgress({
        phase: 'apply',
        current: i + 1,
        total: plan.files.length,
        file: file.src
      });
    }
  }

  const log = {
    action,
    outputDir,
    at: new Date().toISOString(),
    operations,
    errors
  };

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(outputDir, 'move-log.json'),
    JSON.stringify(log, null, 2)
  );
  if (errors.length) {
    const lines = errors.map((item) => `${item.src}\t${item.error}`).join('\n');
    await fs.promises.writeFile(path.join(outputDir, 'errors.log'), `${lines}\n`);
  }

  return log;
}

async function undoMoves(log) {
  const undone = [];
  const failed = [];
  const ops = [...(log.operations || [])].reverse();

  for (const op of ops) {
    try {
      if (op.op === 'move') {
        const dest = op.dests[0];
        await fs.promises.mkdir(path.dirname(op.src), { recursive: true });
        if (fs.existsSync(dest)) {
          try {
            await fs.promises.rename(dest, op.src);
          } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            await fs.promises.copyFile(dest, op.src);
            await fs.promises.unlink(dest);
          }
        }
        undone.push(op);
      } else if (op.op === 'copy') {
        for (const dest of op.dests) {
          if (fs.existsSync(dest)) await fs.promises.unlink(dest);
        }
        undone.push(op);
      } else if (op.op === 'delete-src') {
        failed.push({ ...op, error: 'Asli sudah dihapus setelah disalin ke beberapa folder' });
      }
    } catch (err) {
      failed.push({ ...op, error: err.message });
    }
  }

  return { undone: undone.length, failed };
}

module.exports = {
  SPECIAL_FOLDERS,
  listPhotos,
  classifyPhotos,
  mergeClusters,
  applyMoves,
  undoMoves,
  safeFolderName
};
