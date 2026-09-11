const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');

code = code.replace(/\/\/ Request permissions natively[\s\S]*?console\.log\("Camera access:", cam\);\n\s*\}/, '');

fs.writeFileSync('main.js', code);
