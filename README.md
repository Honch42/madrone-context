# Madrone Context

A short spoken interview with an AI that asks you *why*. It records your answers, writes a Markdown note per session, keeps a cumulative "Master Dossier" about you, and (with Gemini models) compares what you said with how you looked and sounded while saying it. Everything is saved as plain files on your Mac, so Obsidian, Claude Desktop, Cursor or any other tool that reads a folder can use it.

**Mac only.** It uses the macOS Keychain, camera and microphone permissions, and macOS keyboard shortcuts.

## What you need

| | Required? | Where to get it |
|---|---|---|
| macOS 13 or newer | Yes | |
| A Gemini API key | Yes. It transcribes your speech for every model, and runs the interview and video analysis when you pick a Gemini model. | https://aistudio.google.com/apikey (free tier works) |
| An Anthropic API key | Only for the Claude models | https://console.anthropic.com/settings/keys |
| An OpenAI API key | Only for the GPT models | https://platform.openai.com/api-keys |
| Obsidian | No. Notes are Markdown files; point the notes folder at a vault if you use one. | https://obsidian.md |
| Screenpipe | No. If installed, recent screen activity can be pulled into an interview when you ask. | https://screenpi.pe |

## Installing

### From a DMG (if you were given one)

1. Open the DMG and drag **Madrone Context** into Applications.
2. If the app was not signed with an Apple Developer ID, macOS will refuse to open it the first time. Right-click the app, choose **Open**, then **Open** again in the dialog. You only need to do this once.
3. Grant microphone (and, if you want video analysis, camera) access when asked.

### From source

1. Install Node.js 20 or newer from https://nodejs.org.
2. In Terminal:
   ```
   git clone https://github.com/honch42/madrone-context.git
   cd madrone-context
   npm install
   npm start
   ```
   The first `npm install` downloads Electron (about 200 MB).

## First run

The setup screen asks for two things:

1. **Microphone access.** Required; the interview cannot hear you without it.
2. **A Gemini API key.** Required. If you already have one on this Mac (in your shell environment, the Gemini CLI, or a `.env` file), the app finds it and offers to use it with one click. Otherwise paste one; the "Get a free key" link takes you to Google AI Studio.

Then press **Start**. Everything else is optional and the app offers it when it would help:

- **Camera** is a checkbox on the start screen. macOS asks for access the first time you begin a session with it on.
- **Claude and GPT** models appear in the model menu. Pick one and the app asks for that vendor's key right there, offering any key it finds on your Mac first. If you use the Anthropic CLI (`ant auth login`), Claude models can use that sign-in with no key at all.
- **Google accounts** are suggested once after your first saved session, and offered again whenever you ask an interview about your calendar or email before an account is connected.
- **Screenpipe** is detected automatically if installed.

Keys are stored encrypted in your macOS Keychain. Everything can be changed later from the **Settings** button, which also has a "What this app can see" section and a **Forget everything** button that removes every key and connection while leaving your notes alone.

### Every way to bring in a key

Whatever you already do with API keys, there is a one-click path:

| You keep keys… | What to do |
|---|---|
| Nowhere yet | Click "Get a key", copy it, then click **Clipboard** |
| In your shell environment or a tool's config | The app finds them and shows "Use this key" |
| In a `.env` file somewhere | Click **A .env file** and choose it |
| In 1Password | Click **1Password**, pick the item, approve the Touch ID prompt. Or paste a secret reference such as `op://Private/Anthropic API key/credential` into the key field |
| Signed in to the Anthropic CLI | Click "Use my Anthropic sign-in"; Claude models then need no key |

Keys imported from 1Password remember where they came from, so a **Refresh from 1Password** button re-reads the item after you rotate the key. 1Password import needs the 1Password app, its command-line tool (`brew install 1password-cli`) and the "Integrate with 1Password CLI" switch in 1Password > Settings > Developer. The app only sees item titles to build the list and reads one item's secret when you choose it, after 1Password's own prompt.

However a key arrives, it is stored the same way: encrypted with a key held in your macOS Keychain, never as plain text. Once imported, a 1Password key is a copy; the original stays in 1Password.

