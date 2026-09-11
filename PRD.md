# Product Requirement Document (PRD)
## Rough Draft PRD for Interview Based Practive Context Platform

* **Document Version:** 1.0 (Rough Draft)
* **Date:** September 7, 2026
* **Target OS:** macOS (Apple Silicon Optimized)
* **Author:** Antigravity (Autonomous Systems Architecture) & John Honchariw

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

By conducting fluid, low-friction spoken interviews recorded via laptop webcam and microphone, the platform extracts the underlying "why" of human work and thought. It processes spoken language alongside non-verbal behavioral cues (facial tension, hesitation, vocal energy) and compiles structured, cumulative intelligence dossiers. These dossiers are preserved locally, synced to Google Drive, and exposed dynamically to downstream agents (such as Antigravity and Claude) via a dedicated Model Context Protocol (MCP) server.

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

---

## 3. Product Principles & User Experience (UX)

### 3.1 "Stream-of-Consciousness" Verbal Flow
Inspired by high-speed dictation tools like Wispr Flow, the user experience prioritizes uninterrupted cognitive flow. The user should never feel burdened by managing buttons, start/stop toggles, or precise sentence construction. The system encourages raw verbal brain dumps, leaving synthesis, filtering, and summarization to downstream models.

### 3.2 Distraction-Free Typography UI (Zero Vanity)
* **No Self-View Mirror:** User research shows displaying a live webcam mirror induces vanity, self-consciousness, and continuous self-grooming, undermining authentic reflection. The webcam records quietly in the background without rendering the user's face.
* **Large-Text Question Prompt:** The AI’s current question is displayed prominently in clean, high-contrast, large typography. Users who read faster than speech can instantly digest the prompt and begin speaking without waiting for TTS playback.
* **Subtle State Indicators:** Clean, unobtrusive visual states indicating whether the system is `Listening`, `Processing`, or `Speaking`.

```
+-------------------------------------------------------------------------+
|                      INTERVIEW INTERFACE (HUD)                          |
+-------------------------------------------------------------------------+
|                                                                         |
|     "What made you decide to abandon the Redis caching layer            |
|      in favor of SQLite during this afternoon's refactor?"              |
|                                                                         |
|                                                                         |
|                [ ● LISTENING - STREAM ACTIVE (04:12) ]                  |
|                                                                         |
|   [Spacebar: Finish Utterance]  [Shift+Esc: Freeze]  [Cmd+Enter: Conclude]  |
+-------------------------------------------------------------------------+
```

### 3.3 Cognitive Time Boxing & Session Lifecycle
* **15–20 Minute Upper Ceiling:** Aligned with research on sustained verbal focus and cognitive fatigue, sessions are limited to an upper boundary of 15–20 minutes. The model gracefully guides the conversation toward a natural summary as the limit approaches.
* **User-Driven Early Exit:** The user can end a session at any time with a single shortcut or voice command (`"Wrap it up"`).
* **"Freeze & Resume" State:** If interrupted by a phone call, urgent task, or distraction, the user can hit `Shift + Escape` to freeze the session. The audio/video container is cleanly finalized, and the session can be resumed later without losing conversational context.
* **5-Second Post-Session Review:** Upon conclusion, the UI presents an instant bulleted summary:
  * Key motivations extracted
  * Explicit constraints recorded
  * Action buttons: `[Save & Process]` (default) or `[Discard Session]`

### 3.4 Invocation & Shortcuts
* **Global Shortcut:** `Shift + Globe` (or user-configurable hotkey) summons the interview interface from anywhere on macOS.
* **Turn Override:** `Spacebar` acts as an immediate manual signal for *"I am done speaking,"* bypassing acoustic silence timeouts.

---

## 4. System Architecture & Technical Specifications

```
+-------------------------------------------------------------------------+
|                        SYSTEM ARCHITECTURE                              |
+-------------------------------------------------------------------------+
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |                  macOS Desktop Shell (PyWebView)                |   |
|   |  - HTML5 MediaRecorder (720p H.264/AAC Fragmented Stream)       |   |
|   |  - Large-Text Typography HUD + WebRTC AEC Audio Capture         |   |
|   +-------------------------------+---------------------------------+   |
|                                   | (Local IPC / WebSocket)             |
|   +-------------------------------v---------------------------------+   |
|   |                      Python FastAPI Backend                     |   |
|   |  - macOS Keychain Access via `keyring` ("AntiGravity" Service)   |   |
|   |  - State Machine & Session Orchestrator                         |   |
|   +----+--------------------------+---------------------------+-----+   |
|        |                          |                           |         |
|   +----v------------+      +------v-----------+        +------v-----+   |
|   |   MCP Client    |      |  Pluggable BYOK  |        |  Dual-Tier |   |
|   | - Screenpipe    |      | - Gemini/Claude  |        |  Storage   |   |
|   | - Workspace     |      | - Deepgram/Wispr |        | - Drive/MD |   |
|   | - Slack         |      | - ElevenLabs/TTS |        | - MCP Serv |   |
|   +-----------------+      +------------------+        +------------+   |
|                                                                         |
+-------------------------------------------------------------------------+
```

