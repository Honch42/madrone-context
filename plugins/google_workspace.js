const { google } = require('googleapis');
const { execSync } = require('child_process');

function getKeychainPassword(account, service="AntiGravity") {
    try {
        const result = execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, { encoding: 'utf-8' });
        return result.trim();
    } catch (error) {
        return null;
    }
}

function getAuthClient(suffix) {
    const raw = getKeychainPassword(`google-token-${suffix}`);
    if (raw) {
        try {
            const tokenData = JSON.parse(raw);
            const auth = new google.auth.OAuth2();
            auth.setCredentials(tokenData);
            return auth;
        } catch (e) {
            return null;
        }
    }
    return null;
}

const ACCOUNTS = [
    { name: "Personal (john.honchariw@gmail.com)", suffix: "Personal" },
    { name: "Collective (honch@madrone-collective.com)", suffix: "Collective" },
    { name: "IV (honch@madrone-iv.com)", suffix: "IV" }
];

async function fetchRearwardContext(sinceTimestamp) {
    const allResults = [];
    let unixTime = Math.floor(Date.now() / 1000) - 86400;
    try {
        if (sinceTimestamp) {
            unixTime = Math.floor(new Date(sinceTimestamp).getTime() / 1000);
        }
    } catch(e) {}
    
    for (const acc of ACCOUNTS) {
        const auth = getAuthClient(acc.suffix);
        if (!auth) {
            allResults.push(`[${acc.name}] No credentials found.`);
            continue;
        }
        
        try {
            const gmail = google.gmail({ version: 'v1', auth });
            const inboxRes = await gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${unixTime}`, maxResults: 10 });
            const sentRes = await gmail.users.messages.list({ userId: 'me', q: `in:sent after:${unixTime}`, maxResults: 5 });
            
            const msgs = [...(inboxRes.data.messages || []), ...(sentRes.data.messages || [])];
            
            if (msgs.length === 0) {
                allResults.push(`[${acc.name}] No new emails.`);
            } else {
                for (const m of msgs) {
                    const msgData = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata' });
                    const headers = msgData.data.payload.headers || [];
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                    const sender = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
                    allResults.push(`[${acc.name}] Email (From: ${sender}): ${subject} - ${msgData.data.snippet}`);
                }
            }
        } catch (e) {
            allResults.push(`[${acc.name}] Gmail Error: ${e.message}`);
        }
        
        try {
            const drive = google.drive({ version: 'v3', auth });
            const driveRes = await drive.files.list({ q: `modifiedTime > '${sinceTimestamp || new Date(Date.now() - 86400000).toISOString()}'`, pageSize: 5, fields: 'files(id, name, modifiedTime)' });
            const files = driveRes.data.files || [];
            
            if (files.length === 0) {
                allResults.push(`[${acc.name}] No newly modified documents.`);
            } else {
                for (const f of files) {
                    allResults.push(`[${acc.name}] Modified Document: ${f.name} (at ${f.modifiedTime})`);
                }
            }
        } catch (e) {
            allResults.push(`[${acc.name}] Drive Error: ${e.message}`);
        }
    }
    
    return allResults.join("\n");
}

async function fetchForwardContext() {
    const allResults = [];
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (const acc of ACCOUNTS) {
        const auth = getAuthClient(acc.suffix);
        if (!auth) {
            allResults.push(`[${acc.name}] No credentials found.`);
            continue;
        }
        
        try {
            const calendar = google.calendar({ version: 'v3', auth });
            const calRes = await calendar.events.list({
                calendarId: 'primary',
                timeMin: now.toISOString(),
                timeMax: in7Days.toISOString(),
                maxResults: 10,
                singleEvents: true,
                orderBy: 'startTime'
            });
            const events = calRes.data.items || [];
            
            if (events.length === 0) {
                allResults.push(`[${acc.name}] Calendar: No upcoming events.`);
            } else {
                for (const ev of events) {
                    const start = ev.start.dateTime || ev.start.date;
                    const summary = ev.summary || 'Untitled';
                    allResults.push(`[${acc.name}] Upcoming Event: ${summary} (at ${start})`);
                }
            }
        } catch (e) {
            allResults.push(`[${acc.name}] Calendar Error: ${e.message}`);
        }
        
        try {
            const gmail = google.gmail({ version: 'v1', auth });
            
            const fetchEmails = async (query, label) => {
                const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 5 });
                const msgs = res.data.messages || [];
                for (const m of msgs) {
                    const msgData = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata' });
                    const headers = msgData.data.payload.headers || [];
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                    allResults.push(`[${acc.name}] ${label}: ${subject}`);
                }
            };
            
            await fetchEmails("is:draft", "Draft Email");
            await fetchEmails("is:starred", "Starred Email");
            await fetchEmails('in:inbox (deadline OR due OR "action required" OR invoice) newer_than:7d', "Received Deadline");
            await fetchEmails('in:sent (deadline OR due OR timeline OR "action required") newer_than:7d', "Sent Deadline");
            
        } catch (e) {
            allResults.push(`[${acc.name}] Gmail Forward Context Error: ${e.message}`);
        }
    }
    
    return allResults.join("\n");
}

module.exports = { fetchRearwardContext, fetchForwardContext };
