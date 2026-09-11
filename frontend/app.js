const questionDisplay = document.getElementById('question-display');
const transcriptDisplay = document.getElementById('transcript-display');
const statusText = document.getElementById('status-text');
const statusDot = document.querySelector('.dot');
const hiddenVideo = document.getElementById('hidden-video');

let orchestratorWs;
let archiveWs;
let globalStream;
let backgroundVideoRecorder;
let turnAudioRecorder;
let audioChunks = [];

let isProcessing = false;
let isFrozen = false;

let audioContext;
let analyser;
let dataArray;
let visualizerFrame;

window.onerror = function(message) {
    if (orchestratorWs && orchestratorWs.readyState === WebSocket.OPEN) {
        orchestratorWs.send(JSON.stringify({ type: "log_error", text: String(message) }));
    }
};

function connectWebSockets() {
    const wsBase = `ws://${window.location.host}`;
    orchestratorWs = new WebSocket(`${wsBase}/ws/orchestrator`);
    archiveWs = new WebSocket(`${wsBase}/ws/archive`);

    orchestratorWs.onopen = async () => {
        statusText.innerText = "INITIALIZING CAMERA & MIC...";
        await setupCamera();
        statusText.innerText = "LISTENING - STREAM ACTIVE";
        
        const persona = document.getElementById('persona-select').value;
        const model = document.getElementById('model-select').value;
        let payload = { type: "init", persona: persona, model: model };
        if (window.isDeepDive) {
            payload.deep_dive = true;
            payload.context = window.currentSynergyDiff || "";
            window.isDeepDive = false;
        }
        orchestratorWs.send(JSON.stringify(payload));
    };

    orchestratorWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'question') {
            
            // Show the user's transcript if Gemini provided it
            if (data.transcript && data.transcript.trim() !== "") {
                transcriptDisplay.innerText = `"${data.transcript}"`;
            } else {
                transcriptDisplay.innerText = "";
            }
            
            questionDisplay.style.color = "var(--text-primary)";
            questionDisplay.style.fontStyle = "normal";
            questionDisplay.innerText = data.text;
            questionDisplay.style.animation = 'none';
            void questionDisplay.offsetWidth;
            questionDisplay.style.animation = 'fade-in 0.4s ease-out';
            

            
            isProcessing = false;
            if (!isFrozen) {
                statusText.innerText = "LISTENING - STREAM ACTIVE";
                statusText.parentElement.style.color = "var(--listening-color)";
                startTurnAudioRecording();
            }
        } else if (data.type === 'review_session') {
            document.getElementById('review-screen').style.display = 'flex';
            document.getElementById('review-text').innerText = data.text;
            if (data.insights) {
                document.getElementById('review-insights').innerText = data.insights;
            } else {
                document.getElementById('review-insights').innerText = "No insights available.";
            }
            if (data.synergy_diff) {
                document.getElementById('review-synergy').innerText = data.synergy_diff;
            } else {
                document.getElementById('review-synergy').innerText = "No behavioral discrepancies detected.";
            }
            
            // Store it globally or in closure
            window.currentSessionSummary = data.text + "\n\nInsights:\n" + (data.insights || "");
            window.currentSynergyDiff = data.synergy_diff || "";
            statusText.innerText = "WAITING FOR USER REVIEW...";
        } else if (data.type === 'summary') {
            document.getElementById('review-screen').style.display = 'none';
            transcriptDisplay.innerText = "";
            questionDisplay.style.color = "var(--text-primary)";
            questionDisplay.style.fontStyle = "normal";
            questionDisplay.style.fontSize = "1.2rem";
            questionDisplay.style.textAlign = "left";
            questionDisplay.style.whiteSpace = "pre-wrap";
            questionDisplay.innerText = data.text;
            
            statusText.innerText = "SESSION COMPLETE";
            statusText.parentElement.style.color = "var(--listening-color)";
        }
    };
}

