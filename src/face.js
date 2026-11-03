const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Canvas, Image, ImageData } = require('@napi-rs/canvas');

const REQUIRED_MODELS = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'face_landmark_68_model-weights_manifest.json',
  'face_recognition_model-weights_manifest.json'
];

let tf;
let faceapi;
let backend = 'node';

function assertModels(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Folder model tidak ada: ${dir}`);
  }
  for (const file of REQUIRED_MODELS) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Error(`File model hilang: ${file}`);
    }
  }
}

async function initBackend() {
  if (tf) return;

  try {
    tf = require('@tensorflow/tfjs-node');
    faceapi = require('@vladmandic/face-api');
    backend = 'node';
  } catch (err) {
    tf = require('@tensorflow/tfjs');
    faceapi = require('@vladmandic/face-api');
    backend = 'cpu';
    await tf.setBackend('cpu');
  }

  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

  await tf.ready();
}

async function loadModels(dir) {
  assertModels(dir);
  await initBackend();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
  return backend;
}

async function describeFaces(filePath) {
  let tensor;
  try {
    const buf = await fs.promises.readFile(filePath);
    const { data, info } = await sharp(buf)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    tensor = tf.tensor3d(data, [info.height, info.width, info.channels]);
    const results = await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    return {
      ok: true,
      faces: results.map((result) => Array.from(result.descriptor))
    };
  } catch (err) {
    return { ok: false, error: err.message, faces: [] };
  } finally {
    if (tensor) tensor.dispose();
  }
}

module.exports = { loadModels, describeFaces };
