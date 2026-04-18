# Interview Copilot — Implementation Plan

**Status:** DRAFT — awaiting approval. No code until you say "go."

**Goal:** Desktop app (macOS + Windows) that listens to live video-call audio, detects questions directed at the user, and shows streamed answer suggestions on a screen-share-hidden, always-on-top overlay. Answers are grounded in user-uploaded essay, bio, and source material.

**Stack (proposed, justified in §2):** Electron 30+ (main) · React 18 + Vite + TypeScript (renderers) · Node 20 · Zustand (state) · Tailwind (overlay styling) · native audio helpers per OS (Swift/Rust) · OpenAI APIs (transcription + LLM).

---

## 0. Confidence Legend

Every claim in this plan carries one of these tags. Read them as calibration, not decoration.

- `[HIGH]` — verified against docs I trust, or trivially testable.
- `[MED]` — believed true, needs a 5-minute smoke test.
- `[LOW]` — I'm guessing based on experience. Could be wrong. See risk register.
- `[UNKNOWN]` — open question. Will answer during Milestone 1.

---

## 1. Architecture

### 1.1 Process topology

```
┌────────────────────────────────────────────────────────────────────┐
│                      ELECTRON MAIN (Node.js)                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ orchestrator.ts   — lifecycle, IPC hub, hotkey registry      │  │
│  │ auth.ts           — reads ~/.codex/auth.json, token refresh  │  │
│  │ context.ts        — owns essay/bio/source; builds prompts    │  │
│  │ settings.ts       — persisted user prefs                     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│        │                  │                │                 │     │
│  ┌─────▼──────┐  ┌────────▼───────┐ ┌──────▼──────┐  ┌──────▼────┐ │
│  │ audio-cap  │  │ transcription- │ │ classifier- │  │ answer-   │ │
│  │ .worker    │→ │ worker         │→│ worker      │→ │ worker    │ │
│  │ (spawned   │  │ (WebSocket to  │ │ (gpt-4o-    │  │ (gpt-4o,  │ │
│  │ native hlp)│  │ OpenAI RT API) │ │ mini, JSON) │  │ streaming)│ │
│  └────────────┘  └────────────────┘ └─────────────┘  └───────────┘ │
└─────────┬───────────────────────┬──────────────────────────┬───────┘
          │ IPC                   │ IPC                      │ IPC
          ▼                       ▼                          ▼
  ┌───────────────┐       ┌──────────────────┐      ┌─────────────────┐
  │ SETUP WINDOW  │       │ OVERLAY WINDOW   │      │ (tray icon)     │
  │ (renderer)    │       │ (renderer)       │      │ menu + status   │
  │ ─ uploads     │       │ ─ status strip   │      └─────────────────┘
  │ ─ audio src   │       │ ─ question       │
  │ ─ auth stat   │       │ ─ skeleton       │
  │ ─ hotkey cfg  │       │ ─ full answer    │
  │ ─ start/stop  │       │ ─ hotkey hints   │
  └───────────────┘       └──────────────────┘
```

### 1.2 Data flow (hot path)

```
 system speakers
       │  (loopback capture, 16 kHz mono PCM, 20 ms frames)
       ▼
 audio-cap.worker ─────► main (PCM chunks, level meter tick)
       │
       ▼  (WebSocket, raw PCM or PCM→g711 depending on RT API constraints)
 transcription-worker (OpenAI Realtime)
       │
       │  partial transcripts (every ~200 ms)
       │  final transcripts (end-of-utterance)
       ▼
 classifier-worker  ──── heuristic short-circuit ────┐
       │                                             │
       │ (only on ambiguous cases)                   │
       ▼                                             │
  gpt-4o-mini → {is_question: bool, confidence}      │
       │                                             │
       └──────────────► combine ◄────────────────────┘
                          │
                          ▼ (if question)
                   answer-worker
                   ├─ Pass 1: gpt-4o-mini → bullet skeleton (fast)
                   └─ Pass 2: gpt-4o       → full answer (streamed)
                          │
                          ▼
                   overlay (render tokens as they arrive)
```

### 1.3 IPC channel inventory

| Channel                     | From → To         | Payload                                      |
|-----------------------------|-------------------|----------------------------------------------|
| `audio:level`               | main → overlay    | `{ dbfs: number }` (10 Hz)                   |
| `audio:devices`             | main ↔ setup      | list of capture targets                      |
| `audio:start` / `audio:stop`| setup → main      | `{ deviceId, mode: 'loopback'\|'mic' }`      |
| `transcription:partial`     | main → overlay    | `{ text, utteranceId }`                      |
| `transcription:final`       | main → overlay    | `{ text, utteranceId, tStart, tEnd }`        |
| `question:detected`         | main → overlay    | `{ text, confidence }`                       |
| `answer:skeleton`           | main → overlay    | `{ bullets: string[] }`                      |
| `answer:token`              | main → overlay    | `{ text, requestId }` (stream)               |
| `answer:done`               | main → overlay    | `{ requestId, latencyMs }`                   |
| `context:update`            | setup → main      | file blobs + metadata                        |
| `auth:status`               | main → setup      | `{ ok, source, error? }`                     |
| `hotkey:*`                  | main → workers    | regenerate / shorter / longer / hide / mute  |
| `overlay:visibility`        | main ↔ overlay    | show/hide                                    |

