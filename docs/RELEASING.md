# Releasing Persona

GitHub releases are produced only from version tags. The expected repository is
`https://github.com/xikhar/persona`; the workflow does not create or push to it.

## One-time repository setup

Add these GitHub Actions secrets when signed distribution is available:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple notarization account |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Developer team |
| `WIN_CSC_LINK` | Base64 Windows code-signing certificate |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |

Without certificates, electron-builder can create unsigned packages, but macOS
Gatekeeper and Windows SmartScreen will warn or block normal installation.
Treat signed and notarized artifacts as the production release path.

## Before tagging

1. Choose the packaged model and animation files.
2. Declare every packaged item and its product metadata in
   `public/assets/library.json`.
3. Mirror every media path in `public/assets/manifest.json`, complete the
   license records and `ASSET_LICENSES.md`, then set `distributionAllowed` to
   `true`.
4. Update `version` in `package.json` and `package-lock.json`.
5. Add release notes to `CHANGELOG.md`.
6. Run:

   ```bash
   npm ci
   npm run check
   npm run assets:release
   npm run native:build
   npm run native:test
   ```

7. Manually verify on Linux, Windows, macOS arm64, and macOS x64:

   - install and launch;
   - an empty catalog opens Settings without creating an avatar window or
     starting the listener;
   - selecting the first model activates the avatar and listener;
   - first-run system audio permission where applicable;
   - automatic, selected-application, advanced-pattern, and external voice modes;
   - selected Linux playback-stream and macOS/Windows process discovery;
   - idle, short pause, long pause, and resumed speech;
   - immediate lip response to output;
   - no microphone capture, duplicate sound, or saved audio;
   - close hides without quitting;
   - ending voice leaves the window open;
   - tray show, hide, preview, and quit;
   - packaged and user model selection;
   - user model and action creation, multi-file VRMA import, preview,
     persistence, clip deletion, and action deletion;
   - permanent empty Idle, Thinking, and Speaking slots and numbered clip names;
   - packaged action edit, removal, and reset without changing user uploads;
   - random clip selection for voice-driven and MCP-triggered actions;
   - shortcut, URL protocol, zoom, orbit, and pan;
   - transparent background and always-on-top behavior; and
   - uninstall.

## Tag and release

The tag must exactly match the package version:

```bash
git tag v0.1.0-beta.0
git push origin v0.1.0-beta.0
```

The release workflow:

1. validates license metadata and tag/version agreement;
2. reruns lint, tests, and builds;
3. compiles and self-tests native listeners;
4. creates AppImage, DEB, NSIS, DMG, and ZIP packages;
5. uploads both macOS architectures;
6. writes `SHA256SUMS.txt`; and
7. publishes one GitHub Release with generated notes.

The current test placeholders intentionally make step 1 fail.
