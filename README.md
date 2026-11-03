# Photo Classifier

Electron app that sorts photos into folders by face. Needs Node 22+.

```bash
npm install
npm run rebuild
npm start
```

`npm install` / `postinstall` also downloads sharp + canvas binaries for macOS/Windows (arm64 + x64) via `ensure:native`.

If `npm install` fails because the volume path has a trailing space, use `npm run install:deps` instead.

## Release build

Same flow as pinterest-download: clean `release/`, then electron-builder. Do **not** use `npm ci --omit=optional`.

```bash
# wipe release/, then mac DMG + win zip
npm run dist:all

# macOS only (wipes release/ first)
npm run dist

# Windows zip only (does not wipe — keeps fresh Mac DMGs)
npm run dist:win
```

Artifacts land in `release/` (old DMG/zip always wiped first):

`Photo Classifier-<version>-<os>-<arch>.<ext>`

UI title is **Photo Classifier** with small **by gemadipada** under it.

Architecture and failure notes: [docs/face-sorting-electron-guide.md](docs/face-sorting-electron-guide.md).