---

## 2. Module-by-module breakdown

### 2.1 `main/orchestrator.ts`
- **Responsibility:** App lifecycle, window creation, IPC hub, hotkey registration, worker supervision.
- **Inputs:** app events, IPC from renderers, worker events.
- **Outputs:** window creation, worker start/stop, IPC dispatch.
- **Libs:** `electron` (BrowserWindow, globalShortcut, Tray).
- **Risks:** global shortcut conflicts with Zoom hotkeys. Mitigation: configurable, with conflict detection.

### 2.2 `main/auth.ts`
- **Responsibility:** Read `~/.codex/auth.json`, pick token, handle refresh, expose `getAuthHeader()`.
- **Inputs:** filesystem.
- **Outputs:** `Authorization: Bearer <token>` or typed error.
- **Libs:** `fs/promises`, `jose` (optional, for JWT introspection).
- **Risks:** token format or endpoint acceptance — see §4.

### 2.3 `main/context.ts`
- **Responsibility:** Own the in-memory context bundle (essay, bio, source, rolling transcript). Build the system prompt on demand. Rotate transcript window.
- **Inputs:** `context:update` IPC, transcription finals.
- **Outputs:** `buildSystemPrompt({ questionText })` → string.
- **Libs:** `pdf-parse` for PDF, `mammoth` for .docx, `gpt-tokenizer` for token counting.

### 2.4 `workers/audio-capture.ts`
- **Responsibility:** Spawn platform-native helper binary (Swift on macOS, Rust on Windows), pipe PCM frames to main.
- **Inputs:** device selection.
- **Outputs:** PCM frames (16 kHz, mono, s16le, 20 ms), level meter ticks.
- **Libs:** `child_process`, platform-specific helpers shipped in `resources/native/`.
- **Risks:** permissions, signing — see §3.

### 2.5 `workers/transcription.ts`
- **Responsibility:** Maintain a WebSocket to OpenAI Realtime API, forward PCM, parse transcript events, emit partials + finals.
- **Inputs:** PCM from audio-capture.
- **Outputs:** partial + final transcripts.
- **Libs:** `ws` (WebSocket client).
- **Risks:** reconnection logic, backpressure on slow links.

### 2.6 `workers/classifier.ts`
- **Responsibility:** Decide if a final utterance is a question to the candidate. Heuristic first, LLM tiebreaker.
- **Inputs:** final transcript text.
- **Outputs:** `{ is_question, confidence, reason }`.
- **Libs:** stdlib + `openai` (via fetch, no SDK — keeps bundle small and control over auth).

### 2.7 `workers/answer.ts`
- **Responsibility:** Two-pass answer generation. Pass 1 = skeleton (gpt-4o-mini, <500 ms). Pass 2 = prose (gpt-4o, streamed). Cancellable on `hotkey:regenerate`.
- **Inputs:** question text, system prompt from `context.ts`.
- **Outputs:** `answer:skeleton`, `answer:token` stream, `answer:done`.
- **Libs:** fetch + SSE parser (`eventsource-parser`).

### 2.8 `renderers/setup/` (React)
- **Responsibility:** First-run + settings UI. Uploads, audio device, auth status, hotkey config, start/stop.
- **State:** Zustand store persisted via electron-store.

### 2.9 `renderers/overlay/` (React)
- **Responsibility:** The teleprompter. Receives IPC, renders with streaming animation.
- **State:** ephemeral Zustand; no persistence.

### 2.10 `shared/types.ts`
- **Responsibility:** Single source of truth for IPC payload types. Consumed by main + both renderers.

> **Why Electron + React + TS vs alternatives:** `[HIGH]` Tauri would cut bundle size in half but its audio/IPC story on both OSes is immature; custom native bits are heavier. Tao/Wry lacks `setContentProtection`. `[MED]` Electron's `setContentProtection` is the only well-documented cross-platform screen-capture exclusion. For a 4-week build with cross-platform demands, Electron is the lower-risk pick. Revisit if bundle size becomes a real concern.

---

## 3. Audio capture plan

### 3.1 macOS — ScreenCaptureKit (primary)

- **API:** `ScreenCaptureKit` (`SCStream` + `SCStreamConfiguration.capturesAudio = true`). Available from macOS 13+. `[HIGH]`
- **Delivery:** Small Swift binary `resources/native/mac/audiotap`, bundled, spawned by `workers/audio-capture.ts`. Writes raw 16 kHz mono s16le to stdout; level-meter data on stderr.
- **Permission:** Screen Recording permission (System Settings → Privacy & Security → Screen Recording). `[HIGH]` App must appear in the allowlist. On first run, the app triggers the prompt by starting an `SCShareableContent` query.
- **Signing:** `[MED]` Unsigned builds can still request Screen Recording in development, but permissions may not persist across rebuilds. For distribution, app needs Developer ID signature + notarization. For dev loop, we hard-code the helper path and tell the user to re-grant once.
- **Minimum supported macOS:** 13.0 (Ventura). macOS 12 would require CoreAudio Aggregate-Device hacks — not worth it.
- **Fallback binary:** bundle BlackHole install instructions only if the user is on macOS 12 (detect + refuse with guidance).

