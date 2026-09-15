'use strict';
// Local HTTP + WebSocket server that runs the interview.
//
// Bound to 127.0.0.1 only: nothing on the network can reach it. The renderer
// talks to it over two WebSockets: /ws/orchestrator (the conversation) and
// /ws/archive (the background recording, streamed to disk in chunks).

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const config = require('./config');
const storage = require('./storage');
const prompts = require('./prompts');
const providers = require('./providers');
const mcp = require('./mcp');
const screenpipe = require('./screenpipe');
const googleCtx = require('./google');

const log = (...args) => console.log('[madrone]', ...args);
const sessions = new Map();

// ---------------------------------------------------------------------------

function sessionExistsOnDisk(settings, id, now) {
  const p = storage.sessionPaths(settings, id, now);
  return fs.existsSync(p.notePath) || fs.existsSync(p.videoPath) || fs.existsSync(p.audioPath);
}

class Session {
  constructor({ model, persona, deepDive, context }) {
    const now = new Date();
    // Two sessions started in the same minute would share an id; add a suffix
    // until neither the live session list nor the disk knows the id.
    const settings = config.getSettings();
    const base = storage.newSessionId(now);
    this.id = base;
    for (let n = 2; sessions.has(this.id) || sessionExistsOnDisk(settings, this.id, now); n++) this.id = `${base}-${n}`;
    this.startedAt = now.toISOString();
    this.endedAt = null;
    this.model = model;
    this.persona = persona;
    this.deepDive = !!deepDive;
    this.deepDiveContext = context || '';
    this.paths = storage.sessionPaths(settings, this.id, now);
    this.provider = null;
    this.transcript = [];
    this.mediaPath = null;
    this.mediaKind = null;
    this.mediaClosed = new Promise(resolve => { this._resolveMediaClosed = resolve; });
    this.summary = '';
    this.insights = '';
    this.videoInsights = '';
    this.synergy = '';
    this.videoAnalysis = 'unavailable';
    this.analysisPromise = null;
    this.windDown = false;
    this.ended = false;
    this.lastQuestion = '';
  }
  elapsed() { return (Date.now() - new Date(this.startedAt).getTime()) / 1000; }
  addTranscript(role, text, at = this.elapsed()) {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.transcript.push({ role, text: clean, at });
  }
  resolveMediaClosed() { this._resolveMediaClosed(); }
  waitMediaClosed(ms) {
    return Promise.race([this.mediaClosed, new Promise(r => setTimeout(r, ms))]);
  }
  noteInput() {
    const lines = [`Session ${this.id}${this.deepDive ? ' (deep dive)' : ''}`, '', '## Summary', this.summary || '(none)', '', '## Insights', this.insights || '(none)'];
    if (this.videoInsights) lines.push('', '## Video insights', this.videoInsights);
    if (this.videoAnalysis === 'done') lines.push('', '## Behavioral alignment', this.synergy || '(none)');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.use('/static', express.static(path.join(__dirname, '..', 'frontend')));

  app.get('/api/models', (req, res) => {
    const settings = config.getSettings();
    res.json({
      models: providers.availableModels(config.getKeys()),
      personas: Object.entries(prompts.PERSONAS).map(([id, p]) => ({ id, label: p.label })),
      lastModel: settings.lastModel,
      lastPersona: settings.lastPersona
    });
  });

  app.get('/api/status', (req, res) => {
    const settings = config.getSettings();
    res.json({
      workspaceDir: settings.workspaceDir,
      mediaDir: settings.mediaDir,
      silenceSeconds: settings.silenceSeconds,
      sessionMinutesSoftLimit: settings.sessionMinutesSoftLimit,
      googleAccounts: config.listGoogleAccounts().length,
      screenpipe: !!screenpipe.findDatabase(settings.screenpipeDbPath),
      fileTools: mcp.isConnected()
    });
  });

  return app;
}

async function gatherRearwardContext() {
  const settings = config.getSettings();
  let sinceIso = null;
  try { sinceIso = JSON.parse(fs.readFileSync(path.join(settings.workspaceDir, 'sync_state.json'), 'utf-8')).last_sync || null; } catch (e) { /* first run */ }
  const [g, sp] = await Promise.all([
    googleCtx.fetchRearwardContext({ sinceIso }),
    screenpipe.getScreenpipeContext(settings.screenpipeDbPath)
  ]);
  const notices = [...g.notices];
  if (sp.notice) notices.push(sp.notice);
  return { text: [g.text, sp.text].filter(Boolean).join('\n\n'), notices };
}

async function gatherForwardContext() {
  return googleCtx.fetchForwardContext();
}

// ---------------------------------------------------------------------------

function attachOrchestrator(ws) {
  let session = null;
  let pendingMime = 'audio/webm';
  let pendingFinal = false;
  let chain = Promise.resolve();

  const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const notice = (text, level = 'info') => send({ type: 'notice', text, level });
  const status = text => send({ type: 'status', text });
  const enqueue = fn => {
    chain = chain.then(fn).catch(e => {
      log('orchestrator error:', e);
      send({ type: 'error', text: e.message || String(e) });
    });
  };

  async function handleInit(data) {
    const settings = config.getSettings();
    const keys = config.getKeys();
    const modelId = data.model || settings.lastModel || 'gemini-3.6-flash';
    const persona = prompts.PERSONAS[data.persona] ? data.persona : 'socratic';
    config.setSetting('lastModel', modelId);
    config.setSetting('lastPersona', persona);
    const info = providers.modelInfo(modelId);
    if (!info) throw new Error(`Unknown model "${modelId}".`);

    session = new Session({ model: modelId, persona, deepDive: data.deep_dive, context: data.context });
    storage.ensureDirs(session.paths);
    sessions.set(session.id, session);
    send({ type: 'session', session_id: session.id, model: modelId, persona, supports_video: info.video });

    let tools = null;
    if (info.vendor !== 'gemini') {
      status('Connecting to your notes folder…');
      const ok = await mcp.ensure(settings.workspaceDir, log);
      if (ok) tools = { list: () => mcp.listTools(), call: mcp.callTool };
      else notice('File tools are unavailable for this session. The interview will continue without them.');
    }

    const dossier = storage.readDossier(session.paths);
    session.provider = providers.createProvider({
      modelId, keys, tools, log,
      systemPrompt: prompts.systemPrompt({ persona, dossier, hasVault: !!tools })
    });

    status('Thinking of a first question…');
    const opening = await session.provider.respond(prompts.openingPrompt({ deepDive: session.deepDive, context: session.deepDiveContext, hasDossier: !!dossier }));
    const parsed = providers.extractJson(opening);
    const question = (parsed && parsed.question) || opening || "What's on your mind today?";
    session.lastQuestion = question;
    session.addTranscript('ai', question);
    send({ type: 'question', text: question, transcript: '' });
  }

  async function handleAudio(buffer, mime, final) {
    if (!session || !session.provider) return;
    if (buffer.length < 1500) {
      if (!final) send({ type: 'listen', text: "I didn't catch any speech. Go ahead whenever you're ready." });
      return;
    }
    const at = session.elapsed();
    if (final) {
      // The user concluded mid-answer: transcribe what they said so it lands in the note.
      try {
        const text = await session.provider.transcribe(buffer, mime);
        if (text) session.addTranscript('user', text, at);
      } catch (e) {
        notice(`The last thing you said could not be transcribed: ${e.message}`, 'error');
      }
      return;
    }

    const note = session.windDown ? prompts.WIND_DOWN_NOTE : '';
    const { parsed, raw, transcript } = await session.provider.respondToAudio(buffer, mime, note);
    if (transcript) session.addTranscript('user', transcript, at);

    let question = null;
    if (parsed && parsed.tool === 'fetch_rearward_context') {
      status('Pulling up your recent context…');
      const ctx = await gatherRearwardContext();
      ctx.notices.forEach(n => notice(n));
      const follow = await session.provider.respond(prompts.contextFollowupPrompt('rearward', ctx.text || '(No context sources are connected.)') + note);
      const fp = providers.extractJson(follow);
      question = (fp && fp.question) || follow;
    } else if (parsed && parsed.tool === 'fetch_forward_context') {
      status('Pulling up your calendar…');
      const ctx = await gatherForwardContext();
      ctx.notices.forEach(n => notice(n));
      const follow = await session.provider.respond(prompts.contextFollowupPrompt('forward', ctx.text || '(No calendar sources are connected.)') + note);
      const fp = providers.extractJson(follow);
      question = (fp && fp.question) || follow;
    } else if (parsed && parsed.question) {
      question = parsed.question;
    } else {
      question = raw || 'Could you say a little more about that?';
    }
    session.lastQuestion = question;
    session.addTranscript('ai', question);
    send({ type: 'question', text: question, transcript: transcript || '' });
  }

  async function handleEnd() {
    if (!session || session.ended) return;
    session.ended = true;
    session.endedAt = new Date().toISOString();
    await session.waitMediaClosed(5000);

    status('Summarizing the conversation…');
    if (session.provider && session.transcript.some(t => t.role === 'user')) {
      try {
        const out = await session.provider.respond(prompts.textSummaryPrompt());
        const p = providers.extractJson(out);
        session.summary = (p && p.summary) || out;
        session.insights = (p && p.insights) || '';
      } catch (e) {
        session.summary = `The summary could not be generated (${e.message}). The transcript below was saved.`;
        notice(`Summary failed: ${e.message}`, 'error');
      }
    } else {
      session.summary = 'No answers were recorded in this session.';
    }

    let mediaSize = 0;
    try { mediaSize = session.mediaPath ? fs.statSync(session.mediaPath).size : 0; } catch (e) { mediaSize = 0; }
    const canAnalyze = session.provider && session.provider.supportsVideo && session.mediaKind === 'video' && mediaSize > 20000;
    session.videoAnalysis = canAnalyze ? 'pending' : 'unavailable';

    send({
      type: 'review',
      summary: session.summary,
      insights: session.insights,
      video_status: session.videoAnalysis,
      transcript: session.transcript,
      recording: session.mediaPath
    });

    if (canAnalyze) {
      session.analysisPromise = (async () => {
        try {
          const out = await session.provider.analyzeVideo(session.mediaPath, prompts.videoAnalysisPrompt());
          const p = providers.extractJson(out);
          session.videoInsights = (p && p.insights) || '';
          session.synergy = (p && p.synergy_diff) || out;
          session.videoAnalysis = 'done';
          send({ type: 'analysis', insights: session.videoInsights, synergy: session.synergy });
        } catch (e) {
          session.videoAnalysis = 'failed';
          send({ type: 'analysis', error: e.message });
          notice(`Video analysis failed: ${e.message}. The recording is archived and can be analyzed later.`, 'error');
        }
      })();
    }
  }

  async function handleSave() {
    if (!session) return;
    if (!session.ended) await handleEnd();
    if (session.analysisPromise) {
      status('Finishing the video analysis…');
      await session.analysisPromise;
    }
    const combinedInsights = [session.insights, session.videoInsights ? `\n**From the video**\n${session.videoInsights}` : ''].filter(Boolean).join('\n');
    const notePath = storage.writeSessionNote({
      sessionId: session.id, startedAt: session.startedAt, endedAt: session.endedAt,
      model: session.model, persona: session.persona, deepDive: session.deepDive,
      summary: session.summary, insights: combinedInsights, synergy: session.synergy,
      transcript: session.transcript, mediaPath: session.mediaPath, mediaKind: session.mediaKind,
      videoAnalysis: session.videoAnalysis, paths: session.paths
    });

    let dossierUpdated = false;
    status('Updating your Master Dossier…');
    try {
      const existing = storage.readDossier(session.paths);
      const updated = await session.provider.oneShot(prompts.dossierUpdatePrompt(existing, session.noteInput()));
      if (!updated || updated.trim().length < 40) throw new Error('the model returned an empty dossier');
      storage.backupDossier(session.paths, session.id);
      storage.writeDossier(session.paths, updated.trim() + '\n');
      dossierUpdated = true;
    } catch (e) {
      notice(`The session note was saved, but the Master Dossier could not be updated (${e.message}).`, 'error');
    }
    try { fs.writeFileSync(path.join(session.paths.workspace, 'sync_state.json'), JSON.stringify({ last_sync: new Date().toISOString() })); } catch (e) { /* ignore */ }

    send({ type: 'saved', note_path: notePath, dossier_updated: dossierUpdated, synergy: session.synergy, video_status: session.videoAnalysis });
    sessions.delete(session.id);
    session = null;
  }

  async function handleDiscard() {
    if (!session) return;
    const removed = storage.deleteSessionMedia(session);
    sessions.delete(session.id);
    session = null;
    send({ type: 'discarded', removed });
  }

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      const mime = pendingMime;
      const final = pendingFinal;
      pendingFinal = false;
      enqueue(() => handleAudio(message, mime, final));
      return;
    }
    let data;
    try { data = JSON.parse(message.toString()); } catch (e) { return; }
    switch (data.type) {
      case 'init': enqueue(() => handleInit(data)); break;
      case 'audio_meta': pendingMime = data.mime || 'audio/webm'; pendingFinal = !!data.final; break;
      case 'time_check': if (session) session.windDown = true; break;
      case 'end_session': enqueue(handleEnd); break;
      case 'save_session': enqueue(handleSave); break;
      case 'discard_session': enqueue(handleDiscard); break;
      case 'log_error': log('frontend error:', data.text); break;
      default: break;
    }
  });

  ws.on('close', () => {
    // A session that was never concluded (window closed mid-interview) keeps its
    // recording on disk; nothing else is written, so nothing is corrupted.
    if (session && !session.ended) log(`session ${session.id} closed without concluding; recording kept at ${session.mediaPath || 'none'}`);
  });
}

