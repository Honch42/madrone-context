const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const mcp = require('./plugins/mcp_client.js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
app.use(cors());

// Serve static files
const frontendDir = path.join(__dirname, 'frontend');
app.use('/static', express.static(frontendDir));

const server = http.createServer(app);
const wssOrchestrator = new WebSocketServer({ noServer: true });
const wssArchive = new WebSocketServer({ noServer: true });

// Initialize MCP
setTimeout(() => {
    if (typeof ARCHIVE_DIR !== 'undefined' && ARCHIVE_DIR) {
        mcp.initMCP(ARCHIVE_DIR).catch(console.error);
    }
}, 2000);

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
        const rawResult = require('child_process').execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, { encoding: 'utf-8' }).trim();
        let result = rawResult;
        if (/^[0-9a-fA-F]+$/.test(rawResult)) {
            try { result = Buffer.from(rawResult, 'hex').toString('utf-8'); } catch(e) {}
        }
        return result;
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

let anthropicKey = store.get('anthropicApiKey') || getKeychainPassword("anthropic-api-key");
let openaiKey = store.get('openaiApiKey') || getKeychainPassword("openai-api-key");




let ARCHIVE_DIR = store.get('workspaceDir') || require('path').join(require('os').homedir(), "Documents", "MadroneContext");

if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}
let MASTER_DOSSIER_PATH = path.join(ARCHIVE_DIR, "master_dossier.md");

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
const { getScreenpipeContext } = require('./plugins/screenpipe.js');

async function getRearwardContext(syncStatePath) {
    let lastSync = new Date(Date.now() - 86400000).toISOString();
    if (fs.existsSync(syncStatePath)) {
        try {
            const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8'));
            lastSync = state.last_sync || lastSync;
        } catch(e) {}
    }
    
    const googleContext = await fetchRearwardContext(lastSync);
    
    const Store = require('electron-store');
    const spPath = new Store().get('screenpipeDbPath');
    const screenpipeContext = await getScreenpipeContext(spPath);
    
    return googleContext + "\n\n" + screenpipeContext;
}

