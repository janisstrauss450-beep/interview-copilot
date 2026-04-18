# Interview Copilot

A floating teleprompter that listens to a live video-call, detects when
the interviewer asks you a question, and streams a grounded suggested
answer into a quiet serif overlay that is **hidden from screen share**.

Built to help with university admissions interviews. Works on Windows
today; macOS is partially wired (see [§ Current limitations](#current-limitations)).

## What it does

1. **You upload** your essay, bio, and optional source-text into a
   one-time setup panel.
2. **You start listening.** The app captures system audio (loopback)
   via Chromium — no extra drivers, no prompts.
3. **Real-time transcription** via OpenAI Realtime API
   (`gpt-4o-mini-transcribe`) produces partial + final captions.
4. **A hybrid classifier** (fast heuristic + `gpt-5.4-mini` tiebreaker)
   decides whether each final utterance is a question, the
   interviewer reading source material, or neither.
5. **When a question is detected**, two parallel Codex calls fire:
   - *Pass 1* — a 3–5 bullet skeleton from `gpt-5.4-mini`
   - *Pass 2* — a ~30–60 second spoken answer from `gpt-5.4`,
     streaming token by token, grounded in your uploaded context.
6. **Everything appears on a frameless, always-on-top overlay** that
   `setContentProtection(true)` hides from Zoom/Teams/Meet screen
   share.
7. **After the call**, the whole session is saved as JSON to
   `%APPDATA%\Interview Copilot\transcripts\` and surfaced in a
   debrief view with per-question latency + regeneration stats.

## Requirements

- Windows 10 build 2004+ (for `WDA_EXCLUDEFROMCAPTURE`) or macOS 13+
- Node.js 22+ (for dev) and `pnpm`
- A populated OpenClaw auth-profiles file with an `openai-codex`
  OAuth profile. The app looks in
  `~/.openclaw/agents/*/agent/auth-profiles.json`.
- An OpenAI API key (`sk-proj-…` or similar). Read from
  `OPENAI_API_KEY` or from `ebay-scanner/config.py` on the user's
  home directory. Only used for transcription — the answer engine
  goes through the Codex ChatGPT backend.

The app never asks for a key interactively. If neither source is
available, the setup window shows a clear red chip explaining what
to do.

## Install (dev)

```sh
cd interview-copilot
pnpm install
pnpm dev
```

Two windows open: a setup panel (800×680) and a floating overlay
(420×560, always-on-top).

## Install (built)

```sh
pnpm dist:win     # produces release/<ver>/InterviewCopilot-Setup-<ver>-x64.exe (~110 MB)
pnpm dist:mac     # DMGs (must run on macOS, not cross-built from Windows)
```

Windows build requires **Developer Mode** enabled (Settings → Privacy
& Security → For developers) — electron-builder's signing tool needs
symlink creation privilege during its cache extraction step.

## Hotkeys

All global. Edit [src/main/index.ts](src/main/index.ts) to change
them; the setup UI flags any conflicts with other apps.

| Combo | Action |
|---|---|
| `Ctrl+Shift+R` | regenerate current answer |
| `Ctrl+Shift+S` | shorter rewrite |
| `Ctrl+Shift+L` | longer rewrite (one more specific from the essay) |
| `Ctrl+Shift+H` | hide/show overlay |
| `Ctrl+Shift+P` | mute listening (pause frames → transcription) |

Note: Windows `Ctrl+Shift+M` collides with Zoom's mute-self shortcut;
the mute hotkey here is `P` for exactly that reason.

## Smoke tests (no Electron required)

```sh
pnpm smoke:auth          # both credentials, /v1/models + Codex backend
pnpm smoke:realtime      # WebSocket handshake + session config
pnpm smoke:classifier    # 13 canned utterances, Q/R/other buckets
pnpm smoke:answer "your question"  # end-to-end Codex skeleton + answer stream
pnpm smoke:extract <path>          # pdf/docx/txt/md extraction check
```

## Current limitations

- **macOS loopback is not wired.** `getDisplayMedia` on macOS does
  not offer system-audio loopback; it would need a bundled Swift
  ScreenCaptureKit helper. See [native/mac/README.md](native/mac/README.md).
  Mic fallback works.
- **Content protection against third-party capture tools** (OBS
  kernel-mode DXGI, some NDI bridges) is not guaranteed. The
  standard Zoom/Teams/Meet paths are covered by Electron's
  `setContentProtection(true)`. Run through
  [docs/screen-share-verification.md](docs/screen-share-verification.md)
  before relying on it in a real interview.
- **First-token latency varies** from 0.6–3 s depending on Codex
  backend load. The plan's <2 s goal is sometimes missed; the
  skeleton (~1 s) gives the user something to glance at while the
  full answer streams in.
- **No custom-hotkey UI.** Bindings are hard-coded; edit source.
- **Classifier tuning.** Heuristic has a known imperative-disguise
  case (`"Can you read the first paragraph?"` → deferred to LLM).
  Real interview data may surface more edge cases.
- **No auto-reconnect** if the Realtime WebSocket drops mid-session.
  Stop and restart.
- **Token refresh** for the Codex OAuth JWT is not implemented —
  when expired, `codex login` (or the OpenClaw equivalent) must be
  re-run. Tokens currently have ~3–5 day TTL.
- **Hallucination risk.** The answer prompt is strict about "never
  invent" — verified in the no-context path where the model openly
  admits it doesn't have specifics. Real-world stress-test before
  every interview with a mock Q about something *not* in your
  essay.

## Privacy

Everything except transcription and LLM calls runs locally. Uploaded
essay/bio/source text is written only to your Electron userData
folder. Transcripts (including the audio-derived text and all
generated answers) are written to disk under
`<userData>/transcripts/`. Nothing is uploaded anywhere other than
OpenAI's APIs for the audio → text and question → answer calls.

## Further reading

- [PLAN.md](PLAN.md) — the original implementation plan (15 sections)
- [docs/screen-share-verification.md](docs/screen-share-verification.md)
