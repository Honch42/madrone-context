'use strict';
// Google Workspace integration: sign-in (OAuth on a local loopback port) and the
// two context fetches (rearward: recent mail and documents; forward: calendar,
// drafts, starred and deadline mail). Every connected account is fetched with a
// hard timeout so a slow or revoked account can never stall the interview.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const config = require('./config');

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.readonly',
  // gmail.readonly is a Google "restricted" scope. See README.md, "Google sign-in", for what that means.
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

// ---------------------------------------------------------------------------
// OAuth client configuration (the JSON file downloaded from Google Cloud Console)

function parseClientJson(text) {
  const data = JSON.parse(text);
  const creds = data.installed || data.web || data;
  if (!creds.client_id || !creds.client_secret) throw new Error('This file does not contain a client_id and client_secret.');
  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

function loadClientConfig(settings = config.getSettings()) {
  const candidates = [];
  if (settings.googleClientPath) candidates.push(settings.googleClientPath);
  candidates.push(path.join(__dirname, '..', 'google_oauth_client.json'));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'google_oauth_client.json'));
  for (const file of candidates) {
    try { if (fs.existsSync(file)) return { ...parseClientJson(fs.readFileSync(file, 'utf-8')), source: file }; } catch (e) { /* try next */ }
  }
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return { client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, source: 'environment' };
  }
  const legacy = config.getSecret('legacyGoogleClientJson');
  if (legacy) { try { return { ...parseClientJson(legacy), source: 'imported' }; } catch (e) { /* ignore */ } }
  return null;
}

function hasClientConfig() {
  return !!loadClientConfig();
}

// ---------------------------------------------------------------------------
// Sign-in

function landingPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;background:#faf7f3;color:#24201c;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 12px">${title}</h2><p style="color:#5e554d">${body}</p></div></body>`;
}

// Opens the Google consent screen in the user's browser and waits for the
// redirect back to a one-off local server. Resolves with the saved account.
async function connectAccount({ openExternal, timeoutMs = 5 * 60 * 1000 } = {}) {
  const clientConfig = loadClientConfig();
  if (!clientConfig) throw new Error('No Google OAuth client file is configured. See Settings.');

  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); fn(value); };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.statusCode = 404; res.end('Not found'); return; }
      if (url.searchParams.get('state') !== state) { res.end(landingPage('Sign-in failed', 'The response did not match this sign-in attempt. Please try again from the app.')); finish(reject, new Error('OAuth state mismatch.')); return; }
      const error = url.searchParams.get('error');
      if (error) { res.end(landingPage('Sign-in cancelled', `Google reported: ${error}. You can close this tab.`)); finish(reject, new Error(`Google sign-in was cancelled (${error}).`)); return; }
      const code = url.searchParams.get('code');
      try {
        const oauth2 = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret, redirectUri);
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);
        const info = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
        const email = info.data.email || null;
        const id = email ? `google-${email.toLowerCase()}` : `google-${crypto.randomBytes(6).toString('hex')}`;
        const existing = config.getGoogleAccountTokens(id);
        if (!tokens.refresh_token && existing && existing.refresh_token) tokens.refresh_token = existing.refresh_token;
        const saved = config.saveGoogleAccount({ id, email, label: email, tokens });
        res.end(landingPage('Connected', `${email || 'Your Google account'} is now connected to Madrone Context. You can close this tab and return to the app.`));
        finish(resolve, saved);
      } catch (e) {
        res.end(landingPage('Sign-in failed', `${e.message}. You can close this tab and try again from the app.`));
        finish(reject, e);
      }
    });

    let redirectUri = null;
    const timer = setTimeout(() => finish(reject, new Error('Google sign-in timed out. Please try again.')), timeoutMs);
    server.on('error', e => finish(reject, e));
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const oauth2 = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret, redirectUri);
      const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
      Promise.resolve(openExternal(url)).catch(e => finish(reject, e));
    });
  });
}

function authFor(account) {
  const clientConfig = loadClientConfig();
  const tokens = config.getGoogleAccountTokens(account.id);
  if (!clientConfig || !tokens) return null;
  const auth = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret);
  auth.setCredentials(tokens);
  auth.on('tokens', fresh => config.updateGoogleAccountTokens(account.id, fresh));
  return auth;
}

