const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());

// Serve static files
const frontendDir = path.join(__dirname, 'frontend');
app.use('/static', express.static(frontendDir));

const server = http.createServer(app);
const wssOrchestrator = new WebSocketServer({ noServer: true });
const wssArchive = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    if (pathname === '/ws/orchestrator') {
        wssOrchestrator.handleUpgrade(request, socket, head, (ws) => {
            wssOrchestrator.emit('connection', ws, request);
        });
    } else if (pathname === '/ws/archive') {
        wssArchive.handleUpgrade(request, socket, head, (ws) => {
            wssArchive.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

function getKeychainPassword(account, service="AntiGravity") {
    try {
        const result = execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, { encoding: 'utf-8' });
        return result.trim();
    } catch (error) {
        return null;
    }
}


const Store = require('electron-store');
const store = new Store();

let apiKey = store.get('geminiApiKey');
if (!apiKey) {
    let raw = getKeychainPassword("gemini-api-key-Collective");
    if (raw) {
        try {
            const data = JSON.parse(raw);
            apiKey = data.api_key || raw;
        } catch(e) { apiKey = raw; }
    }
}

if (apiKey) {
    try {
        const data = JSON.parse(apiKey);
        apiKey = data.api_key || apiKey;
    } catch(e) {}
}




let ARCHIVE_DIR = store.get('workspaceDir') || require('path').join(require('os').homedir(), "Documents", "ProactiveContext");

if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}
const MASTER_DOSSIER_PATH = path.join(ARCHIVE_DIR, "master_dossier.md");

const PERSONA_PROMPTS = {
    "socratic": "You are an advanced, empathetic, and Socratic interviewer. Your goal is to extract the underlying 'why' behind the user's actions, decisions, and feelings by asking progressively deeper questions.",
    "5whys": "You are a sharp, analytical root-cause investigator using the '5 Whys' framework. Your goal is to aggressively drill down into the user's statements to find the absolute fundamental root cause of any problem or feeling.",
    "grow": "You are an executive coach utilizing the GROW model (Goal, Reality, Options, Will). Guide the user structurally from defining their goals, assessing their current reality, brainstorming options, and committing to action.",
    "empathetic": "You are a warm, entirely non-judgmental, active listener. Your primary goal is to provide a safe space, validate the user's emotions, and let them vent or process feelings without aggressively pushing for solutions."
};

const BASE_SYSTEM_PROMPT = `
{persona_instruction}
You are conducting a live verbal interview. You will receive an audio clip of the user speaking.
Listen carefully to what they say, note any vocal cues, and then respond.

CRITICAL INSTRUCTION: You must ALWAYS output your response as a valid JSON object. You have exactly three options for your JSON output:

Option 1 (Default): A normal conversational turn.
{
  "transcript": "The exact text transcription of what the user said in the audio",
  "question": "Your concise follow-up question or conversational response"
}

Option 2 (Tool Trigger - Past Context):
ONLY use this if the user EXPLICITLY asks to "catch me up", "what did I miss", or explicitly asks for past/historical context.
Return EXACTLY this JSON:
{"tool": "fetch_rearward_context", "transcript": "[What the user said]"}

Option 3 (Tool Trigger - Future Context):
ONLY use this if the user EXPLICITLY asks "what's coming up", "what's on my calendar", "what are my deadlines", or explicitly asks for future/upcoming context.
Return EXACTLY this JSON:
{"tool": "fetch_forward_context", "transcript": "[What the user said]"}
`;

const { fetchRearwardContext, fetchForwardContext } = require('./plugins/google_workspace.js');

async function getRearwardContext(syncStatePath) {
    let lastSync = new Date(Date.now() - 86400000).toISOString();
    if (fs.existsSync(syncStatePath)) {
        try {
            const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8'));
            lastSync = state.last_sync || lastSync;
        } catch(e) {}
    }
    return await fetchRearwardContext(lastSync);
}

wssOrchestrator.on('connection', async (ws) => {
    let chat = null;
    let currentMime = "audio/mp4";
    
    ws.on('message', async (message, isBinary) => {
        if (!isBinary) {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'init') {
                    const personaKey = data.persona || "socratic";
                    const personaInstruction = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS["socratic"];
                    
                    let dossierContext = "";
                    if (fs.existsSync(MASTER_DOSSIER_PATH)) {
                        dossierContext = fs.readFileSync(MASTER_DOSSIER_PATH, 'utf-8');
                    }
                    
                    let systemInstruction = BASE_SYSTEM_PROMPT.replace("{persona_instruction}", personaInstruction);
                    if (dossierContext) {
                        systemInstruction += `\n\nHere is the user's Master Dossier (past context from previous sessions):\n${dossierContext}\nUse this context to inform your Option 1 questions. Do not bring it up awkwardly, but use it to be proactive.`;
                    }
                    
                    chat = ai.chats.create({
                        model: 'gemini-3.6-flash',
                        config: {
                            systemInstruction: systemInstruction,
                            temperature: 0.7,
                            responseMimeType: "application/json"
                        }
                    });
                    
                    try {
                        let prompt = "";
                        if (data.deep_dive) {
                            const context = data.context || "";
                            prompt = `The user has just re-entered the interview specifically to investigate a behavioral discrepancy between their words and their body language from the previous session. Here is the discrepancy you noted: '${context}'. Please immediately ask them a piercing, direct question (using Option 1 JSON format) about why their physical body language did not match their verbal confidence. For the transcript field, put '[Deep Dive Initiated]'.`;
                        } else if (dossierContext) {
                            prompt = "The user has just started a new session. Based on their Master Dossier, give a highly contextual, proactive opening question. Use Option 1 JSON format. For the transcript field, put 'Session Started (Context Loaded)'.";
                        } else {
                            prompt = "The user has just started an ad-hoc session. Give a concise, welcoming first question about what's on their mind. Use Option 1 JSON format. For the transcript field, put 'Session Started'.";
                        }
                        
                        const initialResponse = await chat.sendMessage(prompt);
                        let qText = "Hello! Let's get started.";
                        try {
                            const parsed = JSON.parse(initialResponse.text);
                            qText = parsed.question || qText;
                        } catch(e) {}
                        
                        ws.send(JSON.stringify({ type: "question", text: qText, transcript: "" }));
                    } catch (e) {
                        ws.send(JSON.stringify({ type: "question", text: `[Error Init]: ${e.message}`, transcript: "" }));
                    }
                } else if (data.type === 'log_error') {
                    console.log(`FRONTEND ERROR: ${data.text}`);
                } else if (data.type === 'audio_meta') {
                    currentMime = data.mime_type || "audio/mp4";
                } else if (data.type === 'end_session') {
                    try {
                        const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.webm'));
                        let latestVideo = null;
                        let latestTime = 0;
                        for (const file of files) {
                            const filePath = path.join(ARCHIVE_DIR, file);
                            const stats = fs.statSync(filePath);
                            if (stats.size > 1000 && stats.mtimeMs > latestTime) {
                                latestTime = stats.mtimeMs;
                                latestVideo = filePath;
                            }
                        }
                        
                        if (!latestVideo) {
                            throw new Error("No valid video file found in archive.");
                        }
                        
                        
                        const ai = new GoogleGenAI({ apiKey: apiKey });
                        let myfile = await ai.files.upload({ file: latestVideo, config: { mimeType: "video/webm" } });
                        while (myfile.state === "PROCESSING") {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            myfile = await ai.files.get({ name: myfile.name });
                        }
                        if (myfile.state === "FAILED") {
                            throw new Error("Video processing failed in Gemini.");
                        }
                        
                        const videoPrompt = "The session has concluded. I have attached the background video recording of the user during this session. Please output a JSON object with exactly three keys: 'summary' (a comprehensive Markdown summary of the session context), 'insights' (a Markdown bulleted list of interesting visual/behavioral insights derived from analyzing the user's video, body language, and environment), and 'synergy_diff' (a specific Markdown analysis cross-referencing the verbal transcript against the physical body language, pointing out moments where confidence dipped, physical hesitation contradicted verbal assurance, or any behavioral mismatches). Do not use the Option 1 format, just these three keys. DO NOT put the JSON inside a markdown code block, output raw JSON.";
                        
                        const summaryResponse = await chat.sendMessage([myfile, videoPrompt]);
                        let rawText = summaryResponse.text.trim();
                        if (rawText.startsWith("```json")) {
                            rawText = rawText.slice(7, -3).trim();
                        } else if (rawText.startsWith("```")) {
                            rawText = rawText.slice(3, -3).trim();
                        }
                        
                        let sessionMarkdown = "Session concluded.";
                        let sessionInsights = "No insights generated.";
                        let sessionSynergy = "No discrepancies detected.";
                        
                        try {
                            const parsedSummary = JSON.parse(rawText);
                            sessionMarkdown = parsedSummary.summary || sessionMarkdown;
                            sessionInsights = parsedSummary.insights || sessionInsights;
                            sessionSynergy = parsedSummary.synergy_diff || sessionSynergy;
                        } catch (e) {
                            console.error("JSON Parse Error", e);
                            sessionMarkdown = "Session concluded, but failed to parse AI JSON summary.";
                        }
                        
                        ws.send(JSON.stringify({
                            type: "review_session",
                            text: sessionMarkdown,
                            insights: sessionInsights,
                            synergy_diff: sessionSynergy
                        }));
                    } catch (e) {
                        console.error(e);
                        ws.send(JSON.stringify({ type: "review_session", text: `Error analyzing video: ${e.message}`, insights: "" }));
                    }
                } else if (data.type === 'save_dossier') {
                    try {
                        const sessionMarkdown = data.summary || "";
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const sessionSummaryPath = path.join(ARCHIVE_DIR, `${timestamp}_Session_Summary.md`);
                        fs.writeFileSync(sessionSummaryPath, sessionMarkdown);
                        
                        let dossierContext = "";
                        if (fs.existsSync(MASTER_DOSSIER_PATH)) {
                            dossierContext = fs.readFileSync(MASTER_DOSSIER_PATH, 'utf-8');
                        }
                        
                        const updatePrompt = `Here is the user's existing Master Dossier:\n${dossierContext}\n\nHere is the summary of their most recent session:\n${sessionMarkdown}\n\nPlease output a fully updated, merged Master Dossier in Markdown format. Keep it concise, categorized (e.g. Current Goals, Emotional State, Action Items), and overwrite outdated information. Do not use JSON.`;
                        
                        
                        const ai = new GoogleGenAI({ apiKey: apiKey });
                        const dossierUpdateRes = await ai.models.generateContent({
                            model: "gemini-3.6-flash",
                            contents: updatePrompt
                        });
                        
                        fs.writeFileSync(MASTER_DOSSIER_PATH, dossierUpdateRes.text);
                        
                        const syncStatePath = path.join(ARCHIVE_DIR, "sync_state.json");
                        fs.writeFileSync(syncStatePath, JSON.stringify({ last_sync: new Date().toISOString() }));
                        
                        ws.send(JSON.stringify({ type: "summary", text: "Session saved to Master Dossier." }));
                    } catch (e) {
                        console.error(e);
                        ws.send(JSON.stringify({ type: "summary", text: "Failed to save session." }));
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        } else {
            // Binary message (audio bytes)
            const audioBytes = message; // Buffer
            if (audioBytes.length > 100) {
                const now = new Date();
                const yearMonthDir = path.join(ARCHIVE_DIR, `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2, '0')}`);
                if (!fs.existsSync(yearMonthDir)) {
                    fs.mkdirSync(yearMonthDir, { recursive: true });
                }
                const timestamp = now.toISOString().replace(/[:.]/g, '-');
                const audioFilename = `${timestamp}_session_audio.webm`;
                const audioFilepath = path.join(yearMonthDir, audioFilename);
                fs.writeFileSync(audioFilepath, audioBytes);
                
                if (!chat) return; // Not initialized
                
                try {
                    const part = { inlineData: { data: audioBytes.toString('base64'), mimeType: currentMime } };
                    const response = await chat.sendMessage([part, "The user just spoke. Transcribe and respond."]);
                    
                    let qText = "I didn't generate a question.";
                    let tText = "";
                    
                    try {
                        const parsed = JSON.parse(response.text);
                        if (parsed.tool === "fetch_rearward_context") {
                            ws.send(JSON.stringify({ type: "question", text: "Pulling up your desktop context...", transcript: parsed.transcript || "Catch me up" }));
                            const contextData = await getRearwardContext(path.join(ARCHIVE_DIR, "sync_state.json"));
                            const followup = await chat.sendMessage(`Here is the rearward context:\n${contextData}\nNow, output Option 1 JSON to summarize this to the user conversationally.`);
                            const parsedFollowup = JSON.parse(followup.text);
                            qText = parsedFollowup.question || "I've reviewed your context.";
                            tText = parsed.transcript || "";
                        } else if (parsed.tool === "fetch_forward_context") {
                            ws.send(JSON.stringify({ type: "question", text: "Pulling up your calendar...", transcript: parsed.transcript || "What's coming up" }));
                            const contextData = await fetchForwardContext();
                            const followup = await chat.sendMessage(`Here is the forward-looking context:\n${contextData}\nNow, output Option 1 JSON to summarize this to the user conversationally. CRITICAL: ask if there are offline tasks.`);
                            const parsedFollowup = JSON.parse(followup.text);
                            qText = parsedFollowup.question || "I've reviewed your upcoming schedule.";
                            tText = parsed.transcript || "";
                        } else {
                            qText = parsed.question || qText;
                            tText = parsed.transcript || "";
                        }
                    } catch (e) {
                        qText = response.text;
                        tText = "Parsing error";
                    }
                    
                    ws.send(JSON.stringify({ type: "question", text: qText, transcript: tText }));
                } catch (e) {
                    ws.send(JSON.stringify({ type: "question", text: `[Error during inference]: ${e.message}`, transcript: "" }));
                }
            } else {
                ws.send(JSON.stringify({ type: "question", text: "I didn't quite catch that audio. Could you repeat?", transcript: "(Silence)" }));
            }
        }
    });
});

wssArchive.on('connection', (ws) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(ARCHIVE_DIR, `${timestamp}_Session_Video.webm`);
    const stream = fs.createWriteStream(archivePath, { flags: 'a' });
    
    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            stream.write(message);
        }
    });
    
    ws.on('close', () => {
        stream.end();
    });
});

function startServer() {
    server.listen(8000, () => {
        console.log("Node WebSocket server listening on port 8000");
    });
}


function setApiKey(key) {
    apiKey = key;
    try {
        const data = JSON.parse(apiKey);
        apiKey = data.api_key || apiKey;
    } catch(e) {}
    ai.apiKey = apiKey; // AI client might need re-instantiation, but we'll instantiate on each chat creation if needed.
}

function setArchiveDir(dir) {
    ARCHIVE_DIR = dir;
    if (!fs.existsSync(ARCHIVE_DIR)) {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    MASTER_DOSSIER_PATH = path.join(ARCHIVE_DIR, "master_dossier.md");
}

module.exports = { startServer, setApiKey, setArchiveDir };

if (require.main === module) { startServer(); }
