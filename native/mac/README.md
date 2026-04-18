# audiotap — macOS system-audio capture helper

Native Swift binary that uses **ScreenCaptureKit** (macOS 13+) to tap system
audio and write 24 kHz mono 16-bit PCM to stdout. The Electron main process
spawns it via `child_process.spawn` and pipes stdout into the transcription
WebSocket.

No virtual audio driver (BlackHole etc.) needed. Apple blesses this API.

## Compile (5 minutes on a Mac with Xcode CLI tools)

```sh
xcode-select --install          # one-time, if not already installed
cd native/mac
swift build -c release
cp .build/release/audiotap ../../resources/audiotap-mac
```

The compiled binary ends up at `native/mac/.build/release/audiotap` (~1 MB).
Copy it to `resources/audiotap-mac` so `scripts/build-mac.ts` picks it up.

## Continuous integration

`.github/workflows/build.yml` runs this compile step automatically on a
`macos-latest` GitHub Actions runner, then bundles the binary into the
.app produced by `pnpm dist:mac`. No manual compile needed once the repo is
on GitHub.

## Permissions at runtime

On first launch the app will prompt for **Screen Recording** permission.
Required by ScreenCaptureKit even though we only need the audio part —
that's Apple's design.

- User grants: System Settings → Privacy & Security → Screen Recording →
  Interview Copilot → enable.
- Re-launch the app once after granting.

## Output format

- Sample rate: 24 000 Hz
- Channels: 1 (mono, downmixed from stereo via `AVAudioConverter`)
- Bit depth: 16-bit signed little-endian
- Frame-contiguous PCM bytes, no header, no delimiters.

This matches what the Windows Chromium path produces exactly, so downstream
code (transcription, classifier, overlay) is identical across platforms.

## Logging

The helper writes status messages to **stderr**, never stdout. Electron
captures stderr for debugging. Search logs for `audiotap:` prefix.
