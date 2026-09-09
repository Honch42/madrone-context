const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/let apiKey = getKeychainPassword[^;]+;/g, `
const Store = require('electron-store');
const store = new Store();

let apiKey = store.get('geminiApiKey');
if (!apiKey) {
    let raw = getKeychainPassword("gemini-api-key-Collective");
    if (raw) {
        try {
            const data = JSON.parse(raw);
            apiKey = data.api_key || raw;
        } catch(e) { apiKey = raw; }
    }
}
`);

code = code.replace(/const ARCHIVE_DIR = "\/Users\/honchpersonal[^"]+";/g, `
let ARCHIVE_DIR = store.get('workspaceDir') || require('path').join(require('os').homedir(), "Documents", "ProactiveContext");
`);

code = code.replace(/let MASTER_DOSSIER_PATH = path.join\(ARCHIVE_DIR, "master_dossier.md"\);/g, `
let MASTER_DOSSIER_PATH = path.join(ARCHIVE_DIR, "master_dossier.md");
`);

code = code.replace(/module.exports = \{ startServer \};/, `
function setApiKey(key) {
    apiKey = key;
    try {
        const data = JSON.parse(apiKey);
        apiKey = data.api_key || apiKey;
    } catch(e) {}
    ai.apiKey = apiKey; // AI client might need re-instantiation, but we'll instantiate on each chat creation if needed.
}

function setArchiveDir(dir) {
    ARCHIVE_DIR = dir;
    if (!fs.existsSync(ARCHIVE_DIR)) {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    MASTER_DOSSIER_PATH = path.join(ARCHIVE_DIR, "master_dossier.md");
}

module.exports = { startServer, setApiKey, setArchiveDir };
`);

fs.writeFileSync('server.js', code);
