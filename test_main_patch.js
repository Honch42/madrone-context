const fs = require('fs');
const path = require('path');
const os = require('os');

function autoDetectPaths() {
    const homedir = os.homedir();
    
    // Detect Screenpipe
    let spPath = path.join(homedir, '.screenpipe', 'db.sqlite');
    if (!fs.existsSync(spPath)) {
        spPath = path.join(homedir, '.local', 'share', 'screenpipe', 'db.sqlite');
    }
    if (!fs.existsSync(spPath)) spPath = null;
    
    // Detect Obsidian
    let obsPath = null;
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
                            obsPath = fullPath;
                            break;
                        }
                    }
                } catch(e) {}
            }
            if (obsPath) break;
        } catch(e) {}
    }
    
    return { screenpipe: spPath, obsidian: obsPath };
}

console.log(autoDetectPaths());