### 4.1 Recommended Tech Stack
To maximize the probability of rapid, deterministic, one-shot implementation on macOS without compilation brittleness:
* **Backend Core:** Python 3.11+ using `FastAPI` (local async server) and standard SDKs (`google-genai`, `anthropic`, `openai`, `mcp`, `keyring`).
* **Frontend HUD:** Lightweight, cross-platform desktop UI using `pywebview` or modern web app communicating via WebSockets. Uses native browser `MediaRecorder` API with WebRTC Acoustic Echo Cancellation (AEC).
* **Credential Vault:** Zero plaintext API key storage. All tokens dynamically loaded from macOS Keychain under the `AntiGravity` service.

### 4.2 Conversational Loop Engine
* **V1 Architecture (Turn-Based State Machine):**
  1. AI states question (audio synthesized via TTS + text rendered in large typography).
  2. Microphone opens with WebRTC hardware AEC active (preventing speaker loopback).
  3. Adaptive Voice Activity Detection (VAD) monitors user speech:
     * Generous silence threshold: 1.8 seconds of sustained silence triggers end-of-turn.
     * Manual override: User taps `Spacebar` to immediately trigger submission.
  4. Real-time STT streams transcription to backend.
  5. LLM generates next question based on current agenda, active transcript, and persona guidelines.
* **V2 Roadmap (Duplex Streaming):** Migration to continuous bidirectional WebRTC audio streaming (e.g., Gemini Live API), incorporating conversational naturalness principles in consultation with Ophir Samson.

### 4.3 Pluggable BYOK (Bring-Your-Own-Key) Engine Adapters
The platform is explicitly designed to support the **highest-end frontier models** available. While cost-conscious tiers remain available, the primary design target leverages bleeding-edge cognitive and conversational engines—such as **Google Project Astra**, **Fable**, and the latest **Gemini Pro** (Gemini 1.5/2.0 Pro and upcoming Gemini.google.com Pro iterations)—to achieve maximal depth of psychological, emotional, and strategic understanding.

| Engine Layer | Frontier / High-End Tier (Target) | Alternate Frontier Cloud | Cost-Conscious / Local Fallback |
| :--- | :--- | :--- | :--- |
| **Conversational Brain** | Gemini Pro (Gemini 2.0 Pro / Gemini.google.com Pro) | Claude 3.5/3.7 Opus & Sonnet / OpenAI o1 / GPT-4o | Gemini Flash / Local Ollama (Llama 3.3 70B) |
| **Real-Time Duplex / Video Agent** | Google Project Astra / Fable | Gemini Live Audio Engine | Turn-based state machine |
| **Speech-to-Text (STT)** | Wispr Flow API / Deepgram Nova-2 | Whisper Large-v3 / Gemini Multimodal Audio | Local `faster-whisper` |
| **Voice Synthesis (TTS)** | ElevenLabs Multilingual V2 / OpenAI Voice Engine | Cartesia Sonic / Google Journey Voices | macOS Native (`NSSpeechSynthesizer`) |
| **Multimodal Vision / Delta Analysis** | Gemini Pro Multimodal (High-Res Frame Sampling) | Claude 3.5/3.7 Vision / OpenAI GPT-4o Omni | Gemini Flash (~$0.03/run) / Local Qwen2-VL |

### 4.4 Hardware & Media Recording Pipeline
* **Capture Profile:** 720p resolution @ 15–24 fps, H.264 video encoding, 48kHz AAC mono audio.
* **Payload Optimization:** Compresses a 15-minute recording to **40–70MB**, ensuring rapid post-session upload without saturating home internet connections.
* **Container Resilience:** Stream-writes to fragmented MP4 (`fMP4`) or WebM chunks on the local filesystem. A sudden crash, sleep state, or battery cut will never corrupt recorded frames.

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

