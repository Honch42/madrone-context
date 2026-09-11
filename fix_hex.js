const fs = require('fs');

function fixFile(file) {
    let code = fs.readFileSync(file, 'utf8');
    // Replace getKeychainPassword to handle hex
    code = code.replace(/function getKeychainPassword.*?return result\.trim\(\);\n.*?catch/s, \`function getKeychainPassword(account, service="AntiGravity") {
    try {
        const result = require('child_process').execSync(\\\`security find-generic-password -s "\\\${service}" -a "\\\${account}" -w\\\`, { encoding: 'utf-8' }).trim();
        if (/^[0-9a-fA-F]+$/.test(result)) {
            try { return Buffer.from(result, 'hex').toString('utf-8'); } catch(e) {}
        }
        return result;
    } catch\`);
    fs.writeFileSync(file, code);
}

fixFile('server.js');

let code = fs.readFileSync('main.js', 'utf8');
code = code.replace(/const result = execSync.*?result\.trim\(\)\);/s, \`const rawResult = execSync(\\\`security find-generic-password -s "AntiGravity" -a "gemini-api-key-Collective" -w\\\`, { encoding: 'utf-8' }).trim();
        let result = rawResult;
        if (/^[0-9a-fA-F]+$/.test(rawResult)) {
            try { result = Buffer.from(rawResult, 'hex').toString('utf-8'); } catch(e) {}
        }
        if (result) {
            store.set('geminiApiKey', result);\`);
fs.writeFileSync('main.js', code);

// Also wipe the electron-store so it re-fetches cleanly, or we just fix setApiKey in server.js to parse hex.
