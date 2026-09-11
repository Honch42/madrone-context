const fs = require('fs');
const path = require('path');
const os = require('os');

function findObsidianVault() {
    const homedir = os.homedir();
    const possiblePaths = [
        path.join(homedir, 'Documents'),
        path.join(homedir, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
        homedir
    ];
    
    for (const base of possiblePaths) {
        if (!fs.existsSync(base)) continue;
        try {
            const items = fs.readdirSync(base);
            for (const item of items) {
                const fullPath = path.join(base, item);
                try {
                    if (fs.statSync(fullPath).isDirectory()) {
                        if (fs.existsSync(path.join(fullPath, '.obsidian'))) {
                            return fullPath; // Found a vault!
                        }
                    }
                } catch(e) {}
            }
        } catch(e) {}
    }
    return null;
}
console.log("Vault:", findObsidianVault());