### 5.1 MCP Integration Fabric
The app operates as an **MCP Client**, connecting to existing servers configured in the user's environment:
* **Screenpipe MCP:** Queries recent active application windows, active document titles, and OCR summaries.
* **Google Workspace MCP:** Ingests upcoming Google Calendar event titles and attendees, unread/starred Gmail threads.
* **Slack MCP:** Inspects unresponded direct messages and team channels.

### 5.2 Strict Graceful Degradation & Fail-Loud Policy
* All external context integrations are treated as **strictly optional enrichment**.
* If an MCP server is unreachable, timed out (>2.0s), or returns an empty dataset:
  * The platform **alerts the user loudly** in the HUD: `[Notice: Screenpipe MCP offline. Proceeding with Forward-Looking and User-Specified topics.]`
  * Execution never hangs, crashes, or blocks.

---

## 6. Multimodal Intelligence & "Delta Analysis"

The platform’s primary analytical differentiator is the extraction of non-verbal context and **incongruence detection**.

### 6.1 Multi-Pass Video Analysis
Following session completion, the raw 40–70MB MP4 recording is sent to frontier multimodal models—such as **Google Gemini Pro** (with high-density visual frame sampling) or **Claude 3.5/3.7 Vision**—to perform deep emotional, somatic, and cognitive evaluation. Gemini Flash remains available as an ultra-fast, budget-optimized fallback tier.

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
All data is stored in a user-specified directory on the local filesystem (default: `~/Documents/Anti-gravity/Context/`), which is natively synced to Google Drive via Google Drive for Desktop:

```
~/Documents/Anti-gravity/Context/
├── archives/
│   └── 2026/09/
│       ├── 2026-09-07_1400_Q3-Roadmap.mp4
│       └── 2026-09-07_1400_Q3-Roadmap.wav
├── dossiers/
│   ├── 2026-09-07_Morning_Prep_Personal.md
│   └── 2026-09-07_Evening_Debrief_Collective.md
├── master_profile/
│   ├── USER_CORE_PRINCIPLES.md
│   ├── ACTIVE_CONSTRAINTS_AND_BLOCKERS.md
│   └── MOTIVATION_VECTOR_INDEX.json
└── config.json
```

### 7.2 The Retroactive Reprocessing Guarantee
**Raw video and audio files are permanently archived with synchronized timestamps.** 
As future multimodal models emerge (with 10x greater facial, vocal, and emotional resolution), the user can execute a batch command:
```bash
python -m context_platform.reprocess --all-archives --model="gemini-3-flash"
```
This re-interrogates historic recordings and upgrades the entire knowledge base retrospectively without requiring new interviews.

### 7.3 Structured Dossier Schema
Each completed session outputs a standardized Markdown dossier formatted as:

```markdown
# [YYYY-MM-DD] [Session Type] [Topic]

## 1. Executive Summary & Core Motivations
* **Primary Objective:** [Synthesized goal]
* **Underlying Drivers:** [Why the user wants this]
* **Explicit Constraints:** [Boundaries, deadlines, non-negotiables]

## 2. Multimodal Delta & Sentiment Report
* **Overall Energy:** [High / Neutral / Depleted]
* **Confidence Rating:** [8/10]
* **Detected Incongruence:** [e.g., Expressed verbal confidence regarding Vendor X, but exhibited high hesitation markers.]

## 3. Verbatim Time-Indexed Transcript
* **00:15 [AI]:** What is the core rationale behind...?
* **00:32 [User]:** The real reason is...
```

### 7.4 Embedded Downstream MCP Server
To allow coding agents (Antigravity, Claude Desktop, Cursor) to leverage this active context seamlessly, the platform includes a lightweight MCP server exposing tools:
* `get_active_motivations(project: str)`: Returns current high-order drivers and goals.
* `get_user_constraints(topic: str)`: Returns known boundaries, dislikes, and rigid rules.
* `query_interview_context(query: str)`: Semantic search across historical dossiers.
* `get_delta_flags(timeframe_days: int)`: Surfaces topics where user expressed unspoken hesitation.

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

