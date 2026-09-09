const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace(/const ai = new GoogleGenAI\(\{ apiKey: apiKey \}\);/g, '');
code = code.replace(/let chat = ai\.chats\.create\(\{/g, `
                    const ai = new GoogleGenAI({ apiKey: apiKey });
                    chat = ai.chats.create({`);
code = code.replace(/let myfile = await ai\.files\.upload/g, `
                        const ai = new GoogleGenAI({ apiKey: apiKey });
                        let myfile = await ai.files.upload`);
code = code.replace(/const dossierUpdateRes = await ai\.models\.generateContent/g, `
                        const ai = new GoogleGenAI({ apiKey: apiKey });
                        const dossierUpdateRes = await ai.models.generateContent`);
fs.writeFileSync('server.js', code);
