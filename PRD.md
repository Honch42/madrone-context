# Product Requirement Document (PRD)
## PRD for the Interview-Based Proactive Context Platform (Madrone Context)

* **Document Version:** 1.1 (updated to match the shipped code)
* **Date:** September 11, 2026 (original draft September 7, 2026)
* **Target OS:** macOS (Apple Silicon Optimized)
* **Author:** Antigravity (Autonomous Systems Architecture) & John Honchariw
* **Status note:** Sections 1 to 10 describe the product vision. Where the shipped app differs, a *Status* line says so. Section 11 is the authoritative description of what is built as of this version.

---

## 1. Executive Summary & Core Thesis

### 1.1 The Context Problem in Advanced AI
Modern artificial intelligence models and autonomous coding agents are fundamentally constrained by the quality and dimensionality of the context available to them. Current agentic frameworks rely almost exclusively on **passive telemetry**—ingesting files, shell history, screen captures, emails, and git diffs. 

While passive telemetry accurately records *what* occurred on a machine, it completely fails to capture the **first-order drivers**:
* *Why* a specific architectural or business trade-off was chosen over alternatives.
* The emotional friction, hesitation, or unstated doubts behind a decision.
* Strategic aspirations, personal motivations, and implicit non-negotiable constraints.

### 1.2 Product Vision & Primary Objective
The **Interview-Based Proactive Context Platform** is an intelligent, autonomous interviewing system designed to proactively elicit, record, synthesize, and structure the human user's active context. 

By conducting fluid, low-friction spoken interviews recorded via laptop webcam and microphone, the platform extracts the underlying "why" of human work and thought. It processes spoken language alongside non-verbal behavioral cues (facial tension, hesitation, vocal energy) and compiles structured, cumulative intelligence dossiers. These dossiers are preserved locally as plain Markdown (optionally inside an Obsidian vault), which any sync tool can carry to other machines and any filesystem-reading agent (Antigravity, Claude Desktop, Cursor) can consume directly.

---

## 2. User Personas, Workflows & Cadence

### 2.1 Cadence Modes
The platform supports three primary operational modalities:

```
+-------------------------------------------------------------------------+
|                       DAILY INTERVIEW CADENCE                           |
+-------------------------------------------------------------------------+
|                                                                         |
|  [01. Morning Proactive]  --->  [02. Ad-Hoc / Mid-Day]  --->  [03. Evening Debrief]
|  - Forward-looking agenda       - Spontaneous capture         - Rearward-facing review
|  - Calendar inspection          - Unload sudden friction       - Screenpipe OCR review
|  - Hypotheses alignment         - "Stream of consciousness"    - Decision rationale
|                                                                         |
+-------------------------------------------------------------------------+
```

1. **Morning Proactive Alignment (Forward-Looking):**
   * Conducted at the start of the workday (typically 5–10 minutes).
   * Focus: Daily priorities, key meetings, strategic intentions, anticipated blockers, and cognitive focus areas.
2. **Evening / Post-Work Debrief (Rearward-Facing):**
   * Conducted after completing daily work (typically 10–15 minutes).
   * Focus: Ingests the day's passive footprint (Screenpipe screen OCR, unread Slack messages, starred emails) and asks targeted questions: *"Why did we pivot away from X at 2 PM?"* or *"What was the key realization while writing that memo?"*
3. **Ad-Hoc / Mid-Day Context Dump (On-Demand):**
   * Triggered spontaneously when the user recognizes they have critical context, strategic shifts, or emotional friction to unload.
4. *(Future V2.0 Milestone)* **Autonomous Proactive Interruption:**
   * Intelligent background monitoring that gently pings the user when deep context gaps are detected during long working sprints.

*Status (Sept 2026):* the app runs one session type, the ad-hoc interview. The rearward and forward context of the morning and evening modes is available on request inside any session by saying "catch me up" or "what's coming up". Dedicated morning and evening modes with a pre-built agenda are Phase 2 work.

---

## 3. Product Principles & User Experience (UX)

### 3.1 "Stream-of-Consciousness" Verbal Flow
Inspired by high-speed dictation tools like Wispr Flow, the user experience prioritizes uninterrupted cognitive flow. The user should never feel burdened by managing buttons, start/stop toggles, or precise sentence construction. The system encourages raw verbal brain dumps, leaving synthesis, filtering, and summarization to downstream models.