| Risk Area | Severity | Failure Scenario | Engineering Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Acoustic Feedback Loop** | HIGH | AI's voice from speakers triggers mic, corrupting STT | Enable WebRTC hardware AEC; mute microphone input during TTS generation. |
| **VAD Premature Interruption** | HIGH | System cuts off user while pausing to think | Set 1.8s adaptive silence window; provide `Spacebar` for instant manual completion. |
| **Video Upload Latency** | MEDIUM | 1GB video upload blocks UI post-interview | Record at 720p 15fps H.264 (40–70MB); upload asynchronously while displaying instant text summary. |
| **External MCP Offline** | MEDIUM | Screenpipe or Slack MCP crash freezes agenda | Implement 2.0s strict timeout; fail loudly with HUD warning and proceed to default topics. |
| **Interrupted Video Container**| HIGH | App killed mid-session, corrupting MP4 container | Stream-record in fragmented MP4 (`fMP4`) chunks so partial video is always intact. |
| **STT Engine Dependency** | LOW | Wispr Flow lack of raw API blocks transcription | Decouple STT layer; provide Deepgram Nova-2 and local Whisper as default drop-ins. |

---

## 10. Phased Implementation Roadmap

### Phase 1: MVP & Core Loop (Target: Rapid One-Shot Delivery)
* Native Python backend with `pywebview` HUD interface.
* Webcam/Audio fragmented recording (720p H.264/AAC).
* Turn-based conversational state machine with large-text question HUD.
* Deepgram Nova-2 / Whisper STT + OpenAI / ElevenLabs TTS.
* Post-session Gemini Flash multimodal delta analysis.
* Automatic generation of Markdown dossiers in local/Google Drive sync folder.
* 5-second Save/Discard review dialog.

### Phase 2: Integration Fabric & Downstream Querying (V1.1)
* Client connection to Screenpipe MCP, Google Calendar, and Slack.
* Embedded MCP Server exposing context tools to Antigravity and Claude.
* Retroactive batch reprocessing tool for legacy video archives.
* Configurable interview personas (Socratic, 5-Whys, GROW, Empathetic).

### Phase 3: Duplex Streaming & Autonomous Proactivity (V2.0)
* Continuous bidirectional duplex streaming audio & vision powered by **Google Project Astra**, **Fable**, or the Gemini Live Audio/Video Engine.
* Conversational pacing and natural voice dynamics optimization (consulting with Ophir Samson).
* Autonomous background triggers and mid-day proactivity based on real-time Screenpipe activity.

---
*End of Product Requirement Document.*

## 11. Implementation Reality & Updated Architecture (Sept 2026)

Based on the initial MVP deployment, the architecture has been refined to address real-world API constraints and to maximize out-of-the-box user experience.

### 11.1 The Hybrid Audio-Translation Engine
While Anthropic's Claude 3.5 and OpenAI's GPT-4o are offered as top-tier reasoning engines, their APIs do not natively ingest raw streaming audio bytes like Google GenAI. To support these models without compromising latency, the system utilizes a **Hybrid Engine**:
* When a user speaks, the audio bytes are intercepted and passed to a lightweight **Gemini 3.6 Flash** instance purely for zero-latency transcription.
* The resulting transcript is seamlessly appended to the chat history and passed to the user's selected model (Claude/Fable/GPT-4o) for cognitive reasoning.

### 11.2 Graceful Video Degradation
Because Claude and OpenAI currently lack native video-file ingestion endpoints, the end-of-session background video processing gracefully degrades:
* **With Gemini Models:** The background `.webm` video is uploaded and analyzed for physical/verbal incongruence (Delta Analysis).
* **With Claude/OpenAI:** The video is still securely archived to the local Obsidian vault for future retroactive processing, but the immediate post-session summary relies entirely on verbal transcripts to update the Master Dossier.

### 11.3 MCP Agentic Integration (The Deep Path)
The Orchestrator has been upgraded from a static chatbot to a dynamic MCP client. 
* A local **Model Context Protocol (MCP) File System Server** is spun up in the background and attached to the user's Obsidian Vault.
* Claude and GPT-4o are equipped with native `tool_calls`. If the user asks about a specific project not in their Master Dossier, the model will autonomously execute a local file read via MCP, ingest the markdown note, and respond contextually.

### 11.4 Auto-Discovery Setup Wizard & Edge Cases
The onboarding flow has been entirely rebuilt to accommodate users with varying tech stacks:
* **Bring-Your-Own-Key (BYOK):** Users paste API keys for Gemini, Anthropic, or OpenAI. *Gemini is strictly required* to power the base transcription layer, while Claude and OpenAI are optional upgrades.
* **Screenpipe Independence:** If Screenpipe's `db.sqlite` is not found, the app gracefully marks it as "Optional" and bypasses rearward OCR context.
* **Obsidian Independence:** If the user does not have an `.obsidian` vault, the app defaults to saving raw markdown files in `~/Documents/MadroneContext`.

