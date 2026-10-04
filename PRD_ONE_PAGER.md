# Executive Product Requirement Document (PRD One-Pager)
## Madrone Context: Proactive Context & Human Adjudication Platform

* **Document Version:** 2.1.0 (Executive Synthesis)
* **Date:** October 3, 2026
* **Target Platforms:** Universal macOS Electron Host (macOS 13+) + iOS/iPadOS Safari PWA (over Tailscale HTTPS)
* **Status:** Authoritative Reference Architecture (Reconciles & supersedes PRD v1.2, PRD Mobile v1.2, and PRD v2.0)

---

### 1. Strategic Vision & Core Problem Statement

#### 1.1 The Context Starvation Problem
Autonomous coding agents and frontier LLMs possess high tactical bandwidth but suffer from severe **context starvation**. Passive telemetry (shell logs, screen OCR, git commits, unread mail) captures *what* happened on a machine, but is blind to **first-order human drivers**:
1. **Strategic Rationale (*Why*):** Why an architecture, business deal, or refactor was prioritized, compromised, or abandoned.
2. **Intuitive Friction:** Unspoken hesitations, emotional fatigue, and implicit non-negotiable boundaries behind executive decisions.
3. **Hypothesis Backlog:** Background agents spawn speculative conjectures that remain unverified and pollute agent planning.

#### 1.2 Proactive Elicitation & The Human Adjudication Layer
**Madrone Context** is a local-first, proactive context elicitation and human adjudication engine. It transforms passive observation into structured intelligence by conducting focused, low-friction spoken reflections. Operating as the human gatekeeper of the knowledge graph, Madrone resolves background agent hypotheses, extracts strategic rationale, and commits verified ground truth into an Obsidian knowledge base.

---

### 2. In-Car 3–4 Hour Highway Drive User Journey ("Madrone Drive")

#### 2.1 The Decoupled Capture Architecture
During highway transit as a passenger, tactical keyboards are absent and reflective cognitive bandwidth peaks. Madrone exploits this "windshield time" via a **decoupled architecture**:
* **Mac Host (Home/Desk Node):** Pre-computes 5–10 high-value tiered question cards asynchronously from screen OCR spikes (OpenRecall), git logs, and pending agent hypotheses (`_Inbox/Agent_Hypotheses/*.md`).
* **Mobile Client (Passenger PWA):** Serves the pre-computed deck over an encrypted Tailscale HTTPS mesh with full offline prefetching. Answers are captured in transit with zero dependency on continuous network or home compute.
* **Desktop Review Gate:** Transcriptions and extracted updates stage to `_Inbox/Staged_Dossier_Deltas/` awaiting 1-click human verification upon returning to the desk.

```
+--------------------------------------------------------------------------------------------------------+
|                                  MADRONE DRIVE END-TO-END PIPELINE                                      |
|                                                                                                        |
|  [ PRE-DRIVE (Home Mac) ]       [ IN-TRANSIT (Mobile Safari PWA) ]          [ POST-DRIVE (Desktop) ]   |
|  - OpenRecall OCR / Git         - Tailscale PWA / Service Worker Prefetch   - Ingest & STT Transcribe  |
|  - Agent Hypothesis Backlog     - Safety Attestation [ I am a passenger ]   - Stage Diff Generation    |
|  - Deck Builder (Claude Fable)  - Glanceable Visual HUD (Zero TTS)          - Human Review Banner      |
|  - Staged in _Inbox/            - Atomic 48 kHz AAC Device Mic Turns        - Proposal Applier commits |
|                                 - IndexedDB Local Durability Buffer           to Core/Master Dossier   |
+--------------------------------------------------------------------------------------------------------+
```