### 3.2 Distraction-Free Typography UI (Zero Vanity)
* **No Self-View Mirror:** User research shows displaying a live webcam mirror induces vanity, self-consciousness, and continuous self-grooming, undermining authentic reflection. The webcam records quietly in the background without rendering the user's face.
* **Large-Text Question Prompt:** The AI’s current question is displayed prominently in clean, high-contrast, large typography. The AI never speaks aloud: reading is faster than listening, the interface stays silent, and there is no risk of the AI's voice feeding back into the microphone.
* **Subtle State Indicators:** Clean, unobtrusive visual states indicating whether the system is `Listening`, `Thinking`, or `Paused`, plus an elapsed-time counter.

```
+-------------------------------------------------------------------------+
|                      INTERVIEW INTERFACE (HUD)                          |
+-------------------------------------------------------------------------+
|                                                                         |
|     "What made you decide to abandon the Redis caching layer            |
|      in favor of SQLite during this afternoon's refactor?"              |
|                                                                         |
|                                                                         |
|                [ ● LISTENING   04:12 ]                                  |
|                                                                         |
|   [Space: Finish speaking]  [Shift+Esc: Pause]  [Cmd+Enter: Conclude]   |
+-------------------------------------------------------------------------+
```

### 3.3 Cognitive Time Boxing & Session Lifecycle
* **15–20 Minute Upper Ceiling:** Aligned with research on sustained verbal focus and cognitive fatigue, sessions are limited to an upper boundary of 15–20 minutes. At 15 minutes the timer turns amber, the user is reminded, and the model is told to guide the conversation toward a natural summary.
* **User-Driven Early Exit:** The user can end a session at any time with `Cmd+Enter`. Saying "let's wrap up" prompts the model to ask one final summarizing question. Whatever the user was saying when they concluded is still transcribed into the note.
* **Pause & Resume:** If interrupted by a phone call, urgent task, or distraction, the user can hit `Shift + Escape` to pause recording and resume where they left off. *Status:* pause is in-memory only; closing the app ends the session (the recording so far is kept). Resuming a session after the app is closed is future work.
* **Post-Session Review:** Upon conclusion, the UI presents a summary within seconds, built from the transcript. With Gemini models the video analysis (insights and behavioral alignment) arrives in the background and is added to the note when the user saves.
  * Action buttons: `[Save to notes]`, `[Discard session]` (deletes the recording), `[Save & investigate discrepancies]` (starts a follow-up interview about a flagged incongruence).

### 3.4 Invocation & Shortcuts
* **Global Shortcut:** `Shift + Globe` (or user-configurable hotkey) summons the interview interface from anywhere on macOS. *Status:* not built yet.
* **Turn Override:** `Spacebar` acts as an immediate manual signal for *"I am done speaking,"* bypassing the silence timeout (1.8 seconds by default, adjustable in Settings).

---

## 4. System Architecture & Technical Specifications

*This section describes the app as built. The original draft proposed a Python/PyWebView stack; the MVP was built on Electron instead, and that is what ships.*

```
+-------------------------------------------------------------------------+
|                        SYSTEM ARCHITECTURE                              |
+-------------------------------------------------------------------------+
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |                Electron app (Chromium renderer)                 |   |
|   |  - Large-text HUD, silence detection, keyboard shortcuts        |   |
|   |  - MediaRecorder: 720p WebM streamed to disk in 3 s chunks      |   |
|   |  - Settings / setup page                                        |   |
|   +-------------------------------+---------------------------------+   |
|                                   | (two WebSockets on 127.0.0.1)       |
|   +-------------------------------v---------------------------------+   |
|   |               Node.js orchestrator (Express + ws)               |   |
|   |  - Session state machine, transcript, note + dossier writer     |   |
|   |  - Secrets encrypted with Electron safeStorage (macOS Keychain) |   |
|   +----+--------------------------+---------------------------+-----+   |
|        |                          |                           |         |
|   +----v------------+      +------v-----------+        +------v-----+   |
|   | Context sources |      |  Model adapters  |        |  Storage   |   |
|   | - Screenpipe DB |      | - Gemini (native |        | - Markdown |   |
|   | - Google OAuth  |      |   audio + video) |        |   notes    |   |
|   | - Read-only MCP |      | - Claude / GPT   |        | - WebM     |   |
|   |   on the vault  |      |   via transcript |        |   archives |   |
|   +-----------------+      +------------------+        +------------+   |
|                                                                         |
+-------------------------------------------------------------------------+
```