wssOrchestrator.on('connection', async (ws) => {
    let chat = null;
    let altChatHistory = [];
    let systemPrompt = "";
    let currentMime = "audio/mp4";
    
    async function generateResponse(promptText, isAudio=false, audioBytes=null, partObj=null) {
        const rawTools = await mcp.getMCPTools();
        
        if (ws.selectedModel.startsWith("gemini")) {
            let userMsg = promptText;
            if (isAudio && partObj) userMsg = [partObj, promptText];
            
            // Note: Currently, the native GoogleGenAI SDK chat object doesn't perfectly handle manual tool call loops 
            // without complex state management. For now, we will just use the standard prompt for Gemini 
            // since it already has access to the video natively.
            const res = await chat.sendMessage({ message: userMsg });
            return res.text;
        } else {
            // Hybrid Route
            let userText = promptText;
            let transcribed = "";
            if (isAudio && partObj) {
                const transcriptionAi = new GoogleGenAI({ apiKey: apiKey });
                const transChat = transcriptionAi.chats.create({ model: "gemini-3.6-flash" });
                const tRes = await transChat.sendMessage({ message: [partObj, "Transcribe this audio perfectly. Output ONLY the transcription, nothing else."] });
                transcribed = tRes.text;
                userText = "The user just spoke. Here is the transcript:\n" + transcribed + "\n\nRespond to them based on this transcript.";
            }
            
            altChatHistory.push({ role: "user", content: userText });
            let resultText = "";
            
            if (ws.selectedModel.startsWith("claude")) {
                const anthClient = new Anthropic({ apiKey: anthropicKey });
                const anthTools = mcp.formatToolsForAnthropic(rawTools);
                
                let isToolCall = true;
                while (isToolCall) {
                    const msgPayload = {
                        model: ws.selectedModel === "claude-fable" ? "claude-3-5-fable-20241022" : "claude-3-5-sonnet-20241022",
                        max_tokens: 1024,
                        system: systemPrompt,
                        messages: altChatHistory.map(m => ({ role: m.role, content: m.content }))
                    };
                    if (anthTools) msgPayload.tools = anthTools;
                    
                    const msg = await anthClient.messages.create(msgPayload);
                    altChatHistory.push({ role: "assistant", content: msg.content });
                    
                    if (msg.stop_reason === "tool_use") {
                        let toolResults = [];
                        for (const block of msg.content) {
                            if (block.type === "tool_use") {
                                console.log("Claude is calling tool:", block.name);
                                try {
                                    const result = await mcp.callMCPTool(block.name, block.input);
                                    toolResults.push({
                                        type: "tool_result",
                                        tool_use_id: block.id,
                                        content: JSON.stringify(result)
                                    });
                                } catch (e) {
                                    toolResults.push({
                                        type: "tool_result",
                                        tool_use_id: block.id,
                                        content: "Error: " + e.message,
                                        is_error: true
                                    });
                                }
                            }
                        }
                        altChatHistory.push({ role: "user", content: toolResults });
                    } else {
                        isToolCall = false;
                        resultText = msg.content.find(b => b.type === "text")?.text || "";
                    }
                }
            } else if (ws.selectedModel.startsWith("gpt")) {
                const oaiClient = new OpenAI({ apiKey: openaiKey });
                const oaiTools = mcp.formatToolsForOpenAI(rawTools);
                
                let isToolCall = true;
                while (isToolCall) {
                    const msgs = [{ role: "system", content: systemPrompt }, ...altChatHistory];
                    const msgPayload = {
                        model: ws.selectedModel,
                        messages: msgs
                    };
                    if (oaiTools) msgPayload.tools = oaiTools;
                    
                    const msg = await oaiClient.chat.completions.create(msgPayload);
                    const choice = msg.choices[0].message;
                    altChatHistory.push(choice);
                    
                    if (choice.tool_calls && choice.tool_calls.length > 0) {
                        for (const tc of choice.tool_calls) {
                            console.log("GPT-4o is calling tool:", tc.function.name);
                            let args = {};
                            try { args = JSON.parse(tc.function.arguments); } catch(e) {}
                            
                            try {
                                const toolResult = await mcp.callMCPTool(tc.function.name, args);
                                altChatHistory.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: JSON.stringify(toolResult)
                                });
                            } catch (e) {
                                altChatHistory.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: "Error: " + e.message
                                });
                            }
                        }
                    } else {
                        isToolCall = false;
                        resultText = choice.content;
                        // To keep history serializable for next turn, push a clean string version
                        altChatHistory.pop();
                        altChatHistory.push({ role: "assistant", content: resultText });
                    }
                }
            }
            
            if (transcribed && resultText.includes("{")) {
                try {
                    let parsed = JSON.parse(resultText);
                    parsed.transcript = transcribed;
                    resultText = JSON.stringify(parsed);
                } catch(e) {}
            }
            return resultText;
        }
    }
    
    ws.on('message', async (message, isBinary) => {
        if (!isBinary) {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'init') {
                    ws.selectedModel = data.model || 'gemini-3.6-flash';
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
                    systemPrompt = systemInstruction;
                    
                    if (ws.selectedModel.startsWith("gemini")) {
                        const ai = new GoogleGenAI({ apiKey: apiKey });
                        chat = ai.chats.create({
                            model: ws.selectedModel,
                            config: {
                                systemInstruction: systemInstruction,
                                temperature: 0.7,
                                responseMimeType: "application/json"
                            }
                        });
                    } else {
                        chat = true; // Mark as initialized
                    }
                    
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
                        
                        const initialResponseText = await generateResponse(prompt);
                        let qText = "Hello! Let's get started.";
                        try {
                            const parsed = JSON.parse(initialResponseText);
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
                        
                        
                        let rawText = "";
                        if (ws.selectedModel.startsWith("gemini")) {
                            const ai = new GoogleGenAI({ apiKey: apiKey });
                            let myfile = await ai.files.upload({ file: latestVideo, config: { mimeType: "video/webm" } });
                            while (myfile.state === "PROCESSING") {
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                myfile = await ai.files.get({ name: myfile.name });
                            }
                            if (myfile.state === "FAILED") {
                                throw new Error("Video processing failed in Gemini.");
                            }
                            
                            const videoPrompt = "The session has concluded. I have attached the background video recording of the user during this session. Please output a JSON object with exactly three keys: 'summary' (a comprehensive Markdown summary of the session context), 'insights' (a Markdown bulleted list of interesting visual/behavioral insights derived from analyzing the user's video, body language, and environment), and 'synergy_diff' (a specific Markdown analysis cross-referencing the verbal transcript against the physical body language). Do not use the Option 1 format, just these three keys. DO NOT put the JSON inside a markdown code block, output raw JSON.\n\nCRITICAL FORMATTING INSTRUCTION FOR 'summary' and 'insights': Format the markdown using Obsidian-native syntax. Include YAML Frontmatter at the top of the summary with relevant metadata (e.g. date, tags). Use Obsidian wikilinks (e.g. [[Topic Name]], [[Project X]], [[Person Name]]) to naturally link key concepts, people, and projects so they populate the user's local knowledge graph. Use #tags for broad categorization.";
                            
                            const filePart = { fileData: { fileUri: myfile.uri, mimeType: myfile.mimeType } };
                            const summaryResponse = await chat.sendMessage({ message: [filePart, videoPrompt] });
                            rawText = summaryResponse.text.trim();
                        } else {
                            // Non-video analysis (Claude / GPT-4o)
                            const textPrompt = "The session has concluded. Please output a JSON object with exactly three keys: 'summary' (a comprehensive Markdown summary of the session context), 'insights' (a Markdown bulleted list of interesting insights derived from our conversation), and 'synergy_diff' (Leave this blank). Do not use the Option 1 format, just these three keys. DO NOT put the JSON inside a markdown code block, output raw JSON.\n\nCRITICAL FORMATTING INSTRUCTION FOR 'summary' and 'insights': Format the markdown using Obsidian-native syntax. Include YAML Frontmatter at the top of the summary with relevant metadata (e.g. date, tags). Use Obsidian wikilinks (e.g. [[Topic Name]], [[Project X]], [[Person Name]]) to naturally link key concepts, people, and projects so they populate the user's local knowledge graph. Use #tags for broad categorization.";
                            
                            rawText = await generateResponse(textPrompt);
                            rawText = rawText.trim();
                        }
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
                        let dText = "";
                        if (ws.selectedModel.startsWith("claude")) {
                            const anthClient = new Anthropic({ apiKey: anthropicKey });
                            const msg = await anthClient.messages.create({
                                model: ws.selectedModel === "claude-fable" ? "claude-3-5-fable-20241022" : "claude-3-5-sonnet-20241022",
                                max_tokens: 1024,
                                messages: [{role:"user", content: updatePrompt}]
                            });
                            dText = msg.content[0].text;
                        } else if (ws.selectedModel.startsWith("gpt")) {
                            const oaiClient = new OpenAI({ apiKey: openaiKey });
                            const msg = await oaiClient.chat.completions.create({
                                model: ws.selectedModel,
                                messages: [{role:"user", content: updatePrompt}]
                            });
                            dText = msg.choices[0].message.content;
                        } else {
                            const dossierUpdateRes = await ai.models.generateContent({
                                model: ws.selectedModel,
                                contents: updatePrompt
                            });
                            dText = dossierUpdateRes.text;
                        }
                        
                        fs.writeFileSync(MASTER_DOSSIER_PATH, dText);
                        
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
                    const responseText = await generateResponse("The user just spoke. Transcribe and respond.", true, audioBytes, part);
                    
                    let qText = "I didn't generate a question.";
                    let tText = "";
                    
                    try {
                        const parsed = JSON.parse(responseText);
                        if (parsed.tool === "fetch_rearward_context") {
                            ws.send(JSON.stringify({ type: "question", text: "Pulling up your desktop context...", transcript: parsed.transcript || "Catch me up" }));
                            const contextData = await getRearwardContext(path.join(ARCHIVE_DIR, "sync_state.json"));
                            const followupText = await generateResponse(`Here is the rearward context:\n${contextData}\nNow, output Option 1 JSON to summarize this to the user conversationally.`);
                            const parsedFollowup = JSON.parse(followupText);
                            qText = parsedFollowup.question || "I've reviewed your context.";
                            tText = parsed.transcript || "";
                        } else if (parsed.tool === "fetch_forward_context") {
                            ws.send(JSON.stringify({ type: "question", text: "Pulling up your calendar...", transcript: parsed.transcript || "What's coming up" }));
                            const contextData = await fetchForwardContext();
                            const followupText = await generateResponse(`Here is the forward-looking context:\n${contextData}\nNow, output Option 1 JSON to summarize this to the user conversationally. CRITICAL: ask if there are offline tasks.`);
                            const parsedFollowup = JSON.parse(followupText);
                            qText = parsedFollowup.question || "I've reviewed your upcoming schedule.";
                            tText = parsed.transcript || "";
                        } else {
                            qText = parsed.question || qText;
                            tText = parsed.transcript || "";
                        }
                    } catch (e) {
                        qText = responseText;
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
    return new Promise((resolve, reject) => {
        server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                console.log('Port 8000 in use, trying random port...');
                server.close();
                server.listen(0);
            } else {
                reject(e);
            }
        });
        
        server.on('listening', () => {
            const port = server.address().port;
            console.log("Node WebSocket server listening on port " + port);
            resolve(port);
        });
        
        server.listen(8000);
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
