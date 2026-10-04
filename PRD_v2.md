# Product Requirement Document (PRD v2.0)
## Project Madrone: Proactive Context & Human Adjudication Platform

* **Document Version:** 2.0.0 (Synthesized 2-Pager)
* **Date:** October 1, 2026
* **Target Platforms:** macOS Desktop (Universal Electron Client), iOS/iPadOS (Standalone PWA over Tailscale)
* **Authors:** Antigravity (Autonomous Systems Architecture) & John Honchariw
* **Status:** Active Reference Architecture (Supersedes PRD v1.2 & PRD Mobile v1.2)

---

### PAGE 1: STRATEGIC THESIS, CADENCE & CAPTURE ARCHITECTURE

#### 1. Executive Summary & The Context Starvation Problem
Autonomous coding agents and frontier LLMs possess immense tactical execution capability but suffer from **context starvation**. Passive telemetry (file diffs, screen OCR, shell history, unread emails) captures *what* occurred on a machine, but completely blinds agents to **first-order human drivers**:
1. *Why* an architecture, business model, or partnership was prioritized or killed.
2. The emotional friction, intuitive hesitation, and implicit non-negotiable boundaries behind executive decisions.
3. The resolution of unverified background agent hypotheses.

**Madrone** is a local-first, proactive context elicitation and human adjudication platform. It bridges this gap through structured, low-friction spoken capture across two complementary operational surfaces: **Desktop Focused Sessions** and **Mobile Windshield Capture ("Madrone Drive")**.

```
+---------------------------------------------------------------------------------------------------+
|                                  MADRONE END-TO-END PIPELINE                                      |
|                                                                                                   |
|  [ Passive Telemetry ]     [ Background Ingestion ]                [ Proactive Capture Surfaces ]  |
|  - OpenRecall Screen OCR    - iMessage / WhatsApp                   +---------------------------+ |
|  - Gmail / Google Calendar  - Hallucination Firewall                | Desktop HUD (Electron)    | |
|  - Git & Active Notes      (msg_id + quote containment)            | Madrone Drive (Mobile PWA)| |
|            |                            |                          +-------------+-------------+ |
|            v                            v                                        |                |
|  +--------------------------------------------------+                            v                |
|  |       Zone 1: Shadow Graph (_Inbox/Hypotheses)    | ----------> [ Spoken Turn-Based Capture ]   |
|  |       Pre-computed Tiered Question Deck          |             - Zero TTS / Glanceable UI    |
|  +--------------------------------------------------+             - Deterministic Hardware Gate |
|                                                                                  |                |
|                                                                                  v                |
|  +--------------------------------------------------+             [ Post-Session Distillation ]   |
|  |       Zone 2: Core Context (Core/ Vault)         | <---------- - Gemini Multimodal Delta       |
|  |       - Master Dossier  - Projects  - Decisions  |             - Human Adjudication Gate       |
|  +--------------------------------------------------+             - Staged Diff Commit            |
+---------------------------------------------------------------------------------------------------+
```

#### 2. Interaction Principles & Zero-Vanity UX
* **Strictly Visual Glanceable HUD (Zero Text-to-Speech):** Prompts are rendered visually in large, high-contrast typography. Madrone **never speaks aloud**. Reading is 3–4× faster than listening, acoustic feedback into open microphones is eliminated, and cabin music or ambient room audio remains undisturbed.
* **Zero-Vanity Recording:** Front-facing video is captured silently in the background for downstream multimodal delta analysis without displaying a live camera mirror. This eliminates self-grooming, self-consciousness, and cognitive hesitation.
* **Cognitive Time-Boxing (15–20 Minute Ceiling):** Spoken reflection operates under strict cognitive ceilings. At 15:00, visual indicators shift to amber. At 20:00, a polite conclusion wrap-up initiates.
* **Dual Capture Modalities:**
  1. *Structured Question Deck:* Pre-computed, tiered cards forcing concrete decisions (ending in names, numbers, dates, or binaries).
  2. *Unprompted Brain Dump Mode:* 1-tap spontaneous capture on desktop and mobile for freeform cognitive offloading without an AI prompt.