**Set a spending cap.** A leaked API key can only spend money, never read anything of yours. Google AI Studio, the Anthropic console and the OpenAI dashboard all let you cap monthly spend per key. Do it when you create the key; it turns the worst case into a small bill.

### Where the app looks for existing keys

Most people who already have API keys keep them in one of these places, and the app checks all of them (it never uses one without you clicking "Use this key"):

| Where | What it looks for |
|---|---|
| Your login shell's environment (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`) | `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| `~/.gemini/.env` (Gemini CLI) and `~/.env` | the same variable names |
| `~/.claude/settings.json` (Claude Code), `env` block | `ANTHROPIC_API_KEY` |
| `~/.codex/auth.json` (Codex CLI) | `OPENAI_API_KEY` |
| `~/.config/anthropic/` (Anthropic CLI, `ant auth login`) | an active sign-in profile, used directly instead of a key |
| macOS Keychain, service `AntiGravity` | keys stored by an earlier version of this app |

Sign-ins from Claude Code, the Gemini CLI's "Login with Google", and ChatGPT-plan Codex logins are subscription credentials, not API keys, and cannot be used with the APIs this app calls. Only the Anthropic CLI's profile works that way.

## Running an interview

1. Pick a model and an interview persona at the top right, then **Begin session**.
2. Read the question and answer out loud. When you pause for about two seconds after speaking, your answer is sent. Press **Space** to send sooner.
3. Keep talking while the AI is thinking if you like; it is captured for the next turn.
4. **Shift+Esc** pauses recording (phone call, interruption). Press it again to resume.
5. **Cmd+Enter** concludes the session. Anything you were saying at that moment is transcribed too.
6. A summary appears within a few seconds. With Gemini models the video analysis arrives in the background a little later.
7. Choose **Save to notes**, **Discard session** (deletes the recording), or **Save & investigate discrepancies** to start a follow-up interview about anything the video analysis flagged.

A timer in the corner turns amber at 15 minutes; the AI starts winding down after that.

## What gets saved

```
<notes folder>/
├── master_dossier.md                     cumulative profile, rewritten after every saved session
├── sessions/
│   └── 2026-09-11_1422_session.md        one note per session
├── dossier_history/
│   └── master_dossier_2026-09-11_1422.md copy of the dossier before each rewrite
└── archives/                             (or the recordings folder you chose)
    └── 2026/09/2026-09-11_1422_video.webm
```

Every note starts with frontmatter that names its session id and recording, so a note and its recording can always be matched up again even if you move the recordings folder somewhere else:

```yaml
---
session_id: 2026-09-11_1422
date: 2026-09-11
recording: "archives/2026/09/2026-09-11_1422_video.webm"
video_analysis: done
tags:
  - madrone-session
---
```

Each note contains the summary, insights, the behavioral-alignment report (Gemini models only) and a time-indexed transcript. Recordings are kept so they can be re-analyzed later with better models.

## Models

| Model | Needs | Video analysis | Reads your notes folder mid-interview |
|---|---|---|---|
| Gemini 3.6 Flash, Gemini 3.1 Pro | Gemini key | Yes | No |
| Claude Sonnet 5, Claude Fable 5.1 | Gemini + Anthropic keys | No (recording archived) | Yes, read-only |
| GPT-4o, GPT-4o mini | Gemini + OpenAI keys | No (recording archived) | Yes, read-only |

For Claude and GPT, Gemini Flash transcribes each answer and the transcript goes to the chosen model. Those models can look up a note in your notes folder when you mention a project or person they don't know about. They can only read; nothing they do can change a file.

## Privacy and where data goes

- Audio of each answer goes to Google (Gemini) for transcription. With a Gemini model the same audio is also what the interviewer hears.
- With Claude or GPT, only the transcript text goes to Anthropic or OpenAI.
- With a Gemini model, the session video is uploaded to Google's Files API for analysis after the session and deleted from Google when the analysis finishes.
- Your Master Dossier is included in the interviewer's instructions so it can ask informed questions.
- Nothing else leaves your Mac. The app's internal server listens only on `127.0.0.1`.
- Your notes and recordings are plain files. They hold personal reflections, which makes them more sensitive than any API key, and they are protected only by your Mac's disk encryption and whatever service syncs the folder. Choose that folder accordingly.

