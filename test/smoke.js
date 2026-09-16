'use strict';
// End-to-end smoke test of the server with a fake model, no Electron and no
// network. Run with `npm test`. It starts the server, runs an interview over the
// WebSocket, concludes it, saves it, and checks what landed on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madrone-smoke-'));
process.env.MADRONE_CONFIG_DIR = path.join(tmp, 'config');
process.env.MADRONE_ICLOUD_WAIT_MS = '1500';

const config = require('../src/config');
config.setSetting('workspaceDir', path.join(tmp, 'vault'));
config.setSecret('geminiApiKey', 'test-key');

// Replace the real model adapters with a scripted fake.
const providers = require('../src/providers');
class FakeProvider {
  constructor() { this.supportsVideo = true; this.turn = 0; this.calls = []; }
  async respond(text) {
    this.calls.push(['respond', text]);
    if (/started a session|Master Dossier/.test(text)) return JSON.stringify({ transcript: '[Session started]', question: 'What is on your mind today?' });
    if (/session has concluded/.test(text)) return '```json\n' + JSON.stringify({
      summary: '## Primary objective\nShip [[Madrone Context]] to friends.', insights: '- Cares about friends',
      people: [{ name: 'Jane Doe', note: 'A friend who will test the app' }],
      projects: [{ name: 'Madrone Context', note: 'The interview app' }, { name: 'madrone context', note: 'duplicate spelling' }],
      topics: [{ name: 'Distribution', note: 'Getting the app to friends' }],
      energy: 'high', confidence: 8
    }) + '\n```';
    return JSON.stringify({ transcript: '[Context loaded]', question: 'Follow-up after context?' });
  }
  async respondToAudio(buffer, mime, note) {
    this.calls.push(['audio', buffer.length, mime, note]);
    this.turn++;
    if (this.turn === 1) return { raw: '{"transcript":"I want to ship this app to my friends.","question":"Why does that matter to you?"}', parsed: { transcript: 'I want to ship this app to my friends.', question: 'Why does that matter to you?' }, transcript: 'I want to ship this app to my friends.' };
    return { raw: 'Not JSON at all', parsed: null, transcript: 'Second answer' };
  }
  async transcribe(buffer, mime) {
    this.calls.push(['transcribe', buffer.length, mime]);
    if (mime === 'audio/mp4') return 'Remind me to call the vet about Rex on Friday';
    return 'Final words before concluding.';
  }
  async analyzeVideo(filePath, prompt) { this.calls.push(['video', fs.statSync(filePath).size]); return JSON.stringify({ insights: '- Leaned in when talking about friends', synergy_diff: 'Words and posture agreed.\n\nDetected incongruence: none', incongruence: false }); }
  async oneShot(prompt) { this.calls.push(['oneShot', prompt.length]); return '# Master Dossier\n\n## Current goals\n- Ship the app to friends\n\n## Recent sessions\n- one'; }
}
let fake = null;
providers.createProvider = () => { fake = new FakeProvider(); return fake; };

