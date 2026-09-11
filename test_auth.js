const { google } = require('googleapis');
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

const tokenRaw = getKeychainPassword('google-token-Personal');
const tokenData = JSON.parse(tokenRaw);

const secretRaw = getKeychainPassword('google-client-secret-Personal');
const secretData = JSON.parse(secretRaw);

console.log("Secret Data structure:", Object.keys(secretData.installed || secretData.web || {}));

const client_id = (secretData.installed || secretData.web).client_id;
const client_secret = (secretData.installed || secretData.web).client_secret;

const auth = new google.auth.OAuth2(client_id, client_secret);
auth.setCredentials(tokenData);

const gmail = google.gmail({ version: 'v1', auth });
gmail.users.messages.list({ userId: 'me', maxResults: 1 }).then(res => {
    console.log("SUCCESS! Got message:", res.data.messages[0].id);
}).catch(e => {
    console.log("ERROR:", e.message);
});

