# Reference Studio

macOS desktop app for turning a folder of source images into Gemini-generated outputs that match saved reference scenes.

## What it does

- Runs as a double-clickable Electron desktop app on Apple Silicon Macs.
- Saves a Gemini API key locally on the Mac.
- Saves one or more reference images once in Settings.
- Generates loose output files named like `blue,911-gt3-rs,studio-front.png`.
- Supports both immediate `Sync` runs and cheaper `Batch` submissions with later fetch/refresh.

## Development

```bash
npm install --cache /tmp/npm-cache-reference-studio
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

`npm run dist` now submits notarization and exits quickly after Apple returns a submission id. It writes release state to `dist/macos-release-state.json`.

Check status later with:

```bash
npm run dist:status
```

Once Apple shows `Accepted`, finish the distributables with:

```bash
npm run dist:finalize
```

To inspect the current app bundle and any built DMG locally:

```bash
npm run dist:verify
```

The final artifacts are written to `dist/`.

## Signing And Notarization

Electron Builder is now configured for hardened runtime, app entitlements, and notarization when the required Apple credentials are present.

To ship outside your Mac cleanly, you still need:

1. A `Developer ID Application` certificate installed in your login keychain.
2. One notarization credential strategy:
   - `APPLE_KEYCHAIN_PROFILE` (recommended), or
   - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Recommended setup with notarytool keychain credentials:

```bash
xcrun notarytool store-credentials "reference-studio-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"

export APPLE_KEYCHAIN_PROFILE=reference-studio-notary
```

Then submit a build for notarization:

```bash
npm run dist
```

Check the Apple submission without blocking on `--wait`:

```bash
npm run dist:status
```

Once notarization is `Accepted`, create the final DMG and ZIP:

```bash
npm run dist:finalize
```

If you are also publishing a GitHub Release from this Mac, submit the build with repo metadata:

```bash
export GH_TOKEN=github_pat_your_token_here
export UPDATE_REPO_OWNER=g1mliii
export UPDATE_REPO_NAME=Reference-Studio
npm run release:github
```

Then, after notarization is `Accepted`, finalize and publish the release assets:

```bash
npm run release:github:finalize
```

## macOS Gatekeeper note

Until you switch from `Apple Development` to `Developer ID Application` signing and complete notarization, another Mac may still require:

1. Right-click the app.
2. Choose `Open`.
3. Confirm the Gatekeeper dialog once.