async function setupCamera() {
    try {
        globalStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: true
        });
        hiddenVideo.srcObject = globalStream;
        
        setupVisualizer();
        
        try {
            backgroundVideoRecorder = new MediaRecorder(globalStream);
            backgroundVideoRecorder.ondataavailable = (e) => {
                if (e.data.size > 0 && archiveWs.readyState === WebSocket.OPEN) archiveWs.send(e.data);
            };
            backgroundVideoRecorder.start(3000); 
        } catch(err) {}
        
        startTurnAudioRecording();
    } catch (err) {
        statusText.innerText = "CAMERA/MIC PERMISSION DENIED";
        statusText.parentElement.style.color = "#f85149";
    }
}

function setupVisualizer() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(globalStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    function renderFrame() {
        if (!isFrozen && !isProcessing) {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for(let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            let average = sum / dataArray.length;
            
            let scale = 1.0 + (average / 50.0);
            if (scale > 2.5) scale = 2.5;
            statusDot.style.transform = `scale(${scale})`;
            
            if (average > 10) {
                statusDot.style.boxShadow = `0 0 10px rgba(46, 160, 67, ${average/100})`;
                statusText.innerText = "LISTENING - RECEIVING AUDIO";
            } else {
                statusDot.style.boxShadow = 'none';
                statusText.innerText = "LISTENING - STREAM ACTIVE";
            }
        }
        visualizerFrame = requestAnimationFrame(renderFrame);
    }
    renderFrame();
}

function startTurnAudioRecording() {
    if (!globalStream) return;
    audioChunks = [];
    try {
        const audioTrack = globalStream.getAudioTracks()[0];
        const audioStream = new MediaStream([audioTrack]);
        turnAudioRecorder = new MediaRecorder(audioStream);
        
        turnAudioRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        
        turnAudioRecorder.onstop = () => {
            if (isFrozen) return;
            const mime = turnAudioRecorder.mimeType || 'audio/mp4';
            const audioBlob = new Blob(audioChunks, { type: mime });
            
            if (orchestratorWs && orchestratorWs.readyState === WebSocket.OPEN) {
                orchestratorWs.send(JSON.stringify({ type: "audio_meta", mime_type: mime }));
                orchestratorWs.send(audioBlob);
            }
        };
        turnAudioRecorder.start();
    } catch(err) {}
}

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !isProcessing && !isFrozen) {
        e.preventDefault();
        isProcessing = true;
        
        transcriptDisplay.innerText = "";
        questionDisplay.innerText = "Processing audio chunk...";
        questionDisplay.style.color = "var(--text-secondary)";
        questionDisplay.style.fontStyle = "italic";
        
        statusText.innerText = "AI IS THINKING (Flash Model)...";
        statusText.parentElement.style.color = "var(--accent-color)";
        statusDot.style.transform = "scale(1)";
        statusDot.style.boxShadow = "none";
        
        if (turnAudioRecorder && turnAudioRecorder.state === 'recording') {
            turnAudioRecorder.stop();
        }
    }
    
    if (e.code === 'Escape' && e.shiftKey) {
        e.preventDefault();
        if (!isFrozen) {
            isFrozen = true;
            statusText.innerText = "FROZEN (Shift+Esc to resume)";
            statusText.parentElement.style.color = "var(--text-secondary)";
            statusDot.style.transform = "scale(1)";
            
            if(backgroundVideoRecorder && backgroundVideoRecorder.state === 'recording') backgroundVideoRecorder.pause();
            if(turnAudioRecorder && turnAudioRecorder.state === 'recording') turnAudioRecorder.pause();
        } else {
            isFrozen = false;
            statusText.innerText = "LISTENING - STREAM ACTIVE";
            statusText.parentElement.style.color = "var(--listening-color)";
            if(backgroundVideoRecorder && backgroundVideoRecorder.state === 'paused') backgroundVideoRecorder.resume();
            if(turnAudioRecorder && turnAudioRecorder.state === 'paused') {
                turnAudioRecorder.stop();
            }
            startTurnAudioRecording();
        }
    }
    
    if (e.code === 'Enter' && e.metaKey) {
        e.preventDefault();
        isFrozen = true;
        transcriptDisplay.innerText = "";
        questionDisplay.innerText = "Session Concluded. Uploading and analyzing video. This may take up to 60 seconds...";
        statusText.innerText = "ANALYZING VIDEO...";
        statusText.parentElement.style.color = "var(--accent-color)";
        statusDot.style.transform = "scale(1)";
        
        if(backgroundVideoRecorder && backgroundVideoRecorder.state !== 'inactive') backgroundVideoRecorder.stop();
        if(turnAudioRecorder && turnAudioRecorder.state !== 'inactive') turnAudioRecorder.stop();
        
        // Wait briefly for the final video chunk to travel over the archiveWs
        setTimeout(() => {
            if (archiveWs && archiveWs.readyState === WebSocket.OPEN) {
                archiveWs.close();
            }
            if (orchestratorWs && orchestratorWs.readyState === WebSocket.OPEN) {
                orchestratorWs.send(JSON.stringify({ type: "end_session" }));
            }
        }, 1500);
    }
});

