const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');

// Replace has-api-key to check ALL keys
code = code.replace(/ipcMain\.handle\('has-api-key', \(\) => \{[\s\S]*?return false;\n\}\);/, `ipcMain.handle('has-api-key', () => {
    let geminiOk = false;
    let googleOk = true;
    
    // Check Gemini
    if (store.get('geminiApiKey')) {
        geminiOk = true;
    } else {
        try {
            const rawResult = execSync(\`security find-generic-password -s "AntiGravity" -a "gemini-api-key-Collective" -w\`, { encoding: 'utf-8' }).trim();
            if (rawResult) geminiOk = true;
        } catch(e) {}
    }
    
    // Check Google Tokens
    const accounts = ['Personal', 'Collective', 'IV'];
    for (const acc of accounts) {
        try {
            const rawResult = execSync(\`security find-generic-password -s "AntiGravity" -a "google-token-\${acc}" -w\`, { encoding: 'utf-8' }).trim();
            if (!rawResult) googleOk = false;
        } catch(e) {
            googleOk = false;
        }
    }
    
    return { gemini: geminiOk, google: googleOk };
});`);

fs.writeFileSync('main.js', code);

// Update Wizard HTML to show granular status
let wiz = fs.readFileSync('frontend/wizard.html', 'utf8');

wiz = wiz.replace(/<div class="step">\s*<div class="step-info">\s*<div class="step-title">API Keys & Tokens<\/div>\s*<div class="step-subtitle">Keychain Integration<\/div>\s*<\/div>\s*<div id="key-status" class="status-badge">Checking...<\/div>\s*<\/div>/, `
        <div class="step">
            <div class="step-info">
                <div class="step-title">Gemini Model Auth</div>
                <div class="step-subtitle">gemini-api-key-Collective</div>
            </div>
            <div id="gemini-status" class="status-badge">Checking...</div>
        </div>
        <div class="step">
            <div class="step-info">
                <div class="step-title">Workspace Integrations</div>
                <div class="step-subtitle">Google Drive, Calendar, Gmail (All 3 Accounts)</div>
            </div>
            <div id="google-status" class="status-badge">Checking...</div>
        </div>
`);

wiz = wiz.replace(/const hasKeys = await window\.electronAPI\.hasApiKey\(\);[\s\S]*?const currentDir/, `
            const keyStatus = await window.electronAPI.hasApiKey();
            
            const geminiBadge = document.getElementById('gemini-status');
            if (keyStatus.gemini) {
                geminiBadge.textContent = "Detected";
                geminiBadge.className = "status-badge ok";
            } else {
                geminiBadge.textContent = "Missing";
                geminiBadge.className = "status-badge missing";
            }
            
            const googleBadge = document.getElementById('google-status');
            if (keyStatus.google) {
                googleBadge.textContent = "Detected";
                googleBadge.className = "status-badge ok";
            } else {
                googleBadge.textContent = "Missing Tokens";
                googleBadge.className = "status-badge missing";
            }
            
            keysFound = keyStatus.gemini && keyStatus.google;
            
            const currentDir`);

fs.writeFileSync('frontend/wizard.html', wiz);