## Google sign-in (for whoever builds the app)

Connecting a Google account lets the interviewer pull in your upcoming calendar, drafts, starred and deadline-related email, and recently modified documents when you ask for them ("what's coming up?", "catch me up"). Sign-in needs a Google OAuth client, which the person distributing the app creates once:

1. Go to https://console.cloud.google.com, create a project (any name).
2. **APIs & Services > Library**: enable **Google Calendar API**, **Gmail API** and **Google Drive API**.
3. **APIs & Services > OAuth consent screen** (Google now calls this **Google Auth Platform > Branding / Audience**): choose **External**, fill in the app name and your email.
4. Under **Audience**, set the publishing status to **In production**. Do not leave it in **Testing**: in Testing, every connection expires after 7 days and only people you list as test users can sign in. In production, an unverified app can still be used by up to 100 people over its lifetime, and their connections do not expire weekly.
5. **APIs & Services > Credentials > Create credentials > OAuth client ID**: application type **Desktop app**. Download the JSON.
6. Save the file as `google_oauth_client.json` in the project folder (it is git-ignored), or choose it from **Settings > Google accounts > Choose client file** on each Mac. A DMG built with `npm run build` includes the file automatically.

Then each person clicks **Connect account** in Settings. Before the browser opens, the app shows exactly what it will read and what the Google warning page looks like, so nobody is surprised.

**What friends will see.** Because the app is not verified by Google, the sign-in page shows a warning titled "Google hasn't verified this app". That is expected. They click **Advanced**, then **Go to Madrone Context (unsafe)**, and continue. It only happens once per account.

**The limits.** An unverified app is capped at 100 Google accounts for the lifetime of the Cloud project, and the cap cannot be reset. That is plenty for friends and family. Going past it, or removing the warning screen, means Google's verification process; because Gmail is a "restricted" scope, that includes an annual paid security assessment (roughly $500 to $4,500 a year), which is not worth it at this scale. Connections can still lapse if an account is unused for six months or the person changes their Google password; the app then shows "needs reconnecting" in Settings and one click fixes it.

## Building a DMG

```
npm run build
```

The DMG lands in `dist/`. Without an Apple Developer ID the app is unsigned and friends must right-click > Open the first time. To sign and notarize, join the Apple Developer Program, install your Developer ID certificate in Keychain, and set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment before running the build; electron-builder picks them up.

## Troubleshooting

- **"needs Gemini key" next to every model.** Add a Gemini key in Settings; it is required for all models.
- **Microphone access was denied.** System Settings > Privacy & Security > Microphone, turn on Madrone Context, then restart the app.
- **A Claude or GPT model returns an error as its first question.** The key for that vendor is missing, invalid, or out of credit. Check Settings and the vendor's dashboard.
- **Video analysis failed.** Free-tier Gemini keys have low daily quotas and long sessions produce large uploads. The recording is kept; save the note anyway.
- **Screenpipe shows "could not be read".** The `sqlite3` command must be available (it ships with macOS), and the database path must point at Screenpipe's `db.sqlite`.
- **Google account shows "needs reconnecting".** Click Connect account and sign in again. This happens if the OAuth consent screen was left in Testing status (connections expire after 7 days there), the account was unused for six months, or its Google password changed.

## Development

```
npm start      # run the app
npm test       # end-to-end smoke test of the server with a fake model (no network)
```

Layout:

- `main.js`, `preload.js`: Electron window, native dialogs, the bridge to the settings page.
- `src/server.js`: the local server and the interview state machine.
- `src/providers.js`: Gemini, Anthropic and OpenAI adapters behind one interface; the model list lives here.
- `src/prompts.js`: every prompt, including the four personas.
- `src/storage.js`: session ids, note format, dossier backups.
- `src/google.js`, `src/screenpipe.js`, `src/mcp.js`: context sources.
- `src/config.js`: settings and encrypted secrets.
- `frontend/`: the interview screen (`index.html`, `app.js`, `style.css`) and the setup/settings page (`settings.html`).
