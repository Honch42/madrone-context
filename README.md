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

The setup screen asks for:

1. **Microphone and camera access.** The microphone is required. Without the camera the app records audio only and skips video analysis.
2. **A Gemini API key.** Required.
3. **Anthropic and OpenAI keys.** Optional.
4. **Notes folder.** Defaults to `~/Documents/MadroneContext`. Change it to your Obsidian vault if you have one.
5. **Recordings folder.** Defaults to `archives/` inside the notes folder.
6. **Screenpipe and Google accounts.** Optional. See "Google sign-in" below.

Keys are stored encrypted in your macOS Keychain. You can change all of this later from the **Settings** button.

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

## Google sign-in (for whoever builds the app)

Connecting a Google account lets the interviewer pull in your upcoming calendar, drafts, starred and deadline-related email, and recently modified documents when you ask for them ("what's coming up?", "catch me up"). Sign-in needs a Google OAuth client, which the person distributing the app creates once:

1. Go to https://console.cloud.google.com, create a project (any name).
2. **APIs & Services > Library**: enable **Google Calendar API**, **Gmail API** and **Google Drive API**.
3. **APIs & Services > OAuth consent screen**: choose **External**, fill in the app name and your email. Under **Test users**, add the Google addresses of everyone who will use the app.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**: application type **Desktop app**. Download the JSON.
5. Save the file as `google_oauth_client.json` in the project folder (it is git-ignored), or choose it from **Settings > Google accounts > Choose client file** on each Mac. A DMG built with `npm run build` includes the file automatically.

Then each person clicks **Connect account** in Settings, signs in with Google in their browser, and returns to the app.

**About Gmail access.** Gmail is a "restricted" scope in Google's rules. An app that requests it and has not gone through Google's verification must stay in *Testing* mode, which means only listed test users can sign in, and their connection expires after 7 days (the app shows "needs reconnecting" in Settings; reconnecting takes one click). If that is too much friction, remove the Gmail line from `SCOPES` in `src/google.js` and publish the consent screen; Calendar and Drive alone do not expire weekly.

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
- **Google account shows "needs reconnecting".** Click Connect account and sign in again. See "About Gmail access" above for why this happens.

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
