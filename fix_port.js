const fs = require('fs');

// Patch server.js
let serverCode = fs.readFileSync('server.js', 'utf8');
serverCode = serverCode.replace(/function startServer.*?\}\n/s, `function startServer() {
    return new Promise((resolve, reject) => {
        server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                console.log('Port in use, trying random port...');
                setTimeout(() => {
                    server.close();
                    server.listen(0);
                }, 1000);
            } else {
                reject(e);
            }
        });
        
        server.listen(8000, () => {
            const port = server.address().port;
            console.log("Node WebSocket server listening on port " + port);
            resolve(port);
        });
    });
}
`);
fs.writeFileSync('server.js', serverCode);

// Patch main.js
let mainCode = fs.readFileSync('main.js', 'utf8');
mainCode = mainCode.replace(/startServer\(\);\n\s*mainWindow\.loadURL\('http:\/\/localhost:8000\/static\/index\.html'\);/s, `startServer().then(port => {
        mainWindow.loadURL('http://localhost:' + port + '/static/index.html');
    });`);
fs.writeFileSync('main.js', mainCode);

// Also patch frontend/app.js to dynamically figure out the websocket port based on window.location
let appCode = fs.readFileSync('frontend/app.js', 'utf8');
appCode = appCode.replace(/new WebSocket\("ws:\/\/localhost:8000/g, `new WebSocket("ws://" + window.location.host + "`);
fs.writeFileSync('frontend/app.js', appCode);