#### 3. Capture Surfaces & Hardware Resilience
* **Desktop Client (Electron / Node.js):** Runs locally on macOS, interfacing with macOS Keychain (`safeStorage`) for encrypted multi-vendor BYOK keys. MediaRecorder captures 720p WebM in 3-second streaming chunks to disk (`archives/`), guaranteeing playable artifacts even during battery cut or kernel panic.
* **Mobile Extension ("Madrone Drive" PWA):** Serves over an encrypted Tailscale HTTPS mesh for passenger-seat reflection during highway travel.
* **Deterministic Hardware & Transaction Gating:** Replaces all fragile time-based heuristics with strict event state machines:
  - *Hardware-Confirmed Start:* Recording controls remain disabled until the audio hardware emits `MediaRecorder.onstart`.
  - *Atomic Storage Lock:* Card transitions lock full-screen until IndexedDB emits `transaction.oncomplete`, eliminating fast-tap race conditions and WebKit chunk drops.
  - *Bluetooth HFP Prevention:* Automatically rejects low-bandwidth Bluetooth Hands-Free Profiles (8–16 kHz), enforcing device wideband mic capture (48 kHz AAC `audio/mp4`).

---

### PAGE 2: DISTILLATION, GOVERNANCE & KNOWLEDGE INFRASTRUCTURE

#### 4. The Context Triad & The Hallucination Firewall
Madrone operates an asynchronous, multi-tiered context ingestion engine (`madrone_ctx`) governed by strict provenance:

| Pipeline Layer | Input Reservoir | Integrity Enforcement & Gating | Output Artifact |
| :--- | :--- | :--- | :--- |
| **Passive Ingestion** | iMessage (`chat.db`), WhatsApp exports, OpenRecall OCR | High-water mark (HWM) cursor tracking; Full Disk Access validation; lockfile concurrency. | Canonical event stream (`.jsonl`) with immutable UUIDs. |
| **Hallucination Firewall** | Unstructured chat chunks & telemetry summaries | **Fable Priority 1 Validation:** 1. Verifies source `msg_id` exists.<br>2. Verifies quoted text is an exact substring of source text. | Dropped cards if hallucinated; verified evidence cards. |
| **Question Deck Synthesis** | Roadmaps, email deadlines, pending agent hypotheses | Pre-computed on home node via Claude Fable 5.1; filters trivia and generates forced-choice strategic tiers. | 30-card tiered deck staged in `_Inbox/Agent_Hypotheses/`. |
| **Spoken Adjudication** | Spoken audio & optional passenger video | Multimodal Gemini Flash transcription + post-session delta analysis (detecting verbal vs. non-verbal tension). | Markdown session notes + staged Master Dossier deltas. |

#### 5. Storage Governance: The 3-Zone Architecture
To prevent hallucinations from contaminating ground truth, Madrone strictly enforces the **3-Zone Knowledge Vault Architecture**:

```
[ Local Vault: ~/Documents/Personal_Context_Vault ]
├── _Inbox/                         <-- ZONE 1: SHADOW GRAPH (Unverified drafts & agent hypotheses)
│   ├── Agent_Hypotheses/               Pre-computed questions, distiller drafts, raw voice dumps.
│   └── Staged_Dossier_Deltas/          Extracted diff proposals awaiting human gate confirmation.
│
├── Core/                           <-- ZONE 2: CORE CONTEXT (Verified Truth - Madrone is sole writer)
│   ├── Master_Dossier.md               Cumulative strategic truth (rewritten with history backup).
│   ├── Sessions/                       Dated session notes with full verbatim transcripts.
│   ├── Projects/                       Entity nodes linked via Obsidian [[wikilinks]].
│   └── People/aliases.yaml             Canonical entity mapping and handle resolution.
│
└── _System/                        <-- ZONE 3: DIRECTIVES & SKILLS (Operational constitutions)
    ├── Prompts/                        Interviewer personas (Socratic, 5-Whys, GROW, Sounding Board).
    └── Skills/                         Agent procedural specifications.
```