const storage = require('../src/storage');
// A legacy layout (files at the notes-folder root) and an existing entity note the
// model should reuse, inside a folder that looks like an Obsidian vault.
fs.mkdirSync(path.join(tmp, 'vault', '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'vault', 'sessions'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'vault', 'master_dossier.md'), '# Old dossier\n');
fs.writeFileSync(path.join(tmp, 'vault', 'sessions', 'old_session.md'), 'old');
fs.mkdirSync(path.join(tmp, 'vault', 'Madrone', 'People'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'vault', 'Madrone', 'People', 'Jane Doe.md'), '---\ntype: person\n---\n# Jane Doe\n\nJane runs the beta group.\n\n## Mentions\n- [[2026-01-01_0900_session|earlier]]: first mention\n');
const { startServer } = require('../src/server');
const discover = require('../src/discover');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }

(async () => {
  // Key discovery: dotenv parsing and key-shape checks.
  const env = discover.parseDotenv('# comment\nexport ANTHROPIC_API_KEY="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"\nGEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnop # trailing\nOPENAI_API_KEY=\'sk-proj-abcdefghijklmnopqrstuvwxyz\'\nJUNK');
  assert(env.ANTHROPIC_API_KEY.startsWith('sk-ant-') && env.GEMINI_API_KEY === 'AIzaSyA1234567890abcdefghijklmnop' && env.OPENAI_API_KEY.startsWith('sk-proj'), 'dotenv parsing handles export, quotes and comments');
  assert(discover.looksLikeKey('gemini', env.GEMINI_API_KEY) && discover.looksLikeKey('anthropic', env.ANTHROPIC_API_KEY) && !discover.looksLikeKey('anthropic', env.OPENAI_API_KEY), 'key shapes are vendor-specific');
  assert(discover.mask(env.ANTHROPIC_API_KEY) === 'sk-ant-…0123', 'masked preview shows only the ends');

  // 1Password: secret-field selection and reference detection (no CLI needed).
  const op = require('../src/onepassword');
  const shape = v => discover.looksLikeKey('anthropic', v);
  const cred = op.pickSecretField({ fields: [{ id: 'username', type: 'STRING', value: 'me' }, { id: 'credential', type: 'CONCEALED', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }] }, shape);
  assert(cred && cred.id === 'credential', '1Password API Credential item: credential field chosen');
  const pw = op.pickSecretField({ fields: [{ id: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz9999' }] }, shape);
  assert(pw && pw.id === 'password', '1Password Password item: password field chosen');
  const shaped = op.pickSecretField({ fields: [{ id: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: 'not-a-key' }, { id: 'x', label: 'API key', type: 'CONCEALED', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz5555' }] }, shape);
  assert(shaped && shaped.id === 'x', '1Password item with several secrets: the one shaped like the vendor key wins');
  assert(op.isReference('op://Private/Anthropic API key/credential') && !op.isReference('sk-ant-abc'), 'op:// references are recognised');
  const clip = discover.register('gemini', 'AIzaSyA1234567890abcdefghijklmnop', 'Clipboard');
  assert(clip && discover.resolve(clip.id).value.startsWith('AIza') && discover.register('gemini', 'hello', 'Clipboard') === null, 'clipboard registration accepts only key-shaped text');
  const fromFile = discover.candidatesFromEnvText('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\nGEMINI_API_KEY=nope', 'test.env');
  assert(fromFile.openai.length === 1 && fromFile.gemini.length === 0, '.env import keeps only well-formed keys');

  const { port, server } = await startServer();
  const base = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(`${base}/ws/orchestrator`);
  const inbox = [];
  const waiters = [];
  ws.on('message', m => {
    const data = JSON.parse(m.toString());
    if (data.type === 'error' || (data.type === 'notice' && data.level === 'error')) console.log(`   [server ${data.type}] ${data.text}`);
    const w = waiters.find(x => x.type === data.type);
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(data); } else inbox.push(data);
  });
  const next = type => new Promise((resolve, reject) => {
    const found = inbox.find(m => m.type === type);
    if (found) { inbox.splice(inbox.indexOf(found), 1); return resolve(found); }
    const w = { type, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error('timeout waiting for ' + type)), 8000);
  });
  await new Promise(r => ws.on('open', r));

  ws.send(JSON.stringify({ type: 'init', model: 'gemini-3.6-flash', persona: 'grow' }));
  const session = await next('session');
  assert(/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(session.session_id), `session id looks like a date: ${session.session_id}`);
  const q1 = await next('question');
  assert(q1.text === 'What is on your mind today?', 'opening question delivered');
  assert(fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'master_dossier.md')) && fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'Sessions', 'old_session.md')) && !fs.existsSync(path.join(tmp, 'vault', 'master_dossier.md')), 'legacy files migrated into Madrone/');

  // Stream a fake recording to the archive socket.
  const archive = new WebSocket(`${base}/ws/archive?session=${session.session_id}&kind=video`);
  await new Promise(r => archive.on('open', r));
  for (let i = 0; i < 5; i++) archive.send(Buffer.alloc(10000, i));

  // Turn 1: normal JSON answer.
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm;codecs=opus' }));
  ws.send(Buffer.alloc(5000, 1));
  const q2 = await next('question');
  assert(q2.text === 'Why does that matter to you?' && q2.transcript.startsWith('I want to ship'), 'turn 1 question and transcript');

  // A tiny blob (silence) is bounced back as "listen", not sent to the model.
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm' }));
  ws.send(Buffer.alloc(300));
  await next('listen');
  assert(fake.turn === 1, 'silent blob did not reach the model');

  // Turn 2 after the soft time limit: non-JSON reply is used verbatim, wind-down note attached.
  ws.send(JSON.stringify({ type: 'time_check' }));
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm' }));
  ws.send(Buffer.alloc(5000, 2));
  const q3 = await next('question');
  assert(q3.text === 'Not JSON at all' && q3.transcript === 'Second answer', 'turn 2 falls back to raw text');
  // (turn 1 transcript mentioned no known entity; make turn 3 mention Jane and check the note arrives on turn 4)
  fake.respondToAudio = async (buffer, mime, note) => { fake.calls.push(['audio', buffer.length, mime, note]); return { raw: '{"transcript":"I talked to Jane Doe about the beta.","question":"How did that go?"}', parsed: { transcript: 'I talked to Jane Doe about the beta.', question: 'How did that go?' }, transcript: 'I talked to Jane Doe about the beta.' }; };
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm' }));
  ws.send(Buffer.alloc(5000, 4));
  await next('question');
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm' }));
  ws.send(Buffer.alloc(5000, 5));
  await next('question');
  const last = fake.calls.filter(c => c[0] === 'audio').pop();
  assert(last[3].includes('Jane runs the beta group'), 'mentioning a known person hands her note to the interviewer on the next turn');
  assert(fake.calls.find(c => c[0] === 'audio' && c[3] && c[3].includes('soft time limit')), 'wind-down note was attached after time_check');

  // Conclude mid-answer: the final utterance is transcribed but gets no question.
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm', final: true }));
  ws.send(Buffer.alloc(5000, 3));
  archive.close();
  ws.send(JSON.stringify({ type: 'end_session' }));
  const review = await next('review');
  assert(review.summary.includes('Ship [[Madrone Context]]'), 'summary parsed out of a fenced JSON reply');
  assert(review.video_status === 'pending', 'video analysis is pending on a Gemini model');
  assert(review.transcript.some(t => t.role === 'user' && t.text === 'Final words before concluding.'), 'final utterance landed in the transcript');
  const analysis = await next('analysis');
  assert(analysis.synergy.includes('posture agreed'), 'video analysis delivered');

  ws.send(JSON.stringify({ type: 'save_session' }));
  const saved = await next('saved');
  assert(fs.existsSync(saved.note_path), `note written: ${saved.note_path}`);
  const note = fs.readFileSync(saved.note_path, 'utf-8');
  assert(note.startsWith('---\nsession_id: ' + session.session_id), 'note frontmatter carries the session id');
  assert(note.includes('recording: "Madrone/archives/'), 'note links to the recording by vault-relative path');
  assert(note.includes(`![[${session.session_id}_video.webm]]`), 'note embeds the recording for inline playback');
  assert(note.includes('people:\n  - "[[Jane Doe]]"') && note.includes('projects:\n  - "[[Madrone Context]]"\ntopics:') && note.includes('energy: "high"') && note.includes('confidence: 8') && note.includes('incongruence: false'), 'note properties carry links and scores');
  assert(saved.entities.projects.length === 1, 'duplicate spelling of a project collapsed onto one note');
  const jane = fs.readFileSync(path.join(tmp, 'vault', 'Madrone', 'People', 'Jane Doe.md'), 'utf-8');
  assert(jane.includes('first mention') && jane.includes(`[[${session.session_id}_session|`) && jane.includes('A friend who will test the app'), 'existing person note gained a mention line and kept its history');
  assert(fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'Projects', 'Madrone Context.md')) && fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'Topics', 'Distribution.md')), 'new project and topic notes created');
  assert(saved.base_created && fs.readFileSync(path.join(tmp, 'vault', 'Madrone', 'Madrone Sessions.base'), 'utf-8').includes('file.hasTag("madrone-session")'), 'Bases file written');
  assert(saved.obsidian_url && saved.obsidian_url.startsWith('obsidian://open?path='), 'saved message carries an Obsidian link inside a vault');
  assert(note.includes('**00:00 AI:** What is on your mind today?') && note.includes('You:** I want to ship'), 'transcript is time-indexed');
  assert(note.includes('From the video'), 'video insights merged into the note');
  const dossier = fs.readFileSync(path.join(tmp, 'vault', 'Madrone', 'master_dossier.md'), 'utf-8');
  assert(dossier.includes('Ship the app to friends') && saved.dossier_updated, 'dossier rewritten');
  const video = path.join(tmp, 'vault', 'Madrone', 'archives', session.session_id.slice(0, 4), session.session_id.slice(5, 7), `${session.session_id}_video.webm`);
  assert(fs.statSync(video).size === 50000, 'recording streamed to archives/YYYY/MM with the session id');

  // Second session: discard deletes the recording.
  ws.send(JSON.stringify({ type: 'init', model: 'gemini-3.6-flash', persona: 'socratic' }));
  const s2 = await next('session');
  await next('question');
  const archive2 = new WebSocket(`${base}/ws/archive?session=${s2.session_id}&kind=video`);
  await new Promise(r => archive2.on('open', r));
  archive2.send(Buffer.alloc(30000));
  await new Promise(r => setTimeout(r, 100));
  archive2.close();
  ws.send(JSON.stringify({ type: 'end_session' }));
  await next('review');
  ws.send(JSON.stringify({ type: 'discard_session' }));
  const discarded = await next('discarded');
  assert(discarded.removed.length === 1 && !fs.existsSync(discarded.removed[0]), 'discard deleted the recording');
  assert(!fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'Sessions', `${s2.session_id}_session.md`)), 'discard wrote no note');
  const history = fs.readdirSync(path.join(tmp, 'vault', 'Madrone', 'dossier_history'));
  assert(history.length === 1, 'the migrated legacy dossier was backed up before the first rewrite');

  // ---- Contexts and the inbox review ----
  config.updateContext(config.listContexts()[0].id, { name: 'Personal' });
  const work = config.addContext({ name: 'Madrone Collective', notesDir: path.join(tmp, 'vault', 'Madrone Collective') });
  const inboxDir = path.join(tmp, 'vault', 'Inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'Recording 1.m4a'), Buffer.alloc(4000, 7));
  fs.writeFileSync(path.join(inboxDir, 'Quick note.md'), '---\ncreated: 2026-09-15\n---\nIdea: pitch the beta group on a shared vault template');
  fs.writeFileSync(path.join(inboxDir, '.Later.m4a.icloud'), 'placeholder');
  config.addInbox({ dir: inboxDir });
  const inboxMod = require('../src/inbox');
  const scanned = inboxMod.scan(config.listInboxes(), config.getInboxProcessed());
  assert(scanned.length === 3 && scanned.filter(i => i.placeholder).length === 1 && scanned.find(i => i.kind === 'text'), 'inbox scan finds audio, text and an iCloud placeholder');
  const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert(st.contexts.length === 2 && st.inboxNew === 3 && st.inboxConfigured, '/api/status reports contexts and new inbox items');

  const audioId = scanned.find(i => i.kind === 'audio' && !i.placeholder).id;
  const noteId = scanned.find(i => i.kind === 'text').id;
  const personalId = st.contexts.find(c => c.name === 'Personal').id;
  ws.send(JSON.stringify({ type: 'init', model: 'gemini-3.6-flash', persona: 'socratic', mode: 'inbox', context_id: personalId }));
  const s3 = await next('session');
  assert(s3.mode === 'inbox' && s3.context === 'Personal' && s3.inbox_total === 3, 'inbox session starts in the chosen context');
  const ready = await next('inbox_ready');
  assert(ready.total === 2, 'placeholder that never downloads is skipped; audio and note are ready');
  fake.respondToAudio = async (buffer, mime, note) => {
    fake.calls.push(['audio', buffer.length, mime, note]);
    return { raw: '', transcript: 'Yes, a to-do for personal, due Friday the 18th. And the note is a thought for the collective.', parsed: {
      transcript: 'Yes, a to-do for personal, due Friday the 18th. And the note is a thought for the collective.',
      triage: [
        { item: audioId, kind: 'todo', context: 'personal', title: 'Call the vet about Rex', text: 'Call the vet about Rex.', due: '2026-09-18', people: [], projects: [], topics: ['Pets'] },
        { item: noteId, kind: 'thought', context: 'Madrone Collective', title: 'Shared vault template for the beta group', text: 'Pitch the beta group on a shared vault template.', due: null, people: ['Jane Doe'], projects: ['Madrone Context'], topics: [] }
      ],
      question: "That's everything in your inbox.", done: true } };
  };

  assert(fake.calls.some(c => c[0] === 'transcribe' && c[2] === 'audio/mp4'), 'inbox voice memo transcribed as audio/mp4');
  await next('question');
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm' }));
  ws.send(Buffer.alloc(5000, 9));
  const t1 = await next('triage');
  const t2 = await next('triage');
  assert([t1, t2].some(t => t.kind === 'todo' && t.context === 'Personal') && [t2, t1].some(t => t.kind === 'thought' && t.context === 'Madrone Collective'), 'triage decisions routed to the named contexts');
  await next('question');
  await next('inbox_done');
  const actions = fs.readFileSync(path.join(tmp, 'vault', 'Madrone', 'Action Items.md'), 'utf-8');
  assert(actions.includes('- [ ] Call the vet about Rex 📅 2026-09-18'), 'to-do written in Obsidian Tasks format with its due date');
  const thoughtsDir = path.join(tmp, 'vault', 'Madrone Collective', 'Madrone', 'Thoughts');
  const thoughtFile = fs.readdirSync(thoughtsDir)[0];
  const thought = fs.readFileSync(path.join(thoughtsDir, thoughtFile), 'utf-8');
  assert(thought.includes('Shared vault template') && thought.includes('[[Jane Doe]]') && fs.existsSync(path.join(tmp, 'vault', 'Madrone Collective', 'Madrone', 'People', 'Jane Doe.md')), 'thought written in the other context with its entity notes');
  assert(fs.existsSync(path.join(tmp, 'vault', 'Madrone', 'Topics', 'Pets.md')), 'topic note created in the to-do context');
  assert(!fs.existsSync(path.join(inboxDir, 'Recording 1.m4a')) && fs.readdirSync(path.join(inboxDir, 'Processed')).length === 1, 'reviewed items moved into Inbox/Processed');
  assert(inboxMod.scan(config.listInboxes(), config.getInboxProcessed()).filter(i => !i.placeholder).length === 0, 'no new items remain after the review');

  ws.send(JSON.stringify({ type: 'end_session' }));
  await next('review');
  ws.send(JSON.stringify({ type: 'save_session' }));
  const saved3 = await next('saved');
  const note3 = fs.readFileSync(saved3.note_path, 'utf-8');
  assert(saved3.decisions === 2 && note3.includes('type: inbox-review') && note3.includes('## Inbox decisions') && note3.includes('todo → Personal'), 'review session note records the decisions');

  // ---- Per-context Google account scoping ----
  const personalCtxId = personalId;
  const collectiveCtxId = work.id;
  const acctPersonal = config.saveGoogleAccount({ id: 'g-personal', email: 'me@personal.example', label: 'Personal', tokens: { refresh_token: 'x' } });
  const acctCollective = config.saveGoogleAccount({ id: 'g-collective', email: 'me@collective.example', label: 'Collective', tokens: { refresh_token: 'y' } });
  const acctIv = config.saveGoogleAccount({ id: 'g-iv', email: 'me@iv.example', label: 'IV', tokens: { refresh_token: 'z' } });
  assert(config.googleAccountsForContext(personalCtxId).length === 3, 'a context with no scope set sees every connected account');
  config.setContextGoogleAccounts(personalCtxId, [acctPersonal.id]);
  const scopedPersonal = config.googleAccountsForContext(personalCtxId);
  assert(scopedPersonal.length === 1 && scopedPersonal[0].id === acctPersonal.id, 'scoping a context to one account resolves to just that account');
  assert(config.googleAccountsForContext(collectiveCtxId).length === 3, 'scoping one context does not affect another');
  config.setContextGoogleAccounts(personalCtxId, []);
  assert(config.googleAccountsForContext(personalCtxId).length === 0, 'a context can be explicitly scoped to no Google accounts at all');
  config.setContextGoogleAccounts(personalCtxId, null);
  assert(config.contextSettings(personalCtxId).context.googleAccountIds === null && config.googleAccountsForContext(personalCtxId).length === 3, 'passing null resets a context to the default: every connected account, including ones added later');
  config.setContextGoogleAccounts(personalCtxId, ['not-a-real-account-id']);
  assert(config.googleAccountsForContext(personalCtxId).length === 0, 'an id that matches no connected account resolves to an explicit empty scope, not "all"');
  config.setContextGoogleAccounts(personalCtxId, [acctCollective.id]);
  const removed = config.listGoogleAccounts().filter(a => a.id !== acctCollective.id);
  config.getStore().set('googleAccounts', removed.map(a => ({ ...a, tokens: 'plain:x' })));
  assert(config.googleAccountsForContext(personalCtxId).length === 2, 'a scope naming only an account that was later disconnected falls back to all remaining accounts');

  ws.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nAll smoke checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