### 3.2 Windows — WASAPI loopback (primary)

- **API:** WASAPI loopback mode (`IAudioClient::Initialize` with `AUDCLNT_STREAMFLAGS_LOOPBACK`) on default render endpoint. `[HIGH]` Built into Win10+.
- **Delivery:** Small Rust binary `resources/native/win/audiotap.exe`, built with `cpal` crate's `default_output_device()` + `SupportedStreamConfig` in loopback mode (`cpal` exposes `WasapiLoopback` since v0.15). Resamples to 16 kHz mono s16le, writes to stdout.
- **Permission:** None required. `[HIGH]`
- **Min OS:** Windows 10 build 1809 (1809 introduced reliable per-process audio work; 1709 works for system loopback too).

### 3.3 Mic fallback (both OSes)

- **When:** loopback fails, or user explicitly opts in during setup.
- **Delivery:** `navigator.mediaDevices.getUserMedia({ audio: true })` in a hidden renderer (cheapest path); PCM ferried to main via IPC. Tag captured audio with `source: 'mic'` so classifier knows to ignore utterances that look like the candidate speaking.
- **Warning:** setup UI shows a bright banner — "this picks up your own voice; answers may drift if you speak during the question."

### 3.4 Format contract between helpers and transcription

- 16 kHz, mono, s16le PCM, 20 ms frames (640 bytes).
- Frame timestamps in ns from capture-start, on a side channel.
- Level-meter dBFS, 10 Hz.

### 3.5 Test matrix

| Scenario                             | macOS 13 | macOS 14 | Win 10 22H2 | Win 11 23H2 |
|-------------------------------------|----------|----------|-------------|-------------|
| Zoom call audio → loopback            |    ✓    |    ✓    |     ✓     |     ✓     |
| Meet (Chrome) audio → loopback        |    ✓    |    ✓    |     ✓     |     ✓     |
| Teams (Electron) audio → loopback     |    ✓    |    ✓    |     ✓     |     ✓     |
| Permission re-prompt after helper swap|    ?    |    ?    |      —     |      —     |
| BT headphones as output               |    ?    |    ?    |     ?     |     ?     |

Cells marked `?` will be exercised in Milestone 3 on real hardware — I can't assert them from a plan.

---

## 4. Auth plan — **highest uncertainty in this project**

### 4.1 What we know

- Codex CLI stores tokens at `~/.codex/auth.json` (`%USERPROFILE%\.codex\auth.json` on Windows). `[HIGH]`
- The file structure you described is consistent with what `openai/codex` CLI writes after `codex login` with ChatGPT auth. `[MED]` I have not re-read the source this week; I will in Milestone 1.
- The `tokens.access_token` is a JWT. `[HIGH]`

### 4.2 What is uncertain — **please read**

**The critical question: does `tokens.access_token` work as a Bearer token against `https://api.openai.com/v1/...`?**

- `[LOW]` My prior: **probably not directly.** The Codex CLI's ChatGPT-auth flow issues tokens scoped for a ChatGPT-backend surface, not the public API surface. Codex CLI historically routes requests through a ChatGPT-specific endpoint that accepts those JWTs.
- `[MED]` The same `auth.json` sometimes contains a top-level `OPENAI_API_KEY` string — this is populated when the user has an OpenAI API-platform key, or when Codex CLI exchanges the OAuth token for an API-surface key. If present and non-empty, **that** should work against `api.openai.com`.
- `[UNKNOWN]` Whether OpenAI currently accepts ChatGPT-auth JWTs at `api.openai.com` for any endpoint. This policy has shifted.

### 4.3 Plan

On startup, in this order:

1. Read `~/.codex/auth.json`. If missing → show modal: *"Run `codex login` in a terminal, then restart this app."*
2. Prefer `OPENAI_API_KEY` if present and non-empty. Test with `GET /v1/models`. If 200 → done.
3. Else try `tokens.access_token`. Test with `GET /v1/models`. If 200 → done.
4. If both 401: **do not silently fall back to prompting for a key.** Show error modal with exact recovery steps (re-login; or set `OPENAI_API_KEY` env var; or paste a key into `auth.json` manually). Explain the situation honestly.
5. If `tokens.access_token` is accepted but later returns 401 mid-session, attempt refresh via `tokens.refresh_token` only if we've verified the refresh endpoint from Codex source. Otherwise fall back to re-login message.

### 4.4 Refresh endpoint

`[UNKNOWN]` — will read from `codex-rs` or `codex-cli` source during Milestone 1. I will **not** guess a URL. If the source doesn't plainly expose it, we ship without auto-refresh in v1 and tell the user to re-login on 401.

### 4.5 What I'll report back in Milestone 1

- Exact field names present in your `auth.json` (sanitised).
- Result of `/v1/models` with each candidate token.
- Whether we have a viable refresh path.
- Whether we need a fallback auth strategy (e.g., prompting for a key as a last resort — only if you approve after seeing the data).

---

## 5. Transcription plan

### 5.1 Endpoint choice