* **The Human Confirmation Gate:** Background agents may freely write to Zone 1, but **only Madrone, via explicit human verbal or interactive adjudication, can promote facts into Zone 2 (`Core/`)**.
* **Frontmatter Provenance Contract:** All promoted files maintain strict frontmatter metadata:
  ```yaml
  schema: core.project/v1
  status: verified
  confidence: 0.95
  sources: ["openrecall:2026-09-26T14:00", "session:2026-09-26_1902"]
  created_by: madrone-drive
  verified_by: john
  verified_at: 2026-10-01T15:45:00Z
  ```
* **Master Dossier Backup Guarantee:** Prior to any automated rewrite of `Master_Dossier.md`, the existing file is immutably snapshotted to `dossier_history/`. Empty or degraded rewrites are rejected.

#### 6. Multi-Account IP Isolation & BYOK Model Routing
* **Strict Account Scoping:** Context sources are cleanly partitioned by machine identity (`~/.gemini/host_identity`) and domain rules:
  - *Personal (`john.honchariw@gmail.com`):* Scoped to personal Google Workspace, personal Photos, and third-party API identity logins.
  - *Madrone IV (`honch@madrone-iv.com`):* Serves as the official billing entity for OpenAI and Anthropic API keys.
  - *Madrone Collective (`honch@madrone-collective.com`):* Full Google AI Stack and commercial cloud operations.
* **Hybrid Model Routing:**
  - *Low-Latency Transcription & Turn Engine:* Gemini 3.8 Flash (native audio ingestion, turn transcription, instant entity extraction).
  - *Deep Post-Session Reasoning & Deck Curation:* Claude Fable 5.1 / Claude Sonnet 5 via the Context Router client.
  - *Multimodal Delta Evaluation:* Gemini Files API video inspection to evaluate somatic cues (vocal cadence, hesitation, gaze stability) and flag divergence between spoken confidence and physical stress.

#### 7. Shipped Status & Phased Roadmap

```
+----------------------------------------------------------------------------------------------------+
| [SHIPPED] v1.0 - v1.2 (Current Reality)                                                            |
| - Universal macOS Electron app with large-type HUD, silence detection, and Spacebar override.      |
| - Madrone Drive PWA on iOS/iPadOS Safari over Tailscale with AAC recording & IndexedDB durability.  |
| - Deterministic hardware/transaction gating eliminating turn-dropping race conditions.            |
| - Pre-computed Tiered Question Deck & 1-Tap Unprompted Brain Dump Mode with Staged Diff review.   |
| - iMessage/WhatsApp ingestion with Fable Hallucination Firewall & entity alias resolution.         |
| - Multi-context support with per-context Google Workspace OAuth scoping and encrypted safeStorage. |
+----------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+----------------------------------------------------------------------------------------------------+
| [PHASE 2] Cloud Headless Daemon & Proactive Sync (Q4 2026)                                         |
| - Relocate background ingestion (`madrone_ctx`) and deck synthesis to an always-on headless node.  |
| - Automatic morning agenda generation (calendar, unread triage, pending hypotheses).             |
| - Bi-directional Obsidian daily note synchronization and automated retro-reprocessing.            |
+----------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+----------------------------------------------------------------------------------------------------+
| [PHASE 3] Duplex Multimodal Intelligence (2027)                                                    |
| - Real-time continuous duplex streaming via Gemini Live / Project Astra.                           |
| - Autonomous mid-day interruption triggers upon detecting critical cognitive divergence.          |
+----------------------------------------------------------------------------------------------------+
```
