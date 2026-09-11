const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/chat\.sendMessage\(\[myfile, videoPrompt\]\)/g, 'chat.sendMessage({ message: [myfile, videoPrompt] })');

fs.writeFileSync('server.js', code);