- **Primary:** OpenAI Realtime API (`wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview`) in transcription-only mode (`session.update` with `input_audio_transcription.model = "gpt-4o-mini-transcribe"`, no response generation). `[MED]` — this works as of late 2024; will verify version is still current.
- **Fallback:** `POST /v1/audio/transcriptions` with `whisper-1` over ~1.5-second chunks bounded by VAD. Higher latency (~2 s round-trip), used if Realtime is unavailable or too expensive.

### 5.2 Streaming protocol

- Open WS, send `session.update` to configure input format (pcm16, 16 kHz) and transcription model.
- Every 20 ms, append a PCM frame as `input_audio_buffer.append` (base64).
- On VAD end (server-side VAD configured), server emits `conversation.item.input_audio_transcription.completed` → final transcript.
- Also listen for `conversation.item.input_audio_transcription.delta` for partials.

### 5.3 Chunking + VAD

- Server-side VAD via Realtime API's built-in `turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }`. `[MED]`
- Local VAD (`@ricky0123/vad-web` or `silero-vad` WASM) as a second gate, to pause the stream when nobody's talking — saves tokens. `[HIGH]` — trivial to add.

### 5.4 Expected latency

- Partial transcript: 200–500 ms after speech. `[MED]`
- Final transcript: 300–700 ms after utterance end. `[MED]`

### 5.5 Cost estimate

- `gpt-4o-mini-transcribe` ≈ $0.003/min input audio. `[MED]` (price as of late 2024.)
- A 30-minute interview ≈ $0.09.
- Combined with answer LLM (~$0.02–0.10 per interview with gpt-4o), total ~$0.30/session.

### 5.6 Risks

- Realtime API rate-limit or region variance — fallback path exercised during Milestone 4.
- Tokens-per-minute cap on a personal account — set low token caps on the answer side to compensate.

---

## 6. Question-detection plan

**Hybrid: heuristic short-circuit + LLM tiebreaker.** Justification: latency. A pure-LLM classifier adds 300–600 ms to every final utterance, most of which are trivially classifiable.

### 6.1 Heuristic pass (local, ~0 ms)

Rules, in order:

1. Strip trailing whitespace. If last char is `?` → `{is_question: true, confidence: 0.95, reason: 'terminal ?'}`.
2. First 6 tokens match one of: `what`, `how`, `why`, `when`, `where`, `who`, `which`, `tell me`, `describe`, `explain`, `walk me through`, `could you`, `would you`, `can you`, `would you mind`, `do you`, `are you`, `have you`, `is there`, `is it true` → `{confidence: 0.75, reason: 'question opener'}`.
3. Contains phrase `I'd like to hear` / `I want to know` / `talk to me about` → `{confidence: 0.7, reason: 'invitation'}`.
4. Length < 4 words AND ends with noun phrase → `{confidence: 0.3, reason: 'fragment, pass to LLM'}`.
5. Otherwise → `{confidence: 0.2, reason: 'declarative default, pass to LLM if near threshold'}`.

### 6.2 LLM tiebreaker (when heuristic confidence ∈ [0.3, 0.8])

```
System: You classify utterances from a university admissions interviewer.
Output JSON: {"is_question_to_candidate": bool, "reading_source": bool, "reason": "..."}.
Categories:
- is_question_to_candidate: the interviewer is prompting the candidate to speak.
- reading_source: the interviewer is reading aloud from an article/passage.
- Neither: small talk, statements, acknowledgements.

Examples:
"So, tell me a little about yourself." → {"is_question_to_candidate": true, "reading_source": false, "reason": "invitation to speak"}
"Quantum computing leverages superposition..." → {"is_question_to_candidate": false, "reading_source": true, "reason": "expository statement"}
"I see, that makes sense." → {"is_question_to_candidate": false, "reading_source": false, "reason": "acknowledgement"}
"And why do you think that is?" → {"is_question_to_candidate": true, "reading_source": false, "reason": "follow-up question"}
"The source argues, and I quote, that..." → {"is_question_to_candidate": false, "reading_source": true, "reason": "quoting source"}
"What would you do if you were in that position?" → {"is_question_to_candidate": true, "reading_source": false, "reason": "hypothetical prompt"}
"Hmm." → {"is_question_to_candidate": false, "reading_source": false, "reason": "filler"}
"Can you read the first paragraph for me?" → {"is_question_to_candidate": false, "reading_source": false, "reason": "instruction, not content question"}

Utterance: "{text}"
```

Model: `gpt-4o-mini`. Temperature 0. Max tokens ~60. `response_format: { type: "json_object" }`.

### 6.3 Combination rule

- Heuristic confidence ≥ 0.85 → use heuristic result.
- Otherwise → ask LLM, use its `is_question_to_candidate`.
- If `reading_source: true` → suppress answer, but flag the utterance as source context (feed into context store for the next question).

### 6.4 Edge case: what if the user is on mic fallback?