function isAuthError(e) {
  const msg = String(e && e.message || '');
  return /invalid_grant|invalid_client|unauthorized_client|Token has been expired or revoked|401/i.test(msg);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { timedOut: true })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function subjectsFor(gmail, ids, withSnippet) {
  const out = await Promise.all(ids.map(async id => {
    const m = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
    const headers = m.data.payload && m.data.payload.headers || [];
    const subject = (headers.find(h => h.name === 'Subject') || {}).value || 'No subject';
    const from = (headers.find(h => h.name === 'From') || {}).value || 'Unknown sender';
    return withSnippet ? `${subject} (from ${from}): ${m.data.snippet || ''}` : `${subject} (from ${from})`;
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Context fetches. Each returns { text, notices[] }.

async function fetchRearwardContext({ sinceIso, perAccountTimeoutMs = 8000, accounts: accountsIn } = {}) {
  const accounts = accountsIn || config.listGoogleAccounts();
  const notices = [];
  const lines = [];
  if (accounts.length === 0) {
    return { text: '', notices: [accountsIn ? 'This context has no Google account assigned, so there is no email or document context yet.' : 'No Google account is connected, so there is no email or document context yet.'] };
  }
  const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 86400000);
  const unix = Math.floor(since.getTime() / 1000);

  for (const account of accounts) {
    const auth = authFor(account);
    if (!auth || account.needsReconnect) { notices.push(`${account.label}: needs to be reconnected in Settings.`); continue; }
    try {
      await withTimeout((async () => {
        const gmail = google.gmail({ version: 'v1', auth });
        const drive = google.drive({ version: 'v3', auth });
        const [inbox, sent, files] = await Promise.all([
          gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${unix}`, maxResults: 10 }),
          gmail.users.messages.list({ userId: 'me', q: `in:sent after:${unix}`, maxResults: 5 }),
          drive.files.list({ q: `modifiedTime > '${since.toISOString()}'`, pageSize: 5, fields: 'files(name, modifiedTime)', orderBy: 'modifiedTime desc' })
        ]);
        const inboxIds = (inbox.data.messages || []).map(m => m.id);
        const sentIds = (sent.data.messages || []).map(m => m.id);
        lines.push(`[${account.label}] Recent inbox:`);
        const inboxLines = await subjectsFor(gmail, inboxIds, true);
        lines.push(...(inboxLines.length ? inboxLines.map(l => `- ${l}`) : ['- No new email.']));
        lines.push(`[${account.label}] Recently sent:`);
        const sentLines = await subjectsFor(gmail, sentIds, false);
        lines.push(...(sentLines.length ? sentLines.map(l => `- ${l}`) : ['- Nothing sent.']));
        lines.push(`[${account.label}] Recently modified documents:`);
        const docs = files.data.files || [];
        lines.push(...(docs.length ? docs.map(f => `- ${f.name} (${f.modifiedTime})`) : ['- None.']));
      })(), perAccountTimeoutMs, account.label);
    } catch (e) {
      if (isAuthError(e)) { config.markGoogleAccountNeedsReconnect(account.id); notices.push(`${account.label}: Google access expired. Reconnect it in Settings.`); }
      else if (e.timedOut) notices.push(`${account.label}: Google did not respond in time. Continuing without it.`);
      else notices.push(`${account.label}: ${e.message}`);
    }
  }
  return { text: lines.join('\n'), notices };
}

async function fetchForwardContext({ perAccountTimeoutMs = 8000, accounts: accountsIn } = {}) {
  const accounts = accountsIn || config.listGoogleAccounts();
  const notices = [];
  const lines = [];
  if (accounts.length === 0) {
    return { text: '', notices: [accountsIn ? 'This context has no Google account assigned, so there is no calendar context yet.' : 'No Google account is connected, so there is no calendar context yet.'] };
  }
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 86400000);

  for (const account of accounts) {
    const auth = authFor(account);
    if (!auth || account.needsReconnect) { notices.push(`${account.label}: needs to be reconnected in Settings.`); continue; }
    try {
      await withTimeout((async () => {
        const calendar = google.calendar({ version: 'v3', auth });
        const gmail = google.gmail({ version: 'v1', auth });
        const [events, drafts, starred, deadlines] = await Promise.all([
          calendar.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: in7Days.toISOString(), maxResults: 12, singleEvents: true, orderBy: 'startTime' }),
          gmail.users.messages.list({ userId: 'me', q: 'is:draft', maxResults: 5 }),
          gmail.users.messages.list({ userId: 'me', q: 'is:starred', maxResults: 5 }),
          gmail.users.messages.list({ userId: 'me', q: 'in:inbox (deadline OR due OR "action required" OR invoice) newer_than:7d', maxResults: 5 })
        ]);
        lines.push(`[${account.label}] Upcoming calendar (7 days):`);
        const items = events.data.items || [];
        lines.push(...(items.length ? items.map(ev => `- ${ev.summary || 'Untitled'} at ${ev.start && (ev.start.dateTime || ev.start.date)}${ev.attendees ? ` with ${ev.attendees.length} attendees` : ''}`) : ['- No upcoming events.']));
        for (const [label, res] of [['Draft emails', drafts], ['Starred emails', starred], ['Deadline-related emails', deadlines]]) {
          const ids = (res.data.messages || []).map(m => m.id);
          if (!ids.length) continue;
          lines.push(`[${account.label}] ${label}:`);
          lines.push(...(await subjectsFor(gmail, ids, false)).map(l => `- ${l}`));
        }
      })(), perAccountTimeoutMs, account.label);
    } catch (e) {
      if (isAuthError(e)) { config.markGoogleAccountNeedsReconnect(account.id); notices.push(`${account.label}: Google access expired. Reconnect it in Settings.`); }
      else if (e.timedOut) notices.push(`${account.label}: Google did not respond in time. Continuing without it.`);
      else notices.push(`${account.label}: ${e.message}`);
    }
  }
  return { text: lines.join('\n'), notices };
}

module.exports = { SCOPES, loadClientConfig, hasClientConfig, parseClientJson, connectAccount, fetchRearwardContext, fetchForwardContext };
