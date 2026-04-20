import { packager } from '@electron/packager';
import { mkdir, rm, writeFile, readFile, cp, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';

const ROOT = process.cwd();

// Version comes from package.json so filenames track the real version.
async function readVersion(): Promise<string> {
  const raw = await readFile(join(ROOT, 'package.json'), 'utf8');
  return (JSON.parse(raw).version as string) || '0.0.0';
}

async function zipDir(srcDir: string, destZip: string, topLevelName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, topLevelName);
    archive.finalize();
  });
}

async function main(): Promise<void> {
  const VERSION = await readVersion();
  const OUT_DIR = join(ROOT, 'release', VERSION);
  const STAGING = join(OUT_DIR, 'mac-staging');

  // 0. Clean staging.
  if (existsSync(STAGING)) await rm(STAGING, { recursive: true, force: true });
  await mkdir(STAGING, { recursive: true });

  // 1. electron-vite build — produces out/{main,preload,renderer}.
  console.log('→ electron-vite build (prod)');
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const p = spawn('pnpm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
  });

  // 2. electron-packager for darwin universal (works from Windows host).
  console.log('→ electron-packager darwin universal');
  const appName = 'Interview Copilot';
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

  // Build both archs by default so the friend can pick. `universal` would
  // require `lipo` (macOS-only tool) so we produce two separate zips instead.
  const requested = process.env.MAC_ARCH as 'x64' | 'arm64' | 'both' | undefined;
  const archs: Array<'x64' | 'arm64'> =
    requested === 'x64' ? ['x64'] : requested === 'arm64' ? ['arm64'] : ['arm64', 'x64'];
  console.log(`  archs: ${archs.join(', ')}`);

  for (const arch of archs) {
  const appPaths = await packager({
    dir: ROOT,
    name: appName,
    appBundleId: 'com.janis.interview-copilot',
    appCategoryType: 'public.app-category.productivity',
    platform: 'darwin',
    arch,
    out: STAGING,
    overwrite: true,
    asar: true,
    prune: true,
    quiet: false,
    electronVersion: pkg.devDependencies.electron.replace(/^[\^~]/, ''),
    ignore: [
      // Directory-level excludes — keep all built assets under `out/`.
      // (No bare-extension filters like /\.css$/ here; those accidentally
      // strip the built CSS in out/renderer/assets, leaving the app
      // completely unstyled.)
      /^\/\.git($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.vite($|\/)/,
      /^\/\.idea($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/release($|\/)/,
      /^\/src($|\/)/,
      /^\/scripts($|\/)/,
      /^\/docs($|\/)/,
      /^\/native($|\/)/,
      /^\/tests($|\/)/,
      /^\/tools($|\/)/,
      /^\/\.env(\..+)?$/,
      /^\/\.npmrc$/,
      /^\/\.gitattributes$/,
      /^\/tsconfig.*\.json$/,
      /^\/electron\.vite\.config\.ts$/,
      /^\/electron-builder\.yml$/,
      /^\/README\.md$/,
      /^\/PLAN\.md$/,
      /\.map$/,
    ],
  });

  if (appPaths.length === 0) throw new Error(`electron-packager produced no output for ${arch}`);
  const appDirPath = appPaths[0];
  console.log(`  .app built at: ${appDirPath}`);

  // Copy the audiotap binary (Swift ScreenCaptureKit helper) into the bundle's
  // Contents/Resources so the main process can spawn it at runtime. It's
  // compiled by the GitHub Actions macOS job before this script runs, or by
  // hand on a Mac via `cd native/mac && swift build -c release`.
  const appBundleName = `${appName}.app`;
  const appBundlePath = join(appDirPath, appBundleName);
  const candidateHelpers = [
    join(ROOT, 'native', 'mac', '.build', 'release', 'audiotap'),
    join(ROOT, 'resources', 'audiotap-mac'),
  ];
  const helper = candidateHelpers.find((p) => existsSync(p));
  if (helper) {
    const dest = join(appBundlePath, 'Contents', 'Resources', 'audiotap-mac');
    await cp(helper, dest, { force: true });
    try {
      await chmod(dest, 0o755);
    } catch {
      // On Windows NTFS chmod has no effect; CI on mac fixes perms.
    }
    console.log(`  bundled audiotap helper from ${helper}`);
  } else {
    console.warn(
      '  ⚠ audiotap helper not found — macOS system audio loopback will not work.\n' +
        '    Compile it on a Mac: cd native/mac && swift build -c release\n' +
        '    Or run via GitHub Actions (.github/workflows/build.yml) which does it automatically.',
    );
  }

  const archLabel = arch === 'arm64' ? 'AppleSilicon' : 'Intel';
  const zipPath = join(OUT_DIR, `InterviewCopilot-${VERSION}-mac-${archLabel}.zip`);
  console.log(`→ zipping ${arch} → ${zipPath}`);
  if (!existsSync(appBundlePath)) {
    throw new Error(`expected ${appBundlePath} to exist after packaging`);
  }
  await zipDir(appBundlePath, zipPath, appBundleName);
  console.log(`  zip done: ${zipPath}`);
  }

  // Write a setup README alongside the zips.
  const readmePath = join(OUT_DIR, 'MACOS-README.txt');
  const readme = `INTERVIEW COPILOT — macOS SETUP (unsigned build)
=================================================

0) WHICH ZIP TO PICK:
   - M1 / M2 / M3 / M4 Mac (2020 or later):
       InterviewCopilot-${VERSION}-mac-AppleSilicon.zip
   - Intel Mac (pre-2020):
       InterviewCopilot-${VERSION}-mac-Intel.zip

1) Unzip the archive. You'll get "Interview Copilot.app".

2) Drag it into /Applications (or anywhere you like).

3) First launch will be blocked by Gatekeeper because this build is not
   signed with an Apple Developer certificate. Fix:
   - Right-click (or Ctrl-click) the .app
   - Choose "Open"
   - Click "Open" in the "Apple could not verify..." dialog
   - Only needed once.

   If macOS still refuses:
   - System Settings → Privacy & Security → scroll down →
     "Interview Copilot was blocked..." → click "Open Anyway".

4) On first run the app will ask for an OpenAI API key. Get one at
   platform.openai.com/api-keys. Paste it when prompted — it's
   validated, then encrypted in your macOS Keychain.

5) PERMISSIONS you'll be asked for:
   - Screen Recording — needed for system audio capture (via
     ScreenCaptureKit) and the instant-screenshot hotkey (Cmd+Shift+I).
     Grant in System Settings → Privacy & Security → Screen Recording,
     then RESTART the app once. macOS doesn't pick up the grant live.
   - Microphone — needed only if you use the mic fallback audio mode.
     Grant in Privacy & Security → Microphone.

SYSTEM AUDIO CAPTURE
--------------------

This build bundles a native Swift helper that uses Apple's ScreenCaptureKit
(macOS 13+) to tap system audio directly. No virtual audio driver
(BlackHole etc.) is needed. No Audio MIDI Setup fiddling.

The first time you click "Start listening", macOS will ask for Screen
Recording permission. That's normal — ScreenCaptureKit needs it even for
audio-only use. Grant it in System Settings → Privacy & Security →
Screen Recording, then restart the app once. After that, zero config.

If the system-audio capture doesn't work for some reason (e.g. macOS
older than 13, or the helper didn't bundle correctly), the app
automatically falls back to Microphone mode.

KNOWN macOS LIMITATIONS
-----------------------

- CODE SIGNING: this build is not signed with an Apple Developer ID,
  so Gatekeeper will warn on first launch (see step 3 above). For a
  fully signed + notarized build you need an Apple Developer account.

- CONTENT PROTECTION (hide from screen share): works via
  Electron's setContentProtection(true), which maps to
  NSWindow.sharingType = .none on macOS. Verify with the Cmd+Shift+V
  toggle before a real call.

THINGS THAT WORK OUT OF THE BOX
-------------------------------
- System audio capture (ScreenCaptureKit via bundled Swift helper)
- Microphone capture (fallback / alternative)
- Question detection + classifier
- Answer generation (gpt-5.4 → fallback chain)
- Skeleton bullets
- Screenshot OCR (Cmd+Shift+I) — grants Screen Recording permission
- File picker upload (Cmd+Shift+U)
- Hotkeys (Cmd+Shift+R/S/L/H/P/V/U/I)
- Transcript persistence + Debrief view
- Live teleprompter overlay
- Hide-from-screen-share toggle (Cmd+Shift+V)

ANY ISSUES, send a screenshot of the Transcription (debug) panel in
the setup window — that's where transcription + classifier events are
logged.
`;
  await writeFile(readmePath, readme, 'utf8');
  console.log(`  readme: ${readmePath}`);

  console.log(`\n✓ mac build complete`);
  console.log(`  readme:    ${readmePath}`);
  console.log(`  output in: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
