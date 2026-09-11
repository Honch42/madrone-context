const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getKeychainPassword(account, service="AntiGravity") {
    try {
        const rawResult = execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, { encoding: 'utf-8' }).trim();
        let result = rawResult;
        if (/^[0-9a-fA-F]+$/.test(rawResult)) {
            try { result = Buffer.from(rawResult, 'hex').toString('utf-8'); } catch(e) {}
        }
        return result;
    } catch (error) {
        return null;
    }
}

async function testVideo() {
    const key = getKeychainPassword('gemini-api-key-Collective');
    const ai = new GoogleGenAI({ apiKey: key });
    
    // Create a dummy text file to act as our "video" for testing the upload API
    // (Gemini API allows uploading text files too, we just want to test the fileData serialization fix)
    const dummyPath = path.join(__dirname, 'dummy_test.txt');
    fs.writeFileSync(dummyPath, "This is a test file for upload.");
    
    console.log("Uploading file...");
    let myfile = await ai.files.upload({
        file: dummyPath,
        config: { mimeType: 'text/plain' }
    });
    
    console.log("File uploaded:", myfile.name, myfile.state);
    
    while (myfile.state === "PROCESSING") {
        await new Promise(resolve => setTimeout(resolve, 2000));
        myfile = await ai.files.get({ name: myfile.name });
    }
    
    if (myfile.state === "FAILED") {
        console.error("File processing failed!");
        return;
    }
    
    console.log("File is ready. Sending to model...");
    
    const filePart = { fileData: { fileUri: myfile.uri, mimeType: myfile.mimeType } };
    const prompt = "Please output a JSON object with exactly three keys: 'summary', 'insights', and 'synergy_diff'. Put 'TEST' for each.";
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                { role: 'user', parts: [filePart, { text: prompt }] }
            ]
        });
        
        console.log("RESPONSE RECEIVED:");
        console.log(response.text);
    } catch(e) {
        console.error("CRASH:", e);
    }
}

testVideo().then(() => process.exit(0));
