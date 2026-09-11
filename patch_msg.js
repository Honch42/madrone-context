const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/chat\.sendMessage\(prompt\)/g, 'chat.sendMessage({ message: prompt })');
code = code.replace(/chat\.sendMessage\(\[part, "The user just spoke\. Transcribe and respond\."\]\)/g, 'chat.sendMessage({ message: [part, "The user just spoke. Transcribe and respond."] })');
code = code.replace(/chat\.sendMessage\(\`Here is the (.*?)context:\\n\$\{contextData\}\\n(.*?)ask if there are offline tasks\.\`\)/g, 'chat.sendMessage({ message: `Here is the $1context:\\n${contextData}\\n$2ask if there are offline tasks.\` })');
code = code.replace(/chat\.sendMessage\(\`Here is the (.*?)context:\\n\$\{contextData\}\\n(.*?)summarize this to the user conversationally\.\`\)/g, 'chat.sendMessage({ message: `Here is the $1context:\\n${contextData}\\n$2summarize this to the user conversationally.\` })');

fs.writeFileSync('server.js', code);