function attachArchive(ws, req) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const session = sessions.get(url.searchParams.get('session'));
  const kind = url.searchParams.get('kind') === 'audio' ? 'audio' : 'video';
  if (!session) { ws.close(1008, 'unknown session'); return; }
  const target = kind === 'video' ? session.paths.videoPath : session.paths.audioPath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stream = fs.createWriteStream(target);
  session.mediaPath = target;
  session.mediaKind = kind;
  ws.on('message', (message, isBinary) => { if (isBinary) stream.write(message); });
  ws.on('close', () => stream.end(() => session.resolveMediaClosed()));
  ws.on('error', e => log('archive socket error:', e.message));
}

// ---------------------------------------------------------------------------

function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  const wssOrchestrator = new WebSocketServer({ noServer: true });
  const wssArchive = new WebSocketServer({ noServer: true });
  wssOrchestrator.on('connection', attachOrchestrator);
  wssArchive.on('connection', attachArchive);

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/ws/orchestrator') {
      wssOrchestrator.handleUpgrade(request, socket, head, ws => wssOrchestrator.emit('connection', ws, request));
    } else if (pathname === '/ws/archive') {
      wssArchive.handleUpgrade(request, socket, head, ws => wssArchive.emit('connection', ws, request));
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log(`listening on http://127.0.0.1:${port}`);
      resolve({ port, server });
    });
  });
}

module.exports = { startServer, createApp, Session, sessions };

if (require.main === module) {
  startServer().then(({ port }) => console.log(`Open http://127.0.0.1:${port}/static/index.html`));
}
