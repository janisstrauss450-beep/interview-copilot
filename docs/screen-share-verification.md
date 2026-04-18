# Screen-share content-protection verification

Goal: prove the overlay window is invisible to screen-sharing and screen-recording
apps, so the interviewer cannot see the teleprompter.

## What we rely on

`BrowserWindow.setContentProtection(true)` — called in
[`src/main/windows.ts`](../src/main/windows.ts) when the overlay is created.

On **macOS** this sets `NSWindow.sharingType = .none`. All AVFoundation and
ScreenCaptureKit consumers honor it. Zoom 5.13+ and Meet/Teams on macOS use
those APIs.

On **Windows** this translates to `SetWindowDisplayAffinity(hwnd,
WDA_EXCLUDEFROMCAPTURE)`. Windows 10 2004+ honors it in the standard screen-
share modes of Zoom, Teams, and Meet.

## Runtime toggle

`Ctrl+Shift+V` (or the shield button in the overlay's status strip) toggles
protection on/off at runtime. Green shield = protected. Red pulsing shield +
red inner ring on the overlay = visible on screen share. Default on launch:
protected.

## Test grid

Run `pnpm dev`, position the overlay so it clearly overlaps your webcam
preview, and start a call with a second device or a friend on the other end.
For each row below, share your entire screen (or the relevant window) and ask
the recipient whether they can see the overlay.

**Google Meet note:** Meet lets you share "Your entire screen", "A window",
or "A tab". The tab-share mode captures Chrome's rendered tab content, not
the desktop — our overlay is a separate Electron window so it physically
does not render into the tab, regardless of content-protection. If you see
the overlay in a share, you're almost certainly in "Entire screen" mode.
Use `Ctrl+Shift+V` to force visibility ON during testing to confirm the
toggle is working before blaming the OS.

| App / mode                              | macOS 13 | macOS 14 | Windows 10 22H2 | Windows 11 23H2 | Verdict |
|----------------------------------------|:---:|:---:|:---:|:---:|:---:|
| Zoom — Share entire screen             |  ?  |  ?  |  ?  |  ?  |     |
| Zoom — Share window (Chrome)           |  ?  |  ?  |  ?  |  ?  |     |
| Google Meet (Chrome) — entire screen   |  ?  |  ?  |  ?  |  ?  |     |
| Google Meet (Chrome) — tab share       |  ?  |  ?  |  ?  |  ?  |     |
| Microsoft Teams — entire screen        |  ?  |  ?  |  ?  |  ?  |     |
| QuickTime Player / Xbox Game Bar recording |  ?  |  ?  |  ?  |  ?  |     |
| OBS Studio — Display Capture           |  ?  |  ?  |  ?  |  ?  |     |
| OBS Studio — Window Capture            |  ?  |  ?  |  ?  |  ?  |     |

Replace each `?` with `✓` (invisible) or `✗` (leaked). A `✗` on any cell means
content protection failed for that combination — ship a fix or document the
limitation before calling v1 done.

## Smoke check you can do alone

1. `pnpm dev`
2. Open the **Windows Game Bar** (Win+G) → click **Capture** → **Record**.
3. Record for 5 seconds with the overlay visible.
4. Open the recording from `Videos\Captures\`.
5. The overlay should be absent from the video. If it appears, content
   protection is not being honored by that recorder — flag it.

## Known vectors that defeat content protection

These are out of scope for v1. Document them in the release notes if relevant:

- NDI bridges and some third-party virtual-camera tools that capture via
  DXGI desktop duplication in kernel mode.
- "Window capture" in OBS older than 28.x on Windows 10 1903 and earlier.
- A literal phone camera pointed at the screen. (We cannot defeat this.)

## If you see a leak

1. Record which app + mode leaked, on which OS build.
2. Check Electron version (`node_modules/electron/package.json`). `setContentProtection`
   on macOS had a regression around Electron 21; we pin to ≥ 30.
3. File an issue with: app version, OS build, screenshot/video, Electron version.
4. Short-term workaround: the `Cmd/Ctrl+Shift+H` hotkey hides the overlay —
   press it before sharing your screen.
