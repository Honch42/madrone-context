const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getScreenpipeContext(customDbPath) {
    return new Promise((resolve) => {
        let dbPath = customDbPath;
        if (!dbPath || !fs.existsSync(dbPath)) {
            dbPath = path.join(os.homedir(), '.screenpipe', 'db.sqlite');
            if (!fs.existsSync(dbPath)) {
                dbPath = path.join(os.homedir(), '.local', 'share', 'screenpipe', 'db.sqlite');
            }
        }
        
        if (!fs.existsSync(dbPath)) {
            resolve("[ScreenPipe] Local database not found. Please check your Screenpipe installation or configure a custom path in Settings.");
            return;
        }

        try {
            // Fetch latest OCR text
            const ocrQuery = `sqlite3 "${dbPath}" "SELECT app_name, window_name, full_text FROM frames WHERE full_text IS NOT NULL AND length(full_text) > 0 ORDER BY timestamp DESC LIMIT 5;"`;
            const rawOcr = execSync(ocrQuery, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
            
            let ocrContext = "[ScreenPipe Recent OCR Activity]\n";
            const ocrLines = rawOcr.trim().split('\n');
            if (ocrLines.length > 0 && ocrLines[0].length > 0) {
                for (const line of ocrLines) {
                    const parts = line.split('|');
                    if (parts.length >= 3) {
                        const appName = parts[0];
                        const windowName = parts[1];
                        const text = parts.slice(2).join('|').substring(0, 150).replace(/\n/g, " ");
                        ocrContext += `- [App: ${appName}] [Window: ${windowName}] Text: ${text}\n`;
                    }
                }
            } else {
                ocrContext += "No recent screen activity found.\n";
            }

            // Fetch latest Audio transcriptions
            const audioQuery = `sqlite3 "${dbPath}" "SELECT transcription FROM audio_transcriptions WHERE transcription IS NOT NULL AND length(transcription) > 0 ORDER BY timestamp DESC LIMIT 5;"`;
            const rawAudio = execSync(audioQuery, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
            
            let audioContext = "[ScreenPipe Recent Audio/Speech]\n";
            const audioLines = rawAudio.trim().split('\n');
            if (audioLines.length > 0 && audioLines[0].length > 0) {
                for (const line of audioLines) {
                    audioContext += `- Transcript: ${line.substring(0, 150)}\n`;
                }
            } else {
                audioContext += "No recent audio found.\n";
            }
            
            resolve(ocrContext + "\n" + audioContext);
        } catch(e) {
            resolve(`[ScreenPipe] Failed to read local database: ${e.message}`);
        }
    });
}

module.exports = { getScreenpipeContext };
