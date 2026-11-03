const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');
const dest = path.join(__dirname, '..', 'resources', 'models');
const prefixes = [
  'ssd_mobilenetv1_model',
  'face_landmark_68_model',
  'face_recognition_model'
];

if (!fs.existsSync(src)) {
  console.warn('face-api models not found; skip copy');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });

let copied = 0;
for (const file of fs.readdirSync(src)) {
  if (!prefixes.some((prefix) => file.startsWith(prefix))) continue;
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  copied += 1;
}

console.log(`Copied ${copied} face-model files to resources/models`);