#### 2.2 In-Transit Interview & Capture Flow
1. **Session Initialization & Safety Gate:** Passenger launches PWA, selects context (Personal, Madrone IV, Madrone Collective), and taps `[ I am a passenger ]`.
2. **Dual Interaction Modalities:**
   - **Structured Question Deck (15-min sprint):** Cards probe concrete outcomes (ending in names, numbers, dates, or binary choices). Controls: `[ Record Answer ]`, `[ Skip / Snooze ]`, `[ Dismiss ]` (logs negative feedback to `_Inbox/Dismissed_Feedback.jsonl`).
   - **Unprompted Brain Dump Mode:** 1-tap quick capture from launch screen or in-session tangent button to unload thoughts freely without an AI prompt.
3. **Turn Recording & Interruption Guard:** User records answers per card. Incoming calls or app switches trigger automatic commit of buffered audio to IndexedDB; user is prompted to resume, save partial, or discard upon return.

---

### 3. Mobile, Hardware & Offline Operational Parameters

| Parameter | Specification | Architecture Rationale |
| :--- | :--- | :--- |
| **Auditory Output** | **Zero Text-to-Speech (Strictly Visual HUD)** | AI never speaks aloud. Reading text is 3–4× faster than TTS, prevents cabin mic feedback/crosstalk, and leaves vehicle music uninterrupted. |
| **Visual Ergonomics** | **Glanceable Typography & Dark Cabin Mode** | High-contrast, large-type cards with ambient-light dimming to prevent blinding the passenger or distracting the driver. |
| **Visual Capture** | **Zero-Vanity Recording** | Camera records quietly in background for downstream multimodal delta evaluation; no live selfie mirror (eliminates vanity/grooming distraction). |
| **Acoustic Routing** | **Built-in Mic Array (Wideband 48 kHz AAC)** | Strictly bypasses vehicle Bluetooth Hands-Free Profile (HFP narrowband 8–16 kHz), ensuring high-fidelity STT ($<8\%$ WER in 60–75 dB cabin noise). |
| **Pacing Ceiling** | **15–20 Minute Bounded Cognitive Sprint** | Subtle circular timer turns amber at 15:00; polite conclusion wrap-up triggers at 20:00 to prevent cognitive fatigue. |
| **Media Atomicity** | **Per-Turn `audio/mp4` MediaRecorder** | Discrete `MediaRecorder` per turn avoids chunked stream container corruption; each turn is an independent, playable audio artifact. |
| **Storage Gating** | **Deterministic Hardware & Transaction Locks** | UI recording state waits for `MediaRecorder.onstart`; card navigation locks until `IndexedDB transaction.oncomplete` confirms disk write. |
| **Offline Resilience** | **Idempotent Queue + Service Worker** | Turns buffered in IndexedDB (`session_id + card_id + turn_idx`) survive connectivity loss and drain sequentially when Tailscale HTTPS restores. |

---

### 4. Knowledge Retrieval, Storage Governance & Context Routing

#### 4.1 The Hallucination Firewall (Fable Priority 1)
To prevent ungrounded LLM trivia from entering the question generation pipeline, all ingested inputs pass two-point verification:
1. **Source Existence:** Mandatory verification that the source identifier (`msg_id`, git commit hash, OpenRecall window UUID) exists in the canonical event log.
2. **Quote Containment:** Verbatim substring containment check confirming the referenced user quote appears exactly within the source text. Non-compliant cards are discarded.

#### 4.2 The 3-Zone Storage Architecture
All intelligence is stored in a local-first Obsidian vault governed by strict write permissions:

```
[ Obsidian Vault: ~/Documents/Personal_Context_Vault ]
├── _Inbox/                         <-- ZONE 1: SHADOW GRAPH (Ephemeral drafts & hypotheses)
│   ├── Agent_Hypotheses/               Pre-computed questions, distiller drafts, raw voice dumps.
│   └── Staged_Dossier_Deltas/          Extracted diff proposals awaiting human confirmation gate.
│
├── Core/                           <-- ZONE 2: VALIDATED GROUND TRUTH (Madrone is sole writer)
│   ├── Master_Dossier.md               Cumulative strategic truth (rewritten with immutable history backup).
│   ├── Sessions/                       Dated session notes with full verbatim transcripts and wikilinks.
│   ├── Projects/ & People/             Entity nodes linked via Obsidian [[wikilinks]]; canonical aliases.
│   └── dossier_history/                Pre-modification snapshot copies of Master_Dossier.md.
│
└── _System/                        <-- ZONE 3: DIRECTIVES & SKILLS (Operational constitutions)
    ├── Prompts/                        Interviewer frameworks (Socratic, 5-Whys, GROW, Sounding Board).
    └── Schemas/                        Frontmatter contracts and data models.
```

#### 4.3 Staged Diff Human Confirmation Gate & Frontmatter Contract
* **The Confirmation Gate:** Background agents may freely populate Zone 1, but **only explicit human adjudication (via desktop review banner executed by `src/proposal_applier.js`) can promote facts into Zone 2 (`Core/`)**.
* **Frontmatter Provenance Contract:** Every file promoted to `Core/` must contain valid frontmatter:
  ```yaml
  schema: core.project/v1
  status: verified
  confidence: 0.95
  sources: ["openrecall:2026-10-02T14:00", "session:2026-10-03_1600"]
  created_by: madrone-drive
  verified_by: john
  verified_at: 2026-10-03T17:30:00Z
  ```
* **Master Dossier Backup Guarantee:** Before applying any diff to `Master_Dossier.md`, the file is snapshotted to `dossier_history/YYYY-MM-DD_HHMM_Master_Dossier.md`. Degraded or empty rewrites are halted.

---

### 5. Multi-Account IP Isolation & BYOK Model Routing

* **Multi-Account Partitioning (`~/.gemini/host_identity`):**
  - **Personal (`john.honchariw@gmail.com`):** Scoped to personal Google Workspace, personal Photos, and third-party login identities.
  - **Madrone IV (`honch@madrone-iv.com`):** Primary corporate billing entity for Anthropic (Claude) and OpenAI API keys.
  - **Madrone Collective (`honch@madrone-collective.com`):** Full Google AI Stack, Google Cloud, and production web services.
  - **Synergy Pet Group (`cv.vet`):** Strictly quarantined under `role=personal`; zero access, zero touch.
* **Hybrid Model Routing:**
  - **Fast Turn Transcription:** Gemini 3.8 Flash (`@google/genai`) provides ultra-low latency native audio transcription.
  - **Deep Distillation & Deck Curation:** Claude Fable 5.1 / Claude Sonnet 5 executes nuanced reasoning and hypothesis extraction.
  - **Multimodal Somatic Delta Analysis:** Gemini Files API inspects recorded video/audio for non-verbal dissonance (hesitation vs. confidence).

---

### 6. Canonical Reconciliations (Legacy Contradictions Resolved)

| Architectural Dimension | Legacy Specification (Superseded) | Canonical Specification (Madrone v2.1) |
| :--- | :--- | :--- |
| **Voice / Auditory Output** | Spoken AI questions via TTS engine (v1 early draft) | **Strictly Visual Glanceable HUD (Zero TTS).** Prompts rendered in high-contrast type; audio synthesis prohibited. |
| **Runtime & Host Stack** | Python / FastAPI / PyWebView (v1 early draft) | **Universal Electron Desktop Host (Express 5 + ws) + Mobile Safari PWA over Tailscale HTTPS.** |
| **Interview Flow** | Open-mic continuous streaming with 1.8s VAD timeout | **Decoupled Pre-computed Tiered Card Decks with Atomic Per-Turn Capture** (continuous VAD preserved for desk HUD). |
| **Storage Governance** | Direct unchecked overwrite of `master_dossier.md` | **Strict 3-Zone Architecture with Staged Diff Human Confirmation Gate** (`_Inbox/Staged_Dossier_Deltas/`). |