const startBtn = document.getElementById('btn-start');
if (startBtn) {
    startBtn.addEventListener('click', () => {
        document.getElementById('start-screen').style.display = 'none';
        connectWebSockets();
    });
}

const saveBtn = document.getElementById('btn-save');
if (saveBtn) {
    saveBtn.addEventListener('click', () => {
        saveBtn.innerText = "Saving to Master Dossier...";
        saveBtn.disabled = true;
        if (orchestratorWs && orchestratorWs.readyState === WebSocket.OPEN) {
            orchestratorWs.send(JSON.stringify({ type: "save_dossier", summary: window.currentSessionSummary }));
        }
    });
}

const discardBtn = document.getElementById('btn-discard');
if (discardBtn) {
    discardBtn.addEventListener('click', () => {
        document.getElementById('review-screen').style.display = 'none';
        questionDisplay.innerText = "Session discarded. Press Cmd+R to restart.";
        statusText.innerText = "SESSION DISCARDED";
    });
}

const investigateBtn = document.getElementById('btn-investigate');
if (investigateBtn) {
    investigateBtn.addEventListener('click', () => {
        document.getElementById('review-screen').style.display = 'none';
        
        questionDisplay.innerText = "Initializing Deep Dive...";
        statusText.innerText = "CONNECTING...";
        
        window.isDeepDive = true;
        isFrozen = false;
        
        // Reconnect websockets to restart camera and audio recording
        connectWebSockets();
    });
}

// Settings Modal Logic
document.getElementById('settings-btn').addEventListener('click', async () => {
    if (window.electronAPI) {
        const workspace = await window.electronAPI.getWorkspace();
        const spPath = await window.electronAPI.getScreenpipePath() || "Default (~/.screenpipe/db.sqlite)";
        
        const newKey = prompt(`Current Workspace: ${workspace}\nScreenpipe Path: ${spPath}\n\nEnter a new Gemini API Key to update it, or cancel to keep existing:`);
        if (newKey) {
            await window.electronAPI.saveApiKey(newKey);
            alert("Gemini API Key saved securely!");
        }
        
        const newAnth = prompt(`Enter a new Anthropic (Claude) API Key if you wish to use Claude models, or cancel:`);
        if (newAnth) {
            await window.electronAPI.saveAnthropicKey(newAnth);
            alert("Anthropic API Key saved securely!");
        }
        
        const newOai = prompt(`Enter a new OpenAI API Key if you wish to use GPT-4o models, or cancel:`);
        if (newOai) {
            await window.electronAPI.saveOpenAIKey(newOai);
            alert("OpenAI API Key saved securely!");
        }
        if (confirm("Would you like to select a new Workspace Directory for saving dossiers and videos?")) {
            const newWs = await window.electronAPI.selectWorkspace();
            alert(`Workspace updated to: ${newWs}`);
        }
        if (confirm("Would you like to manually link a custom Screenpipe Database file (db.sqlite)?")) {
            const newSp = await window.electronAPI.setScreenpipePath();
            alert(`Screenpipe DB path updated to: ${newSp}`);
        }
    } else {
        alert("Settings are only available in the Electron desktop app.");
    }
});
