# Photo Classifier

Electron app that sorts photos into folders by face. Needs Node 22+.

```bash
npm install
npm run rebuild
npm start
```

If `npm install` fails because the volume path has a trailing space, use `npm run install:deps` instead.

## Release build

Same flow as pinterest-download: clean `release/`, then electron-builder.

```bash
# macOS arm64 + x64 DMG (ad-hoc signed)
npm run dist

# Windows zip (x64 + arm64)
npm run dist:win
```

Artifacts land in `release/` as:

`Photo Classifier by GEMADIPADA-<version>-<os>-<arch>.<ext>`

Architecture and failure notes: [docs/face-sorting-electron-guide.md](docs/face-sorting-electron-guide.md).
