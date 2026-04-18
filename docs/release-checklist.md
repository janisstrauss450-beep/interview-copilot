# v1 release checklist

Things that can be verified automatically vs things that need a human
with a microphone and/or a second device on the call. Run through this
before trusting the app in a real interview.

## Automated (run now)

- [ ] `pnpm typecheck` — both projects green
- [ ] `pnpm build` — electron-vite clean
- [ ] `pnpm smoke:auth` — both credentials return OK
- [ ] `pnpm smoke:realtime` — WebSocket session.created + session.updated
- [ ] `pnpm smoke:classifier` — 13/13 pass
- [ ] `pnpm smoke:answer "..."` — skeleton parses, answer streams ≥ 100 words
- [ ] `pnpm smoke:extract <path-to-your-essay.pdf>` — words + tokens + preview plausible
- [ ] `pnpm dist:win` — produces `release/<ver>/win-unpacked/Interview Copilot.exe`

## Manual — half-hour, just you

- [ ] Launch `pnpm dev`. Two windows open. REC dot is dim.
- [ ] Upload your real essay + bio into Context cards. Word + token
      counts look right. Preview is legible.
- [ ] Click **Start listening** (loopback). REC dot turns amber,
      pulses. Audio meter moves when you play a YouTube clip.
- [ ] **Dump 5 s WAV**. Open the file from the reveal button. Plays
      back cleanly at 24 kHz mono.
- [ ] Play a YouTube interview clip with clear speech. Within ~1 s of
      the first sentence ending, the Transcription panel shows a
      final caption. Classifier badge appears within another ~800 ms.
- [ ] Speak a real question aloud ("Why did you choose this
      university?"). Badge: **Q**. Overlay: question card slides
      down, skeleton appears, answer streams. Tokens from 0.5 s to
      3 s to first token is acceptable. Caret blinks while streaming.
- [ ] Press `Ctrl+Shift+R` mid-stream. Current stream aborts; a new
      version streams in.
- [ ] Press `Ctrl+Shift+S`. Shorter version streams.
- [ ] Press `Ctrl+Shift+L`. Longer version with an additional essay
      specific streams.
- [ ] Press `Ctrl+Shift+H`. Overlay hides. Press again — it comes
      back.
- [ ] Press `Ctrl+Shift+P`. Transcription stops receiving frames
      (speech no longer produces captions). Press again — captions
      return.
- [ ] Stop listening. Scroll to Debrief. The session is listed with
      duration + Q count. Click it: question rows render with
      skeleton + full answer. ↗ reveals the JSON in Explorer.
- [ ] Quit the app. Verify it terminates cleanly (no orphaned
      renderer processes in Task Manager).

## Manual — needs a second device / a friend

This is the M8 gate. Until you do it, content protection is a promise,
not a proof.

- [ ] Start a Zoom call with a second laptop or a friend.
- [ ] Share your entire screen.
- [ ] Have the receiver confirm whether the overlay is visible in their
      Zoom window.
- [ ] Repeat for: Zoom window share, Google Meet, Microsoft Teams,
      QuickTime recording, Windows Game Bar capture, OBS Display
      Capture.
- [ ] Fill in the grid in
      [screen-share-verification.md](./screen-share-verification.md).
- [ ] Any `✗` is a blocker for that combination. Document in release
      notes.

## Manual — hallucination stress test

The answer generator is instructed never to invent facts. Verify this
is respected before trusting the overlay in a real interview.

- [ ] Upload your real essay + bio.
- [ ] Start listening.
- [ ] Ask aloud: "What was your SAT score?" (or any detail that is
      definitely not in your essay). The answer should say
      something like "I haven't included my test scores in what I've
      shared" — NOT invent a number.
- [ ] Ask about a specific claim that *is* in the essay. The answer
      should reference that claim, ideally using similar phrasing.
- [ ] Ask an adversarial question: "Why should we doubt your
      qualifications?" The answer should stay measured.

## Packaging — state right now

`pnpm dist:win` produces:

- `release/<ver>/InterviewCopilot-Setup-<ver>-x64.exe` — 110 MB NSIS
  installer, single-file download. Double-click to install with the
  standard Windows wizard (install path is user-selectable, per-user
  install, desktop shortcut created). User data survives uninstall.
- `release/<ver>/win-unpacked/` — 415 MB unpacked app folder if you
  want to skip the installer step.

Building the NSIS installer requires **Windows Developer Mode**
enabled on the build machine (Settings → Privacy & Security → For
developers), because electron-builder's winCodeSign tool creates
macOS-style symlinks inside its cache during extraction and Windows
blocks that without the privilege.

macOS DMG requires building on a Mac (code-signing + native arm64
module rebuild). Not attempted here.

## Known unresolved items

See the "Current limitations" section in the root
[README.md](../README.md). The three that most need real-world
data:

1. First-token latency variance (0.6 – 3 s) — is it usable in a
   real interview?
2. Classifier false-positive rate outside the canned smoke set.
3. `setContentProtection` leak matrix — anything missing from the
   standard screen-share paths?