Add a third category `candidate_speaking` to the LLM prompt; also down-weight utterances where mic peak amplitude was high during capture (likely the user's own voice).

### 6.5 Known limitations

- Rhetorical questions by the interviewer will false-positive. Mitigation: they're rare in admissions, and the user can hit the mute hotkey.
- Heavily accented speech → transcription errors → classifier garbage in/out. Not solvable at this layer.

---

## 7. Answer generation plan

### 7.1 Two-pass streaming

| Pass | Model                      | Output                  | Target latency          |
|------|----------------------------|-------------------------|-------------------------|
| 1    | `gpt-4o-mini`              | 3–5 bullet skeleton     | first token ≤ 400 ms    |
| 2    | `gpt-4o` (or `gpt-4.1`)    | 30–60 s spoken answer   | first token ≤ 900 ms    |

Both streamed via SSE. Pass 2 starts the moment Pass 1's prompt is sent; they run in parallel.

### 7.2 System prompt (answer generator, Pass 2)

```
You are a discreet teleprompter helping {name} answer a live university admissions interview.

Your job: produce a natural spoken answer (~30–60 seconds when read aloud).

Hard rules:
1. Use {name}'s own voice, tone, and facts drawn from their essay and bio below. Mirror phrasing they already use.
2. NEVER invent achievements, awards, projects, publications, grades, or experiences. If the essay/bio does not contain a fact, do not introduce it.
3. If the question concerns the SOURCE TEXT, ground every claim in the source. Quote sparingly; paraphrase mostly.
4. Open with a direct claim — no wind-up, no "that's a great question."
5. Two or three concrete specifics. One honest caveat or complication. A brief close.
6. If the question is hostile or adversarial, stay measured.

=== ESSAY (full) ===
{essay}

=== BIO ===
{bio}

=== SOURCE TEXT (if any) ===
{source}

=== RECENT TRANSCRIPT (last ~3 min) ===
{rolling_transcript}

=== CURRENT QUESTION ===
{question}
```

**Token budget:**
- Essay: 800–2000 tokens.
- Bio: 150–400.
- Source: up to 2000 (truncated with ellipsis if longer, head + tail sliced around mentions).
- Rolling transcript: 800 token window.
- Answer output: cap at 400 tokens (~60 s speech).
- System prompt + context + answer ≤ 8k tokens → well under gpt-4o's 128k.

### 7.3 Pass 1 (skeleton) prompt

Shorter. Same context, asks for:
> "Output only a JSON array of 3–5 short bullets (each ≤ 10 words) that would structure a spoken answer. No preamble."

Shown immediately above the streaming prose. Gives the user something to glance at while Pass 2 is still generating.

### 7.4 Controls (hotkeys)

- **Regenerate** (`Cmd/Ctrl+Shift+R`): cancel in-flight streams, re-issue both passes with a nonce.
- **Shorter** (`Cmd/Ctrl+Shift+S`): resubmit Pass 2 with suffix "Rewrite the above to be half as long, keep the same claims."
- **Longer** (`Cmd/Ctrl+Shift+L`): same, "Rewrite with one more specific example from the essay."
- **Follow-up** (future): inline text box in overlay ("what's the source for this claim?") — v1.1, not v1.

### 7.5 Cancellation discipline

- Each answer request gets a `requestId`. Any incoming `hotkey:regenerate` increments the counter; stale tokens are dropped at the renderer.
- `AbortController` on the fetch to actually close the stream and stop billing.

---

## 8. UI plan

### 8.1 Aesthetic direction

**Editorial, calm, authoritative.** This is a high-stakes moment — the overlay should feel like a trusted cue card, not a SaaS dashboard. Think broadsheet typography, generous leading, no gradients, no glass effects, no purple. A single warm accent for "recording" and "active" states.

- **Type:**
  - Display (question + answer body): **Fraunces** (variable serif, has opsz + wght axes, handles both display and body gracefully).
  - UI (status strip, hotkey hints): **Geist Mono** (neutral, precise, reads well at small sizes).
  - No Inter. No Space Grotesk. No Arial.
- **Palette:**
  - Background: `#0b0b0d` with a 4% white-noise overlay (subtle paper-grain texture).
  - Primary text: `#f1ece1` (warm off-white).
  - Muted text: `#9a9488`.
  - Accent (REC dot, active bullet): `#d4a84b` (muted amber — not red, which reads as "error").
  - Hairline: `#24221f`.
- **Motion:**
  - Token fade-in: 120 ms ease-out opacity 0→1, no slide.
  - New question card: 220 ms ease-out, subtle 6 px slide-down + opacity.
  - REC dot: 1.2 s pulse, scale 1 → 1.15 → 1.
  - Skeleton bullet appear: stagger 60 ms per bullet.
- **Grain:** single CSS-only SVG feTurbulence noise, at 3% opacity, blend-mode overlay.

### 8.2 Overlay wireframe (420 px wide)

```
┌──────────────────────────────────────────────┐
│  ● REC   234ms   ▍▍▍▍▍▎ ▁▁           · · · ▾│  ← drag handle, status strip, menu (20px)
├──────────────────────────────────────────────┤
│                                              │
│  "What draws you to physics over                ← Fraunces 18px italic, "muted" color
│   engineering?"                                   leading 1.35
│                                              │
│  ─────────                                        ← 40px amber hairline
│                                              │
│  · Physics asks why, not just how            │  ← bullets, Fraunces 15px
│  · First encounter: Feynman lectures, 2022   │     amber tick on leading bullet
│  · Essay's Newton's-cradle moment            │
│  · Honest: engineering tempting for impact   │
│  · Physics wins because curiosity compounds  │
│                                              │
│  ─────────                                        ← hairline
│                                              │
│  Engineering's pull is real — I spent two    │  ← Fraunces 17px, leading 1.55
│  summers at a robotics lab and loved it.        (the "answer" body, streamed)
│  But physics asks a different question.         tokens fade in at 120 ms
│  The first time I read Feynman's lectures,      caret blink while streaming
│  I realised "why" was the one question I'd  ▮│
│                                              │
├──────────────────────────────────────────────┤
│  ⌘⇧R regen  ⌘⇧S shorter  ⌘⇧L longer  ⌘⇧H hide │  ← Geist Mono 11px, muted
└──────────────────────────────────────────────┘
```

Collapsed height: ~320 px. Expanded (full answer + source reference): ~560 px. User-resizable by dragging bottom edge.

### 8.3 Setup window wireframe (~800 × 600)

```
┌───────────────────────────────────────────────────────────┐
│  Interview Copilot                                   ☰   │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │ AUTH    ●  connected (openai, via codex)          │   │  ← status chip
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  CONTEXT                                                  │
│  ┌────────────────────┐  ┌────────────────────┐         │
│  │  Essay             │  │  Bio / About-me    │         │
│  │  essay-v4.pdf      │  │  bio.txt           │         │
│  │  1,840 words       │  │  312 words         │         │
│  └────────────────────┘  └────────────────────┘         │
│  ┌────────────────────┐  ┌────────────────────┐         │
│  │  Source text       │  │  + Add other       │         │
│  │  (optional)        │  │    (past Qs, CV)   │         │
│  └────────────────────┘  └────────────────────┘         │
│                                                           │
│  AUDIO                                                    │
│  ┌───────────────────────────────────────────────────┐   │
│  │  ◉ System audio (recommended)                     │   │
│  │     default output ▾                              │   │
│  │  ○ Microphone (fallback — picks up your voice)    │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  HOTKEYS                              [edit]             │
│  regenerate      ⌘⇧R                                     │
│  shorter / longer ⌘⇧S  ⌘⇧L                               │
│  hide overlay    ⌘⇧H                                     │
│  mute listening  ⌘⇧M                                     │
│                                                           │
│                                   ┌──────────────────┐   │
│                                   │  Start listening │   │
│                                   └──────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

### 8.4 Component tree (overlay)

```
<OverlayApp>
  <StatusStrip>
    <RecDot />
    <LatencyReadout />
    <LevelMeter />
    <DragHandle />
    <MenuChevron />
  </StatusStrip>
  <QuestionCard text={question} visible={!!question} />
  <Skeleton bullets={bullets} activeIndex={activeBullet} />
  <AnswerBody tokens={streamingTokens} done={done} />
  <HotkeyHints collapsed={hintsCollapsed} />
  <GrainOverlay />
</OverlayApp>
```

### 8.5 State management

- Zustand store per window. Overlay store is ephemeral. Setup store persists to `electron-store`.
- Avoid Redux — overkill here.

---

## 9. Hotkeys + screen-share hiding

### 9.1 Global hotkeys

- `electron.globalShortcut.register()` at app ready.
- Defaults as specified; user-overridable in setup.
- On registration conflict, surface a warning with the conflicting combination.

### 9.2 Screen-share hiding (critical)

**Electron API:** `BrowserWindow.setContentProtection(true)`. `[HIGH]`

- **macOS:** sets `NSWindow.sharingType = .none`. Excluded from AVFoundation, ScreenCaptureKit, and legacy CoreGraphics captures. Zoom on macOS uses ScreenCaptureKit (from Zoom 5.13+) — confirmed exclusion. `[MED]` Teams and Meet use similar APIs.
- **Windows:** translates to `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`. Works on Windows 10 2004+. `[MED]` Zoom, Teams, Meet on Win10/11 honour this in their standard share modes.

### 9.3 Known bug surface to verify

- **Hardware-accelerated capture bypass:** some OBS plugins, NDI bridges, and certain "window capture" modes in screen tools ignore content protection. Out of scope — we'll document the limitation, not solve it.
- **Electron version:** `setContentProtection` on macOS had a regression around Electron 21. We'll pin to Electron ≥ 30. `[MED]`
- **Transparent + click-through + content-protected combo:** not all flag combinations play well on all OSes. We will test this specific combination early.

### 9.4 Verification plan

Manual test, documented in `tests/manual/screen-share.md`:

1. Install target app, run it with overlay visible.
2. Start Zoom call (self-recording in cloud).
3. Share full screen.
4. Record 30 s.
5. Play back the recording: overlay must not appear.
6. Repeat for Meet (Chrome share), Teams, QuickTime recording, OBS "Display Capture".

This is a binary gate on Milestone 8. If it fails, v1 ships with a clearly disclosed limitation and we investigate before v1.1.

---

## 10. File storage plan

### 10.1 Paths

All under Electron `app.getPath('userData')`:

```
<userData>/
├── context/
│   ├── essay.txt          # extracted plain text
│   ├── essay.meta.json    # { originalName, bytes, uploadedAt }
│   ├── bio.txt
│   ├── bio.meta.json
│   ├── source.txt
│   ├── source.meta.json
│   └── other/
│       ├── <uuid>.txt
│       └── <uuid>.meta.json
├── transcripts/
│   └── 2026-04-17_143022.json   # { utterances, questions, answers, settings }
├── settings.json
└── auth-cache.json              # cached smoke-test result, not the token itself
```

### 10.2 Extraction

- `.txt` / `.md`: read as UTF-8.
- `.pdf`: `pdf-parse` → plain text. Extract once on upload, cache.
- `.docx`: `mammoth` → plain text.
- `.rtf`, `.pages`, `.odt`: reject with clear message. v1 scope.

### 10.3 Transcript schema

```ts
type Transcript = {
  sessionId: string;
  startedAt: string;   // ISO
  endedAt: string;
  utterances: Array<{
    id: string;
    tStart: number;    // seconds from sessionStart
    tEnd: number;
    text: string;
    source: 'loopback' | 'mic';
    isQuestion: boolean;
    classifierReason?: string;
  }>;
  questions: Array<{
    utteranceId: string;
    skeleton: string[];
    finalAnswer: string;
    latencyMs: { firstToken: number; done: number };
  }>;
};
```

### 10.4 Context assembly rule

- Essay, bio, source: always included in system prompt (if uploaded).
- Rolling transcript: last 3 minutes, token-capped at 800. Tail-biased — drop from the head first.
- When a `reading_source` utterance is detected, it's appended to an in-memory "source observations" list and also included in context, separate from the transcript.

---

## 11. Risk register

Top 10, ranked by "chance × impact". Blunt.

| # | Risk                                                                                       | Likelihood | Impact    | Mitigation                                                                 |
|---|--------------------------------------------------------------------------------------------|------------|-----------|----------------------------------------------------------------------------|
| 1 | **Codex OAuth JWT not accepted at api.openai.com**                                         | HIGH       | Blocker   | Smoke-test at Milestone 1. If fails, escalate to you with options (§4.5).  |
| 2 | **Latency budget (2 s to first token) unachievable on typical residential link**           | MED        | UX-critical | Measure early. If >2.5 s median, drop Pass 1 → single-pass skeleton-then-prose from gpt-4o. |
| 3 | **setContentProtection fails against some screen-share mode we care about**                | MED        | High      | Test grid in §9.4. If one app leaks, document limitation, ship anyway.     |
| 4 | **macOS ScreenCaptureKit permission UX is broken on unsigned builds**                      | MED        | Dev-only  | Document dev-signing workflow with ad-hoc identity; re-grant per build.    |
| 5 | **Classifier false positives during interviewer monologue**                                | HIGH       | Annoyance | Confidence threshold + mute hotkey. Collect transcripts, tune heuristics.  |
| 6 | **Answer LLM invents achievements despite prompt**                                         | MED        | High      | Strong "NEVER invent" clause, citation-style hint, `temperature=0.3`.      |
| 7 | **PDF essay extraction garbles formatting-heavy PDFs**                                     | MED        | Medium    | Show extracted text in setup UI. User verifies before starting.            |
| 8 | **Realtime API disconnects mid-session**                                                   | MED        | Medium    | Auto-reconnect with exponential backoff; fall back to whisper-1 if persistent. |
| 9 | **Global hotkey conflicts with meeting app (Zoom ⌘⇧M is mute-self!)**                      | HIGH       | Blocker-ish | Our `⌘⇧M` = "mute listening" clashes with Zoom's. Change default to `⌘⇧P`. |
| 10| **Context overflow from long essay + long source + transcript**                            | LOW        | Medium    | Token counting pre-send; trim source first, then transcript tail.          |

**Where I'm guessing:**
- #1 — significant. See §4.
- #3 — I believe the happy path works, but haven't personally tested against Zoom's latest version in 2025.
- #4 — permission-persistence behaviour on macOS varies; needs hardware test.

---

## 12. Build & test plan

### 12.1 Automated

- **Unit:** auth parser, context assembly, token budgeting, classifier heuristic, transcript schema (Vitest).
- **Integration:** mock OpenAI server (Msw or a fake WS) → exercise full pipeline with a recorded WAV input.
- **E2E renderer:** Playwright against each BrowserWindow for click/keyboard flows.
- No Electron-main E2E — too fragile; rely on manual.

### 12.2 Mock audio fixtures

- `tests/fixtures/audio/mock-interview-01.wav` — 3 minutes, pre-recorded by us, containing:
  - 4 clear questions
  - 1 rhetorical/statement
  - 1 source-reading segment
  - Normal-volume speech at 16 kHz.
- Helper: `tools/pipe-wav.ts` — reads WAV, emits PCM frames at wallclock speed into the audio-capture IPC, bypassing the native helper. Use this for deterministic pipeline testing.

### 12.3 Manual tests (required before calling any milestone done)

Documented in `tests/manual/`:

1. **macOS permission first-run** — delete Screen Recording grant, launch app, walk through prompt.
2. **Windows fresh install** — unzipped build, first launch, loopback works.
3. **Real Zoom call** — friend on the other end, audio captured and transcribed.
4. **Screen-share exclusion** — per §9.4.
5. **Latency stopwatch** — question asked → first token visible, measured 10× per platform, median reported.
6. **Hallucination probe** — ask a question whose answer isn't in the essay ("what was your SAT score?"). Verify the answer explicitly says it doesn't know, doesn't invent a number.
7. **Cancellation** — hit regenerate mid-stream, confirm old tokens stop and new ones start.
8. **Crash recovery** — kill transcription worker, app should recover gracefully.

### 12.4 Out of scope for v1

- Telemetry of any kind.
- Cloud sync of context or transcripts.
- Multi-user profiles.
- Mobile / web clients.
- Non-English interviews.

---

## 13. Milestones

Each ends with a commit, a way you can test it, and a short list of what's next. I check in between each.

---

### M1 — Scaffold + auth smoke test (½ day)
- Init Electron + Vite + React + TS. Two BrowserWindows (setup, overlay), minimal.
- Implement `auth.ts`. Read `auth.json`. Call `GET /v1/models` with the candidate tokens.
- **Report to you:** which token worked, full error text if neither did.
- **You can test:** `pnpm dev` → setup window shows auth status chip (green/red + reason).
- **Gate:** if neither token works, stop and discuss §4.5 options.

### M2 — Setup window: uploads + extraction (½ day)
- Drag-drop essay/bio/source/other. PDF + docx + txt extraction. Show word count + preview.
- Persist to `<userData>/context/`.
- **You can test:** drop your essay PDF, see extracted text and word count.

### M3 — Native audio helpers (1–1.5 days)
- Swift `audiotap` for macOS (ScreenCaptureKit, stdout PCM).
- Rust `audiotap.exe` for Windows (cpal + WASAPI loopback).
- Electron worker spawns correct binary, receives frames, emits level meter.
- Mic fallback via getUserMedia.
- **You can test:** start listening, play a YouTube video, watch level meter move; dump 5 s of PCM to a WAV and confirm it's clean audio.
- **Gate:** if loopback fails on either OS, mic fallback still unblocks the rest.

### M4 — Transcription pipeline (1 day)
- Realtime API WebSocket. Forward PCM. Emit partial + final transcripts.
- Whisper-1 fallback path.
- Render partial transcripts in a debug overlay pane (removed before shipping).
- **You can test:** speak into the system; see live caption in the overlay.

### M5 — Classifier (½ day)
- Heuristic rules + gpt-4o-mini tiebreaker.
- Log every decision to the transcript for later tuning.
- **You can test:** read out a mix of questions and statements; `question:detected` fires only on real questions.

### M6 — Overlay UI + streaming answer (mocked) (1 day)
- Full overlay: status strip, question card, skeleton, answer body, hotkey hints, grain, motion. Fraunces + Geist Mono.
- Frameless, transparent, always-on-top. Drag handle.
- Mocked answer source streams canned tokens.
- **You can test:** the overlay looks right at your desk, above your webcam.

### M7 — Real answer generation + context assembly (½ day)
- Wire `context.ts`, system prompt builder, Pass-1 + Pass-2 parallel streams.
- Cancellation via `AbortController`.
- **You can test:** ask a real question aloud, see grounded answer stream in.

### M8 — Hotkeys + content protection verification (½ day)
- `globalShortcut` registration with conflict detection; `⌘⇧M` → `⌘⇧P` (Zoom collision).
- `setContentProtection(true)`.
- Run §9.4 test grid.
- **You can test:** share screen on Zoom to a friend, confirm overlay invisible.
- **Gate:** if content protection leaks on a target app, flag it.

### M9 — Transcript persistence + debrief (½ day)
- Write transcripts to disk per §10.3.
- Simple post-session summary ("questions you stumbled on = longest pauses before speaking").
- **You can test:** after a session, open the transcript JSON; launch debrief view.

### M10 — End-to-end polish + real Zoom test (1 day)
- Real interview rehearsal with a friend interviewer.
- Fix top 3 pain points surfaced.
- Package for macOS (dmg) + Windows (nsis).
- **You can test:** install the built artifact on a clean machine, run through setup, do a mock interview.

**Total:** ~7–8 working days at a steady pace. I will flag any blocker that makes that estimate laughable within 24 hours of hitting it.

---

## 14. Open questions for you

These don't block planning but will shape later decisions:

1. Your name, for the system prompt's `{name}` placeholder — want it read from bio automatically, or set explicitly in setup?
2. Any institution-specific tuning? (e.g., "Oxbridge-style Socratic probing" vs. "US holistic interview" — affects prompt tone.)
3. Do you want voice output of the answer (TTS) as a v1.1 option, or just text on the overlay? (I'd say text only for v1 — less distracting.)
4. Is it acceptable to have a one-time dev build signed with an ad-hoc identity on your macOS machine, re-signing per meaningful change? Alternative is an Apple Developer account ($99/yr) for a smoother cert path.

---

## 15. What I'd like you to approve or change before I start

- [ ] The Electron + React + TS stack choice (§2).
- [ ] The auth plan, **especially** the stop-and-escalate behaviour if Codex tokens don't work (§4.5).
- [ ] The aesthetic direction for the overlay (§8.1) — if you hate warm serifs say so now, not in M6.
- [ ] The milestone order and granularity (§13).
- [ ] The `⌘⇧M` → `⌘⇧P` hotkey swap (§11 #9).
- [ ] Answers to §14 questions 1–4.

Say "go" (with any changes) and I'll start M1.
