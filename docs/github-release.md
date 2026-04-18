# Releasing via GitHub Actions

The `.github/workflows/build.yml` workflow builds both the Windows NSIS
installer and two macOS zips (Apple Silicon + Intel) automatically. The
macOS build includes a compiled Swift ScreenCaptureKit helper that enables
**true zero-config system-audio capture** — no BlackHole, no Audio MIDI Setup,
no driver install.

## One-time setup

You have to do this once to put the code on GitHub.

1. **Create a GitHub account** at <https://github.com> if you don't have one.

2. **Create a new repository.** Private is fine — no one else sees the code.
   - Go to <https://github.com/new>
   - Name: `interview-copilot` (or anything else)
   - Set it to **Private**
   - Don't tick any of the initialize-with options — we have our own files
   - Click "Create repository"

3. **Install Git** on Windows if you haven't: <https://git-scm.com/download/win>

4. **Open PowerShell** in the project folder (`C:\Users\janis\interview-copilot`)
   and push the code:

   ```powershell
   cd C:\Users\janis\interview-copilot
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/interview-copilot.git
   git push -u origin main
   ```

   On first push GitHub will prompt for your credentials. Use a
   **personal access token** as the password —
   <https://github.com/settings/tokens> → Generate new token (classic) →
   give it the `repo` scope → copy it → paste when git asks for password.

5. **Confirm the workflow is there.** Go to your repo on github.com →
   "Actions" tab → you should see "Build installers" listed.

## Producing a release

Two ways:

### A. Tag a version (produces a proper GitHub Release with downloadable zips)

In PowerShell, from the project folder:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

- Open the "Actions" tab on GitHub. A run will start within ~30 seconds.
- Takes ~10-15 minutes total (mac + windows + release steps).
- When green, go to the "Releases" tab — `v0.1.0` will be there with:
  - `InterviewCopilot-Setup-0.1.0-x64.exe` — Windows installer
  - `InterviewCopilot-0.1.0-mac-AppleSilicon.zip` — M-series Mac
  - `InterviewCopilot-0.1.0-mac-Intel.zip` — Intel Mac
  - `MACOS-README.txt` — install instructions for your friend

Send your friend the zip that matches their Mac + the README.

### B. Manual trigger (no release, just artifacts)

- Go to the Actions tab → "Build installers" → "Run workflow" → Run.
- When the run finishes, open it, scroll to "Artifacts" at the bottom.
- Download `mac-builds` and `win-installer` as zipped artifact bundles.
- Extract them locally and send the file your friend needs.

Artifacts from manual runs expire after 90 days. Tagged releases don't expire.

## Bumping versions

For v0.1.1, v0.2.0, etc.:

1. Edit `package.json` `"version"` field.
2. Edit the hardcoded `0.1.0` in `scripts/build-mac.ts` (zip filenames) if you
   want those to reflect the new version. (electron-builder picks up
   package.json automatically for Windows.)
3. `git commit -am "v0.1.1"` then `git tag v0.1.1 && git push origin main v0.1.1`.

## What the macOS runner does

Look at `.github/workflows/build.yml` — the `build-mac` job:

1. Checks out the code.
2. Installs Node 22 + pnpm + all JS dependencies.
3. Runs `swift build -c release --arch arm64 --arch x86_64` in `native/mac/`
   to compile the Swift ScreenCaptureKit helper into a **universal** binary
   that runs on both Apple Silicon and Intel.
4. Runs `pnpm dist:mac` which calls `scripts/build-mac.ts` — that script
   finds the compiled helper at `native/mac/.build/release/audiotap` and
   copies it into both the arm64 and x64 .app bundles under
   `Contents/Resources/audiotap-mac`.
5. Zips both .app bundles + writes `MACOS-README.txt`.
6. Uploads as artifacts.

## macOS permissions your friend will need to grant

First launch of the app on your friend's Mac:

1. **Gatekeeper warning** — right-click the .app → "Open" → click Open in
   the dialog. Only once.
2. **Screen Recording permission** — ScreenCaptureKit requires this even
   for audio-only use. Your friend gets a system prompt when the app first
   tries to start listening. They tick Interview Copilot in
   System Settings → Privacy & Security → Screen Recording.
3. **Restart the app once** after granting. (macOS won't let us pick up
   the permission live.)

After that: zero config, no drivers, no Audio MIDI Setup, audio loopback
just works. Same friction as Windows.

## If the build ever fails

Click the failed run on the Actions tab, expand the failing step, copy
the error. Two common ones:

- **Swift build fails** — Xcode on the runner is too old or too new. Pin
  it with `macos-14` instead of `macos-latest`, or set
  `xcode-version` via `maxim-lobanov/setup-xcode` step.
- **pnpm install fails** — the runner's pnpm version is wrong. Pin
  `pnpm/action-setup@v4` with a specific version field.

These are rare. The defaults above should Just Work.
