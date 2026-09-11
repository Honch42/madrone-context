const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/chat = ai\.chats\.create/g, `
                    const ai = new GoogleGenAI({ apiKey: apiKey });
                    chat = ai.chats.create`);

code = code.replace(/gemini-3.6-flash/g, 'gemini-2.5-flash');

fs.writeFileSync('server.js', code);
