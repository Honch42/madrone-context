# Product Requirement Document (PRD)
## Madrone Mobile: Drive & Passenger Context Capture Extension (Codename: "Madrone Drive")

* **Document Version:** 1.2.0
* **Date:** September 26, 2026
* **Target Platforms:** iOS & iPadOS (Safari Standalone PWA), served over Tailscale HTTPS by always-on macOS Host
* **Author:** Antigravity (Autonomous Systems Architecture) & John Honchariw
* **Status:** Complete Specification (Incorporates Dual-Model Hardening & Unprompted Dump Mode)

---

## 1. Executive Summary, Objectives & Success Metrics

### 1.1 The Windshield Context Opportunity
Modern autonomous coding agents and context synthesis engines are starved of **first-order human drivers**—strategic intent, emotional friction, rationale behind abandoned paths, and implicit non-negotiable constraints. 

While desk time is dominated by tactical execution (coding, Slack, emails), long vehicle drives as a passenger represent prime cognitive space:
* The user is untethered from tactical keyboards and rapid context switching.
* Reflection, strategic motivation, and big-picture mental models surface naturally.
* Historically, this windshield time is either lost or captured via disorganized voice memos that lack conversational structure.

### 1.2 Product Vision & The "Decoupled Capture" Thesis
**Madrone Mobile** is an asynchronous mobile extension of the desktop **Madrone Context** platform. It decouples the **heavy background computation of high-value questions** (synthesized asynchronously on the user's home macOS node from screen history, agent hypotheses, and knowledge gaps) from the **low-friction spoken capture** of answers on phone and iPad during transit.

In addition to question-guided sessions, Madrone Mobile provides a first-class **Unprompted Brain Dump Mode** (both as a 1-tap standalone capture and as an in-session tangential card) allowing the user to unload raw thoughts without the aid of a question.

### 1.3 Key Success Metrics (KPIs)
1. **Context Velocity:** $\ge 6$ completed drive capture sessions per month during transit.
2. **Card Yield:** $\ge 70\%$ of reviewed cards answered rather than dismissed or skipped.
3. **Hypothesis Resolution Rate:** $\ge 5$ background agent hypotheses adjudicated per month.
4. **Synthesis Fidelity:** $\ge 85\%$ of proposed Master Dossier staged additions approved without material manual revisions during desktop review.
5. **Vehicle Audio WER:** Spoken transcription Word Error Rate $< 8\%$ in high-speed cabin noise ($65\text{--}75\text{ dB}$).

### 1.4 Explicit Non-Goals
* **Driver Operation:** Strictly passenger-focused. The application will never implement hands-free eye-tracking or voice-command steering designed for vehicle operators.
* **Synchronous Conversational LLM:** No real-time AI conversational interruptions or duplex audio while in transit.
* **On-Device Transcription / Local Models:** All transcription and synthesis are performed server-side on the host Mac via Google Gemini APIs; the mobile client remains ultra-lightweight. Per-turn ingestion uses fast Gemini Flash (e.g. Gemini 3.8 Flash), while deep post-session distillation routes to frontier models (Claude Fable, transitioning to Gemini 4 Pro as primary once released under the user's Google subscription).
* **Native App Store Distribution:** No iOS App Store distribution or Swift builds in Phase 1; delivered purely as a secure PWA over Tailscale.

---

## 2. Hardware Profiles & Environmental Constraints

### 2.1 Environmental Setting
* **Primary Use Case:** Passenger seat of a moving vehicle during road trips.
* **Interaction Freedom:** Full visual and physical access to the device screen.
* **Cabin Acoustics & Bluetooth Routing:** 
  * In-cabin ambient noise typically ranges from 60–75 dB (road, wind, HVAC).
  * **Bluetooth Warning:** Connecting iOS Safari to vehicle Bluetooth forces the device into Hands-Free Profile (HFP 8–16 kHz narrowband), which destroys transcription fidelity and forcibly pauses vehicle music.
  * **Requirement:** The UI explicitly guides the user to disconnect from vehicle Bluetooth or utilize the built-in device microphone array, preserving full 48 kHz wideband audio and uninterrupted car music.
* **Lighting Dynamics (Cabin Night Mode):** Includes an automatic high-contrast **Night / Dark Cabin Mode** (reactive to system dark mode and ambient light) with brightness dampening to avoid blinding the passenger or casting distracting windshield reflections for the driver.
* **Network Infrastructure:** 
  * Primary: 5G / LTE cellular.
  * Secondary / Fallback: Vehicle-equipped Starlink terminal.
  * Transport Security: End-to-end encrypted mesh via Tailscale.

### 2.2 Hardware Modalities

| Hardware Target | Physical Setup | Media Capture Mode | Codec Specification | Processing Pipeline |
| :--- | :--- | :--- | :--- | :--- |
| **iPhone (iOS)** | Handheld or console-rested | Audio-only | `audio/mp4` (AAC, 48 kHz, 128 kbps) | Turn-by-turn transcription via Gemini 3.6 Flash |
| **iPad (iPadOS)** *(Phase 3 contingent)* | Mounted in vehicle holder facing user | Video + Audio | `video/mp4` (H.264 720p) + `audio/mp4` (AAC) | Multimodal Gemini Files API analysis for non-verbal/cognitive tension |

---

## 3. Product Principles & UX Architecture

### 3.1 Silent Typography UI (Strictly Visual Prompts)
* **Zero Text-to-Speech (TTS):** The application does not speak prompts aloud. Audio synthesis is prohibited to:
  1. Eliminate audio feedback/crosstalk into cabin microphones.
  2. Maintain cognitive pacing (reading text is 3–4× faster than listening to synthesized speech).
  3. Ensure cabin audio (music, podcasts, conversations) is never interrupted.
* **Zero-Vanity Display:** The camera records quietly in the background without rendering a live video mirror, preventing self-grooming and self-consciousness.
* **Glanceable Typography:** Single question cards displayed in clean, high-contrast, scalable type.

### 3.2 Bounded Cognitive Sessions (15–20 Minute Ceiling)
* Sessions mirror desktop Madrone's bounded duration:
  * A subtle circular timer tracks elapsed time.
  * At 15:00, the ring shifts to amber, providing a gentle pacing cue.
  * At 20:00, a polite wrap-up prompt appears ("Session ceiling reached. Finish this thought or conclude?"). The app does not hard-cut active recording.
  * Pacing: Encourages discrete bursts of reflection (e.g., two 15-minute sessions across a 3-hour drive) separated by restorative breaks.

### 3.3 Safety Attestation
* Upon initiating a session, a single-tap modal confirms: `[ I am a passenger ]`. This enforces user alignment with non-distracted driving policies.

### 3.4 Operational Modalities: Structured Deck vs. Unprompted Dumps
The mobile client provides two operational paths:
1. **The Question Deck (15-Min Sprint):** A pre-computed deck of 5–10 high-value cards generated on the home Mac.
2. **Unprompted Brain Dump Mode:**
   * **Standalone Quick Dump:** A 1-tap button on the launch screen ("Quick Brain Dump"). Tap to speak, talk freely for 1–5 minutes, tap Done.
   * **In-Session Freeform Card:** A persistent "Blank Thought" card pinned to the top of the active session deck to record tangents without breaking the session boundary.

---

## 4. User Interaction & Control Surface

```
+-------------------------------------------------------------------------+
| [Context: Madrone IV]              [ ⏳ 08:42 / 15:00 ]   [⚙ Settings]   |
+-------------------------------------------------------------------------+
|                                                                         |
|   CARD 3 OF 8 • HYPOTHESIS ADJUDICATION                                 |
|                                                                         |
|   "Background agents noted you refactored the Reno House LLC            |
|    operating agreement for 3 hours on Tuesday. What strategic           |
|    outcome drove that change?"                                          |
|                                                                         |
|                                                                         |
|   [ 🎙 RECORD ANSWER ]     [ ⏩ SKIP / SNOOZE ]     [ ❌ DISMISS ]       |
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |  [ 💡 RECORD UNPROMPTED TANGENT (ISOLATED DUMP) ]               |   |
|   +-----------------------------------------------------------------+   |
+-------------------------------------------------------------------------+
| IN-RECORDING CONTROLS (Active during turn):                              |
|                                                                         |
|   [ ■ FINISH SPEAKING ]          [ ⏸ PAUSE ]          [ ⏹ CONCLUDE ]   |
+-------------------------------------------------------------------------+
```

### 4.1 Card-Level Controls
* **Record Answer:** Activates media recorder and begins the capture turn linked to this prompt's metadata.
* **Skip / Snooze:** Moves the card to the end of the current session deck.
* **Dismiss / Irrelevant:** Flags the question as unhelpful. Captures a structured negative example:
  ```json
  {
    "card_id": "hyp-2026-09-24-reno",
    "action": "dismiss",
    "timestamp": "2026-09-26T15:45:00Z",
    "reason": "irrelevant_or_misaligned"
  }
  ```
  Logged to `_Inbox/Dismissed_Feedback.jsonl` on the host to tune future Question Generation runs.

### 4.2 In-Recording Controls & Interruption Recovery
* **Finish Speaking:** Concludes the current spoken turn, finalizes the atomic media file, and advances to the next card.
* **Pause / Resume:** Pauses media capture during cabin interruptions or road noise.
* **Interruption Handling (Incoming Calls / App Switches):**
  * When iOS Safari receives a phone call, triggers Siri, or detects an audio session drop (`track.onended`), the client immediately commits the captured audio bytes to local `IndexedDB`.
  * On return to the app, the UI presents: *"Recording interrupted at 0:42. [ Resume ] [ Save Partial ] [ Discard ]"*. No captured audio is discarded without explicit confirmation.
* **Conclude Session:** Triggers session wrap-up, ensures all pending turns in `IndexedDB` are dispatched to the host, and presents the session completion screen.

---

## 5. System Architecture & Technical Specifications

```
+------------------------------------------------------------------------------------+
|                               MOBILE CLIENT (PWA)                                  |
|   - iOS / iPadOS Safari (Standalone Web App Manifest)                              |
|   - Secure Context (Tailscale HTTPS / MagicDNS SSL)                                |
|   - Service Worker: Offline Deck Prefetching & Static Asset Caching                |
|   - Per-Turn MediaRecorder API (audio/mp4 AAC default, video/mp4 H.264 iPad)      |
|   - Screen Wake Lock API (`navigator.wakeLock`)                                   |
|   - IndexedDB Buffer: Idempotent Queue (`session_id + card_id + turn_idx`)         |
+------------------------------------------^-----------------------------------------+
                                           |
                                [Tailscale HTTPS Mesh]
                                (Cellular / Starlink)
                                           |
+------------------------------------------v-----------------------------------------+
|                            MACOS HOST (Home Server)                                |
|                                                                                    |
|  +------------------------------------------------------------------------------+  |
|  |                 `tailscale serve --https=443` -> Express API                 |  |
|  +------------------------------------------------------------------------------+  |
|                                          |                                         |
|  +---------------------------------------v--------------------------------------+  |
|  |                     QUESTION GENERATION ENGINE (QGE)                         |  |
|  |  Aggregates:                                                                 |  |
|  |  1. `Documents/Obsidian/Personal/00_Inbox/Agent_Hypotheses/*.md`             |  |
|  |  2. `Madrone/Master_Dossier.md` (Dossier knowledge gaps)                     |  |
|  |  3. OpenRecall `recall.db` (Recent unclassified application spikes)          |  |
|  |  4. `.agy/project_context/state.md` (Project blockers & open threads)        |  |
|  |  Negative Feedback Filter: Reads `_Inbox/Dismissed_Feedback.jsonl`          |  |
|  +---------------------------------------+--------------------------------------+  |
|                                          |                                         |
|  +---------------------------------------v--------------------------------------+  |
|  |                     SESSION INGESTION & SYNTHESIS                            |  |
|  |  - Audio Transcription: Gemini 3.6 Flash                                     |  |
|  |  - Raw Media Storage: `archives/YYYY/MM/*.mp4` (Local host, .stignored)      |  |
|  |                                                                              |  |
|  |  [BRANCH A: STRUCTURED SESSIONS]                                             |  |
|  |  - Writes Session Note: `Madrone/Sessions/YYYY-MM-DD_HH-MM_session.md`      |  |
|  |  - Stages Staged Diff Proposals for next Desktop Madrone launch:             |  |
|  |    * `_Inbox/Staged_Dossier_Deltas/YYYY-MM-DD_drive.json`                    |  |
|  |    * Hypotheses updated with `stage: verified | rejected | needs_followup`    |  |
|  |                                                                              |  |
|  |  [BRANCH B: UNPROMPTED BRAIN DUMPS (Autonomous Extraction)]                  |  |
|  |  - Writes to Obsidian: `00_Inbox/Raw_Dumps/YYYY-MM-DD_HH-MM_dump.md`         |  |
|  |  - Gemini Flash extracts: Decisions, Entities, Master Dossier Deltas,        |  |
|  |    and Follow-Up Questions (isolated, prevents session narrative pollution)  |  |
|  +------------------------------------------------------------------------------+  |
+------------------------------------------------------------------------------------+
```

### 5.1 Storage Architecture: Obsidian vs. Local
To preserve vault portability and prevent bandwidth/storage bloating across Syncthing nodes:
1. **Obsidian Vault (`Documents/Obsidian/Personal/`):**
   * Receives all text artifacts: Session notes (`Madrone/Sessions/`), hypothesis drafts (`00_Inbox/`), unprompted dumps (`00_Inbox/Raw_Dumps/`), and Master Dossier updates.
   * Syncs seamlessly across all user devices via Syncthing over Tailscale.
2. **Local Host Media Store (`archives/`):**
   * Stores the heavy raw `.mp4` audio and video files.
   * Excluded from Syncthing sync via `.stignore` (`archives/` and `*.mp4`).

### 5.2 Per-Turn Media Recording (Atomic Audio)
To eliminate container corruption risks inherent in chunked continuous streams over mobile WebKit:
* Each card turn is a **discrete, self-contained `MediaRecorder` instance**.
* Upon tapping "Finish Speaking", the recorder stops, emits a complete, independently playable `audio/mp4` file, and buffers it into `IndexedDB`.
* The upload payload is tagged idempotently:
  ```json
  {
    "session_id": "2026-09-26_16-00_drive_uuid",
    "card_id": "hyp-2026-09-24-reno",
    "turn_index": 2,
    "media_type": "audio/mp4",
    "duration_seconds": 74
  }
  ```
* If network connectivity drops in a mountain pass, turns accumulate safely in `IndexedDB` and drain sequentially when the connection re-establishes.

### 5.3 Secure Context & Networking
* iOS Safari strictly blocks `getUserMedia`, `MediaRecorder`, Service Workers, and Wake Lock over unencrypted `http://`.
* **Requirement:** The host Mac exposes the mobile port via **Tailscale HTTPS** using `tailscale serve --https=443` or a valid MagicDNS TLS certificate.

### 5.4 Offline Deck Prefetching
* The PWA Service Worker prefetches the active question deck and stores it in CacheStorage / IndexedDB.
* If a drive begins in a remote area without cellular signal, the user can still open the app, view cached questions, and record answers locally. Uploads remain queued until connectivity returns.

### 5.5 The Staged Diff Human Gate (3-Zone Safeguard)
To prevent LLM misinterpretations of spoken ramblings from corrupting verified core facts, the mobile capture pipeline enforces a **Human Review Gate**:

1. **Session Dossier (Immediate):** The Mac host compiles the raw transcript, executive summary, and audio archive to:
   `Madrone/Sessions/YYYY-MM-DD_HH-MM_drive_session.md`
2. **Staged Proposals (Pending Desktop Verification):**
   * **Master Dossier Deltas:** Extracted strategic beliefs, motivations, or lessons are staged to `_Inbox/Staged_Dossier_Deltas/YYYY-MM-DD_drive.json`.
   * **Hypothesis Adjudications:** Pending files in `_Inbox/Agent_Hypotheses/` are updated with frontmatter:
     ```yaml
     status: hypothesis
     staged_adjudication:
       decision: verified | rejected | needs_followup
       confidence: 0.88
       source_session: 2026-09-26_16-00_drive_session.md
       human_reviewed: false
     ```
3. **Desktop Reconciliation:** When John next opens desktop Madrone Context, a banner alerts: *"Drive Session from 4:00 PM ready for review (4 hypothesis resolutions, 2 dossier updates)"*. Clicking **[Accept All]** or reviewing diffs atomically commits changes to `Core/` and `Madrone/Master_Dossier.md` with true `verified_by: john` provenance.

---

## 6. Implementation Phasing & Milestones

### Phase 0: Technical Validation Spike (2–3 Days)
* [ ] Verify iOS Safari `MediaRecorder` emits valid, playable `audio/mp4` (AAC) on real iPhone and iPad.
* [ ] Validate `tailscale serve` HTTPS connectivity and PWA installation on iOS.
* [ ] Measure Gemini Flash speech-to-text accuracy against a 5-minute vehicle cabin noise audio sample.
* [ ] Verify `navigator.wakeLock` behavior and audio session interruption recovery (`track.onended`).

### Phase 1: Audio-Only Mobile MVP (The Passenger Loop)
* [ ] Implement mobile-responsive PWA viewport served from existing `madrone-context` Express server.
* [ ] Add Service Worker for offline deck caching and static assets.
* [ ] Build Card Queue UI (Question cards + Standalone & in-session Freeform Brain Dump card, large typography, dark cabin mode).
* [ ] Implement Per-Turn Atomic `MediaRecorder` with `IndexedDB` local queuing.
* [ ] Implement Session Lifecycle (15-minute timer, amber warning, Conclude button).
* [ ] Build Host Ingestion endpoint: Receives audio turns, transcribes via Gemini Flash, generates Session Dossier markdown, and outputs Staged Diff files.
* [ ] Build Autonomous Extraction for Unprompted Dumps (saves to `00_Inbox/Raw_Dumps/`).
* [ ] Add Desktop Madrone Review Modal to review and commit staged diffs.

### Phase 2: Dynamic Question Generation Engine (QGE)
* [ ] Build `src/deck_builder.js` on macOS host to parse `_Inbox/Agent_Hypotheses/`, `Master_Dossier.md`, and `state.md`.
* [ ] Implement card-level dismiss negative feedback logging (`_Inbox/Dismissed_Feedback.jsonl`).
* [ ] Implement 3-way hypothesis disposition: `verified`, `rejected`, and `needs_followup`.

### Phase 3: Contingent iPad Video & Multimodal Synthesis
* *Gate:* Initiated only if Phase 1 & 2 achieve $\ge 6$ completed sessions/month and demonstrable context quality.
* [ ] Enable `video/mp4` H.264 capture on iPadOS Safari.
* [ ] Integrate host-side Gemini Files API upload for behavioral/incongruence analysis.
* [ ] Add thermal warning monitor (warns if video capture drops frames due to device heat in vehicle mounts).

---

## 7. Data Lifecycle, Security & Privacy

1. **Storage Exclusions:** Raw audio and video files (`archives/YYYY/MM/*.mp4`) are stored locally on the Mac host. The `archives/` directory is flagged with `.nosync` / `.stignore` to prevent needless bandwidth saturation across Syncthing nodes.
2. **Retention Policy:** 
   * Raw audio/video media: Retained locally for 30 days for reference, after which an automated archival cron prunes recordings whose text transcripts and summaries have been verified.
   * Transcripts and Markdown dossiers: Retained permanently in the Obsidian vault (`00_Inbox/` and `Madrone/`).
3. **Occupant Privacy:** Audio recordings are passenger-targeted. If cabin occupants enter a private conversation, the passenger taps **[ Pause ]** to instantly suspend microphone sampling.

---
*End of Product Requirement Document v1.2.0.*
