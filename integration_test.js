const WebSocket = require('ws');
const { startServer } = require('./server.js');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const store = new Store();

async function runTest() {
    console.log("Starting server...");
    const port = await startServer();
    
    console.log(`Server started on port ${port}. Connecting WebSocket...`);
    const ws = new WebSocket(`ws://localhost:${port}/ws/orchestrator`);
    
    ws.on('open', () => {
        console.log("WebSocket connected. Sending initial ad-hoc session request...");
        ws.send(JSON.stringify({ type: 'start' }));
    });
    
    let step = 0;
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log(`[Server] ${msg.type}: ${msg.text.substring(0, 100)}...`);
        
        if (msg.type === "question") {
            if (step === 0) {
                console.log("Initial question received. Requesting rearward context...");
                step = 1;
                // Send dummy audio payload that triggers rearward context
                // Note: The server currently uses Gemini to transcribe audio. We can't easily mock the audio transcription to force a tool call unless we send actual audio of someone saying "check my email".
                // Actually, let's just trigger the internal functions directly to prove they work, or mock the websocket.
            }
        }
    });
    
    setTimeout(() => {
        console.log("Test timeout reached. Exiting.");
        process.exit(0);
    }, 15000);
}

runTest().catch(console.error);
