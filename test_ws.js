const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8000/ws/orchestrator');

ws.on('open', () => {
    console.log("Connected");
    ws.send(JSON.stringify({ type: 'init' }));
    
    // wait a bit then send audio
    setTimeout(() => {
        console.log("Sending binary...");
        ws.send(Buffer.alloc(150)); // dummy audio > 100 bytes
    }, 2000);
});

ws.on('message', (msg) => {
    console.log("Received:", msg.toString());
});
