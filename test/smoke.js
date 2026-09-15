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
    if (/session has concluded/.test(text)) return '```json\n' + JSON.stringify({ summary: '## Primary objective\nShip the thing.', insights: '- Cares about friends' }) + '\n```';
    return JSON.stringify({ transcript: '[Context loaded]', question: 'Follow-up after context?' });
  }
  async respondToAudio(buffer, mime, note) {
    this.calls.push(['audio', buffer.length, mime, note]);
    this.turn++;
    if (this.turn === 1) return { raw: '{"transcript":"I want to ship this app to my friends.","question":"Why does that matter to you?"}', parsed: { transcript: 'I want to ship this app to my friends.', question: 'Why does that matter to you?' }, transcript: 'I want to ship this app to my friends.' };
    return { raw: 'Not JSON at all', parsed: null, transcript: 'Second answer' };
  }
  async transcribe(buffer, mime) { this.calls.push(['transcribe', buffer.length, mime]); return 'Final words before concluding.'; }
  async analyzeVideo(filePath, prompt) { this.calls.push(['video', fs.statSync(filePath).size]); return JSON.stringify({ insights: '- Leaned in when talking about friends', synergy_diff: 'Words and posture agreed.\n\nDetected incongruence: none' }); }
  async oneShot(prompt) { this.calls.push(['oneShot', prompt.length]); return '# Master Dossier\n\n## Current goals\n- Ship the app to friends\n\n## Recent sessions\n- one'; }
}
let fake = null;
providers.createProvider = () => { fake = new FakeProvider(); return fake; };

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
  assert(fake.calls.find(c => c[0] === 'audio' && c[3] && c[3].includes('soft time limit')), 'wind-down note was attached after time_check');

  // Conclude mid-answer: the final utterance is transcribed but gets no question.
  ws.send(JSON.stringify({ type: 'audio_meta', mime: 'audio/webm', final: true }));
  ws.send(Buffer.alloc(5000, 3));
  archive.close();
  ws.send(JSON.stringify({ type: 'end_session' }));
  const review = await next('review');
  assert(review.summary.includes('Ship the thing'), 'summary parsed out of a fenced JSON reply');
  assert(review.video_status === 'pending', 'video analysis is pending on a Gemini model');
  assert(review.transcript.some(t => t.role === 'user' && t.text === 'Final words before concluding.'), 'final utterance landed in the transcript');
  const analysis = await next('analysis');
  assert(analysis.synergy.includes('posture agreed'), 'video analysis delivered');

  ws.send(JSON.stringify({ type: 'save_session' }));
  const saved = await next('saved');
  assert(fs.existsSync(saved.note_path), `note written: ${saved.note_path}`);
  const note = fs.readFileSync(saved.note_path, 'utf-8');
  assert(note.startsWith('---\nsession_id: ' + session.session_id), 'note frontmatter carries the session id');
  assert(note.includes('recording: "archives/'), 'note links to the recording by relative path');
  assert(note.includes('**00:00 AI:** What is on your mind today?') && note.includes('You:** I want to ship'), 'transcript is time-indexed');
  assert(note.includes('From the video'), 'video insights merged into the note');
  const dossier = fs.readFileSync(path.join(tmp, 'vault', 'master_dossier.md'), 'utf-8');
  assert(dossier.includes('Ship the app to friends') && saved.dossier_updated, 'dossier rewritten');
  const video = path.join(tmp, 'vault', 'archives', session.session_id.slice(0, 4), session.session_id.slice(5, 7), `${session.session_id}_video.webm`);
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
  assert(!fs.existsSync(path.join(tmp, 'vault', 'sessions', `${s2.session_id}_session.md`)), 'discard wrote no note');
  const history = fs.readdirSync(path.join(tmp, 'vault', 'dossier_history'));
  assert(history.length === 0, 'no dossier backup exists before the first rewrite (first save had none to back up)');

  ws.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nAll smoke checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