### 4.1 Tech Stack (as built)
* **Shell:** Electron (Chromium + Node.js), macOS only. A single window with the native traffic lights; closing it quits the app and releases the camera.
* **Backend:** Node.js, Express and `ws`, started inside the Electron main process and bound to `127.0.0.1` on a random port so nothing on the network can reach it.
* **SDKs:** `@google/genai`, `@anthropic-ai/sdk`, `openai`, `googleapis`, `@modelcontextprotocol/sdk` plus the bundled `@modelcontextprotocol/server-filesystem`.
* **Credential Vault:** API keys and Google tokens are encrypted with Electron's `safeStorage`, which uses the macOS Keychain, before being written to the app's settings file. Nothing is stored in plaintext.

### 4.2 Conversational Loop Engine (turn-based)
1. The AI's question is rendered in large type. Nothing is spoken aloud.
2. The microphone records continuously, even while the model is thinking, so nothing the user says is lost.
3. A turn ends when 1.8 seconds of silence follow speech (adaptive to the room's noise floor), or immediately on `Space`.
4. The turn's audio goes to the model: Gemini models hear the audio directly and return `{transcript, question}`; Claude and GPT receive a transcript produced by Gemini Flash (see 11.1).
5. The next question appears; the loop repeats. At the soft time limit the model is instructed to wind down.
* **V2 Roadmap (Duplex Streaming):** Migration to continuous bidirectional streaming (e.g. Gemini Live) remains a future option.

### 4.3 Pluggable BYOK (Bring-Your-Own-Key) Engines
The user pastes their own keys. Gemini is required for every configuration because it does the transcription; the other vendors are optional upgrades.

| Engine layer | Built today | Notes |
| :--- | :--- | :--- |
| **Conversational brain** | Gemini 3.6 Flash, Gemini 3.1 Pro, Claude Sonnet 5, Claude Fable 5.1, GPT-4o, GPT-4o mini | Model list lives in one place (`src/providers.js`) so it can be updated without touching the rest of the app. |
| **Speech-to-text** | Gemini 3.6 Flash | Used for Claude and GPT turns and for the final utterance at conclusion. Swappable behind one small class. |
| **Voice synthesis** | None, by design | The AI reads its questions on screen. Removed from scope. |
| **Video / delta analysis** | Gemini models | Claude and GPT sessions archive the recording for later analysis and use the transcript only. |
| **File tools** | Read-only filesystem MCP on the notes folder | Available to Claude and GPT; Gemini's JSON response mode does not combine with tool calls yet. |

### 4.4 Hardware & Media Recording Pipeline
* **Capture profile:** 1280×720 at up to 24 fps (15 requested), VP9/VP8 video at about 0.8 Mbps and Opus audio at 64 kbps, in a WebM container. A 15-minute session is roughly 90 MB.
* **Container resilience:** the recorder emits a chunk every 3 seconds, which the orchestrator appends to `archives/YYYY/MM/<session-id>_video.webm` as it arrives. A crash, sleep or battery cut leaves a playable partial file.
* **Audio-only fallback:** if no camera is available or permission is refused, the session records audio only and skips video analysis.

---

## 5. Agenda Generation & Context Ingestion Triad

Before launching an interview, the orchestrator constructs a targeted prompt agenda using three input modes:

```
                                  +-----------------------------+
                                  |   AGENDA GENERATION TRIAD   |
                                  +--------------+--------------+
                                                 |
         +---------------------------------------+---------------------------------------+
         |                                       |                                       |
+--------v----------------------+       +--------v----------------------+       +--------v----------------------+
| 1. REARWARD-FACING            |       | 2. FORWARD-LOOKING            |       | 3. USER-SPECIFIED             |
| - Screenpipe OCR (Recent app) |       | - Google Calendar (Next 24h)  |       | - Custom user text prompt     |
| - Unread Slack / Starred Mail |       | - Incomplete prior goals      |       | - Ad-hoc strategic topic      |
| - Git commits & file diffs    |       | - System proactive hypotheses |       | - Spontaneous friction dump  |
+-------------------------------+       +-------------------------------+       +-------------------------------+
```

*Status (Sept 2026):* the agenda is not built before the interview. The opening question is generated from the Master Dossier, and the rearward and forward sources below are pulled in when the user asks for them by voice. Pre-interview agenda generation is Phase 2 work.

### 5.1 Context Sources
* **Screenpipe:** read directly from Screenpipe's local SQLite database (recent application windows, OCR text, and heard speech). Optional; auto-detected or chosen in Settings.
* **Google Workspace:** each user connects their own Google accounts through a sign-in flow in Settings (any number of accounts). Upcoming calendar events, drafts, starred and deadline-related email, recent inbox and sent mail, and recently modified Drive documents are read with read-only scopes. Requires the app distributor to supply a Google OAuth client (see README).
* **The notes folder itself:** a read-only filesystem MCP server on the notes folder lets Claude and GPT look up a note the user mentions mid-interview.
* **Slack:** not built. Future work.

### 5.2 Strict Graceful Degradation & Fail-Loud Policy
* All external context integrations are treated as **strictly optional enrichment**.
* Screenpipe reads time out after 2 seconds; each Google account times out after 8 seconds; the MCP server gets 8 seconds to start. A source that is missing, slow, or whose access has expired produces a notice in the HUD (for example `Screenpipe database not found. Continuing without screen context.` or `Personal: Google access expired. Reconnect it in Settings.`) and the interview continues.
* Execution never hangs, crashes, or blocks.

---

## 6. Multimodal Intelligence & "Delta Analysis"

The platform’s primary analytical differentiator is the extraction of non-verbal context and **incongruence detection**.

### 6.1 Multi-Pass Video Analysis
Following session completion, the WebM recording is uploaded to Gemini (Flash or Pro, whichever ran the session) to perform emotional, somatic, and cognitive evaluation, and deleted from Google once the analysis returns. The analysis runs in the background after the text summary is already on screen, so the user never waits on the upload. Claude and GPT cannot ingest video; those sessions archive the recording for later analysis (see 7.2).

```
+-------------------------------------------------------------------------+
|                  MULTIMODAL DELTA ANALYSIS PIPELINE                     |
+-------------------------------------------------------------------------+
|                                                                         |
|  [Spoken Words (STT)]   <=========== DELTA ===========>   [Body & Voice]|
|  "I am confident about                 VS.                - Micro-frown |
|   the Q3 deadline."                                       - Vocal tremor|
|                                                           - Eye aversion|
|                                                                         |
|  OUTPUT REPORT:                                                         |
|  * Linguistic Statement: Full confidence asserted.                     |
|  * Non-Verbal Signal: Hesitation & high cognitive stress detected.     |
|  * Extracted Reality: High risk / user privately doubts feasibility.   |
+-------------------------------------------------------------------------+
```

### 6.2 Key Extracted Dimensions
1. **Confidence vs. Hesitation:** Analyzes latency before answering, speech cadence, and gaze stability to score certainty.
2. **Cognitive Friction & Stress:** Flags topics that cause visible sighing, brow furrowing, or defensive posturing.
3. **Excitement & Energy Spikes:** Pinpoints genuine passion, elevated pitch, and animated gestures indicating authentic alignment.
4. **Verbal vs. Non-Verbal Delta (The Divergence Score):** Explicitly compares literal statements against physical cues. If the user affirms a project while displaying high stress markers, the dossier records a flagged dissonance.

---

## 7. Storage, Knowledge Preservation & Downstream Consumption

### 7.1 Local-First Storage Architecture
All data is stored in a user-chosen notes folder (default: `~/Documents/MadroneContext`; an Obsidian vault works best). Everything the app writes lives in one `Madrone` subfolder, so it sits tidily inside a vault and can be moved as a unit. Any sync tool the user already runs carries it to other machines.

```
<notes folder>/Madrone/
├── master_dossier.md                       cumulative profile, rewritten after every saved session
├── Sessions/2026-09-11_1422_session.md     one note per session
├── People/  Projects/  Topics/             one note per entity the sessions mention (the graph's nodes)
├── Madrone Sessions.base                   Obsidian Bases table: all sessions, flagged incongruence, by project
├── dossier_history/                        copy of the dossier taken before each rewrite
├── sync_state.json                         last-saved timestamp used for "catch me up"
└── archives/2026/09/<id>_video.webm        recordings; can be relocated outside a synced vault
```

Every session has an id of the form `YYYY-MM-DD_HHMM`. The id is in the note's filename, in the note's frontmatter, and in the recording's filename, so a note and its recording can always be matched even if the archives folder is moved out of the vault to keep sync traffic small.

### 7.1a Obsidian Graph Integration
The platform treats Obsidian's links as the knowledge graph rather than building its own:
* **Entity notes.** After each session the model lists the people, projects and topics discussed; the app creates or appends to one note per entity with a dated, linked "Mentions" line. Session notes carry `people`, `projects` and `topics` as list-of-link properties and link to the entities in the body, so backlinks and the graph view connect sessions to what they were about.
* **Consistent naming.** The model is shown the names of existing entity notes before summarizing and instructed to reuse them; loose matching (case, punctuation) maps variants onto existing notes.
* **Interview-time recall.** When a transcript mentions a known entity, that note's contents are passed to the interviewer on the next turn, for every model. This is how the interviewer knows what "the vendor thing" was three sessions ago.
* **Bases table.** A generated `.base` file gives a sessions table with views for flagged incongruence and grouping by project, which replaces the PRD's original `get_delta_flags` tool with a note the user can open.
* **Recordings inline.** Session notes embed their recording when it lives inside the vault, and the saved screen offers "Open in Obsidian".

### 7.2 The Retroactive Reprocessing Guarantee
**Raw recordings are permanently archived and named by session id.** 
As future multimodal models emerge (with 10x greater facial, vocal, and emotional resolution), a batch reprocessing command can re-interrogate historic recordings and upgrade the entire knowledge base retrospectively without requiring new interviews. *Status:* the recordings and the ids that link them to notes are in place; the reprocessing command itself is not built yet.

### 7.3 Session Note Schema
Each saved session writes one Markdown note. The frontmatter is written by the app; the summary, insights and alignment sections are written by the model in Obsidian-flavoured Markdown with `[[wikilinks]]` to the entity notes and `#tags`; the transcript is assembled by the app from every turn.

```markdown
---
session_id: 2026-09-11_1422
date: 2026-09-11
time: "14:22"
duration: "12:40"
model: gemini-3.6-flash
persona: socratic
type: interview
people:
  - "[[Jane Doe]]"
projects:
  - "[[Q3 Roadmap]]"
topics:
  - "[[Hiring]]"
energy: "neutral"
confidence: 7
incongruence: true
recording: "Madrone/archives/2026/09/2026-09-11_1422_video.webm"
recording_kind: video
video_analysis: done
tags:
  - madrone-session
---
# Session 2026-09-11 14:22

## Summary
Primary objective, underlying drivers, explicit constraints, open threads.

## Insights
Bulleted insights from the conversation, plus "From the video" when analyzed.

## Behavioral alignment
Where words and physical cues agreed or diverged; "Detected incongruence" list.

## Transcript
- **00:00 AI:** What is the core rationale behind...?
- **00:32 You:** The real reason is...
```

The Master Dossier is a single Markdown file the model rewrites after every saved session (goals, active projects, constraints, emotional state, recurring tensions, action items, recent sessions). The previous version is copied to `dossier_history/` before each rewrite, so nothing is lost if a rewrite drops something.

### 7.4 Downstream Consumption by Other Agents
Coding agents (Antigravity, Claude Desktop, Cursor) consume the context by reading the notes folder. Because every artifact is a plain Markdown file with predictable frontmatter, the standard filesystem MCP server those tools already ship with is enough: point it at the notes folder and ask for `master_dossier.md` or the most recent `sessions/*.md`.

*Deferred:* a dedicated MCP server with semantic tools (`get_active_motivations`, `get_user_constraints`, `query_interview_context`, `get_delta_flags`) is not built. It becomes worthwhile once there is structured data to query beyond what a file read gives, for example an index of delta flags across sessions. Until then it would add a second thing to install without adding information.

---

## 8. Interview Frameworks & Personas

The user can select between 4 established interviewing methodologies to suit their immediate mindset:

1. **Socratic / First Principles (Default):**
   * Role: The Rational Inquisitor.
   * Method: Strips assumptions down to foundational truths; challenges conventional justifications.
2. **Investigative / 5-Whys:**
   * Role: The Root-Cause Analyst.
   * Method: Repeatedly probes beneath the surface of decisions to uncover foundational incentives.
3. **Executive Coach (GROW Model):**
   * Role: Goal, Reality, Options, Will.
   * Method: Structures thoughts into actionable milestones, clarifying choices and commitments.
4. **Empathetic Sounding Board:**
   * Role: The Reflective Listener.
   * Method: Non-judgmental, therapeutic mirror designed to lower defenses and unblock emotional friction.

---

## 9. Engineering Risk Assessment & Failure Modes

| Risk Area | Severity | Failure Scenario | Mitigation (as built) |
| :--- | :--- | :--- | :--- |
| **Acoustic Feedback Loop** | Removed | AI's voice from speakers triggers mic | The AI never speaks; questions are read on screen. |
| **VAD Premature Interruption** | HIGH | System cuts off user while pausing to think | 1.8 s silence window (adjustable) that only arms after speech is detected; `Space` for instant manual completion; recording continues while the model thinks so nothing is lost. |
| **Lost final answer** | HIGH | User concludes mid-sentence and the last thought is dropped | On `Cmd+Enter` the in-progress audio is transcribed into the note before the summary runs. |
| **Video Upload Latency** | MEDIUM | Large upload blocks the review screen | 720p at ~0.8 Mbps (about 90 MB per 15 min); the transcript-based summary appears first and the video analysis arrives in the background. |
| **Context Source Offline** | MEDIUM | Screenpipe or Google hangs the interview | 2 s (Screenpipe) and 8 s (per Google account) timeouts; HUD notices; interview continues. |
| **Interrupted Recording** | HIGH | App killed mid-session, corrupting the file | 3-second WebM chunks appended to disk as they arrive; partial files stay playable. |
| **Dossier Corruption** | HIGH | A bad model rewrite erases accumulated context | Previous dossier copied to `dossier_history/` before every rewrite; empty or failed rewrites are rejected. |
| **Local Server Exposure** | MEDIUM | Another device on the Wi-Fi reaches the app's server | Bound to `127.0.0.1` only. |
| **Model Writes to Vault** | MEDIUM | A tool-calling model edits or moves the user's notes | The MCP tool list is filtered to read-only tools before the model sees it. |
| **STT Engine Dependency** | LOW | Gemini transcription unavailable | Transcription is isolated in one small class (`GeminiTranscriber`) so another STT engine can be dropped in. |

---

## 10. Phased Implementation Roadmap

### Phase 1: MVP & Core Loop — shipped
* Electron shell with large-text question HUD and setup/settings page.
* Webcam/audio chunked recording (720p WebM) with audio-only fallback.
* Turn-based conversational state machine with silence detection and `Space` override.
* Gemini-native audio turns; Gemini Flash transcription for Claude and GPT.
* Post-session Gemini multimodal delta analysis, run in the background.
* Markdown session notes, time-indexed transcripts, and a backed-up Master Dossier in a local folder.
* Save / Discard / Save & investigate review screen.
* Setup wizard, encrypted key storage, per-user Google sign-in, Screenpipe detection.
* Read-only file tools for Claude and GPT over the notes folder.
* Four interview personas (Socratic, 5-Whys, GROW, Empathetic).

### Phase 2: Cadence, Agenda & Reprocessing (V1.1) — next
* Morning and evening modes with a pre-interview agenda built from calendar, mail and screen activity.
* Retroactive batch reprocessing of archived recordings with newer models.
* Resume a paused session after the app is closed.
* Global shortcut to summon the HUD.
* Slack as a context source.
* A dedicated downstream MCP server, if and when the notes alone are not enough (see 7.4).
* Signed and notarized DMG distribution. *Status:* unsigned universal DMGs are built and published by a GitHub Actions workflow; signing and notarization switch on when the Apple credentials are added as repository secrets.

### Phase 3: Duplex Streaming & Autonomous Proactivity (V2.0)
* Continuous bidirectional duplex streaming audio & vision powered by **Google Project Astra**, **Fable**, or the Gemini Live Audio/Video Engine.
* Conversational pacing and natural voice dynamics optimization (consulting with Ophir Samson).
* Autonomous background triggers and mid-day proactivity based on real-time Screenpipe activity.

---
## 11. Implementation Reality (updated September 11, 2026)

This section is the authoritative description of the shipped code. Where it disagrees with an earlier section, this section is right.

### 11.1 Stack: Electron, not Python
The MVP was built as an Electron app with a Node.js orchestrator (Express and `ws`) rather than the PyWebView/FastAPI stack proposed in the first draft. The Python files from that draft have been removed. Section 4 now describes the Electron design.

### 11.2 The Hybrid Audio-Transcription Engine
Gemini ingests raw audio natively; Anthropic's and OpenAI's chat APIs do not. To support Claude and GPT without adding latency, the system uses a hybrid engine:
* When the user speaks, the turn's audio is sent to **Gemini 3.6 Flash** purely for transcription.
* The transcript is appended to the chat history and passed to the selected model (Claude Sonnet 5, Claude Fable 5.1, GPT-4o or GPT-4o mini) for reasoning.
* Gemini models skip this step and hear the audio directly, which also lets them note vocal cues.
* For Gemini sessions, only the transcript (not the audio) is kept in the running history, so request size stays flat over a long session.

### 11.3 Graceful Video Degradation
* **With Gemini models:** after the text summary is shown, the session recording is uploaded to Gemini's Files API, analyzed for physical/verbal incongruence, deleted from Google, and the result is merged into the note on save.
* **With Claude and OpenAI:** the recording is archived under the session id for future retroactive analysis, and the summary relies on the transcript.

### 11.4 Read-Only File Tools over the Notes Folder
A filesystem MCP server, bundled with the app and started with the app's own Node runtime (no internet or `npx` needed), is attached to the notes folder. Claude and GPT receive only its read and search tools; write, edit and move tools are filtered out. If the user mentions a project that is not in their Master Dossier, the model can read the matching note and respond in context. Gemini does not receive tools because its JSON response mode does not yet combine with function calling.

### 11.5 Setup Wizard, Settings & Edge Cases
* **Progressive onboarding:** first-run setup asks only for the microphone and a Gemini key, then starts. Camera, other model vendors, Google accounts and Screenpipe are offered in context: the camera as a checkbox on the start screen (macOS is asked only then), a vendor key the moment a Claude or GPT model is chosen, Google once after the first saved session and again whenever an interview is asked about calendar or email with no account connected. This follows Apple's and Google's guidance to request access when a feature is first used rather than at install.
* **Bring-Your-Own-Key, every way people keep keys:** paste; paste from the clipboard; keys already on the Mac (login-shell environment, `~/.gemini/.env`, `~/.env`, Claude Code settings, Codex CLI auth, the earlier Keychain entries) found and offered masked with one click; any `.env` file via a file picker; 1Password by picking an item through the `op` CLI (Touch ID approval, titles only until an item is chosen, "Refresh from 1Password" after rotation) or by pasting an `op://` secret reference; and an Anthropic CLI sign-in (`ant auth login`) for Claude models with no key at all. Nothing is imported without the user choosing it. However a key arrives it is stored encrypted with Electron's `safeStorage` (macOS Keychain). Setup and the README recommend a monthly spending cap per key.
* **Consent pre-flight:** before a Google sign-in opens the browser, the app shows what will be read (read-only, and only when asked) and a mock of Google's "unverified app" warning with the two links to click. Settings carries a "What this app can see" section per source, Disconnect buttons, and a "Forget everything" action that clears keys and connections but never touches notes.
* **Google sign-in:** each user connects their own Google accounts through an OAuth sign-in in the browser. The app distributor supplies the Google OAuth client file and publishes the consent screen to production; the README explains how. The app stays unverified, which Google allows for up to 100 accounts: users click through a one-time "Google hasn't verified this app" warning and their connection does not expire weekly. Gmail read access is kept because email is among the most valuable context for most people.
* **Screenpipe independence:** if Screenpipe's `db.sqlite` is not found, it is marked optional and the interview runs without screen context.
* **Obsidian independence:** if no vault is chosen, notes go to `~/Documents/MadroneContext`. The recordings folder defaults to `archives/` inside the notes folder and can be moved outside a synced vault.
* **Camera independence:** without a camera the session records audio only.

### 11.6 Session Lifecycle Guarantees
* The microphone records continuously between turns; speech during "thinking" carries into the next turn.
* `Shift+Esc` pauses both recorders in place; resuming does not resend anything.
* `Cmd+Enter` transcribes the utterance in progress, closes the recording, shows the summary, and releases the camera. The camera light goes off as soon as the session ends.
* Save writes the note, backs up and rewrites the Master Dossier, and waits for a pending video analysis first. Discard deletes the recording and writes nothing. After either, the user can start a new session or quit from the same screen.
* The local server accepts connections only from the same machine.

---
*End of Product Requirement Document.*
