# Car Replacement Studio

macOS desktop app for turning a folder of car images into Gemini-generated outputs that match 3 saved reference scenes.

## What it does

- Runs as a double-clickable Electron desktop app on Apple Silicon Macs.
- Saves a Gemini API key locally on the Mac.
- Saves exactly 3 reference images once in Settings.
- Generates loose output files named like `blue,911-gt3-rs,studio-front.png`.
- Supports both immediate `Sync` runs and cheaper `Batch` submissions with later fetch/refresh.

## Development

```bash
npm install --cache /tmp/npm-cache-shabbuscript
npm start
```

## Tests

```bash
npm test
```

## Packaging

```bash
npm run dist
```

The packaged output will be written to `dist/`.

## macOS Gatekeeper note

These v0.1 builds are unsigned and not notarized. On another Mac, the first launch may require:

1. Right-click the app.
2. Choose `Open`.
3. Confirm the Gatekeeper dialog once.
