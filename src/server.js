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
const inbox = require('./inbox');

const log = (...args) => console.log('[madrone]', ...args);
const sessions = new Map();

// ---------------------------------------------------------------------------

function sessionExistsOnDisk(settings, id, now) {
  const p = storage.sessionPaths(settings, id, now);
  return fs.existsSync(p.notePath) || fs.existsSync(p.videoPath) || fs.existsSync(p.audioPath);
}

class Session {
  constructor({ model, persona, deepDive, context, contextId, mode }) {
    const now = new Date();
    // Two sessions started in the same minute would share an id; add a suffix
    // until neither the live session list nor the disk knows the id.
    const settings = config.contextSettings(contextId);
    this.ctxSettings = settings;
    this.context = settings.context;
    this.mode = mode === 'inbox' ? 'inbox' : 'interview';
    this.inboxItems = [];
    this.decisions = [];
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
    this.entities = { people: [], projects: [], topics: [] };   // names as resolved against the vault
    this.rawEntities = { people: [], projects: [], topics: [] }; // as the model returned them
    this.scores = {};
    this.known = { people: [], projects: [], topics: [] };
    this.injected = new Set();
  }

  // Entity notes the user just mentioned and the interviewer has not yet been shown.
  vaultContextFor(text) {
    const lower = String(text || '').toLowerCase();
    const items = [];
    let budget = 3000;
    for (const kind of ['people', 'projects', 'topics']) {
      for (const name of this.known[kind]) {
        if (name.length < 4 || this.injected.has(kind + ':' + name) || !lower.includes(name.toLowerCase())) continue;
        const summary = storage.readEntitySummary(this.paths, kind, name, Math.min(1200, budget));
        this.injected.add(kind + ':' + name);
        if (!summary) continue;
        items.push({ kind: kind === 'people' ? 'person' : kind.slice(0, -1), name, text: summary });
        budget -= summary.length;
        if (budget <= 0) return items;
      }
    }
    return items;
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
    const links = ['people', 'projects', 'topics'].filter(k => this.entities[k].length).map(k => `${k}: ${this.entities[k].map(n => `[[${n}]]`).join(', ')}`);
    if (links.length) lines.push('', '## Linked notes', ...links);
    if (this.decisions.length) lines.push('', '## Inbox decisions', inbox.triageSummaryMarkdown(this.decisions));
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

  app.get('/api/inbox', (req, res) => {
    const settings = config.getSettings();
    const items = inbox.scan(settings.inboxes, config.getInboxProcessed());
    res.json({ configured: settings.inboxes.length > 0, items: items.map(it => ({ id: it.id, name: it.name, kind: it.kind, capturedAt: it.capturedAt, inbox: it.inboxName, placeholder: it.placeholder })) });
  });

  app.get('/api/status', (req, res) => {
    const settings = config.getSettings();
    let inboxNew = 0;
    try { inboxNew = inbox.scan(settings.inboxes, config.getInboxProcessed()).length; } catch (e) { inboxNew = 0; }
    res.json({
      workspaceDir: settings.workspaceDir,
      mediaDir: settings.mediaDir,
      contexts: settings.contexts.map(c => ({ id: c.id, name: c.name, notesDir: c.notesDir })),
      activeContextId: settings.activeContextId,
      inboxConfigured: settings.inboxes.length > 0,
      inboxNew,
      silenceSeconds: settings.silenceSeconds,
      sessionMinutesSoftLimit: settings.sessionMinutesSoftLimit,
      googleAccounts: config.listGoogleAccounts().length,
      googleConfigured: googleCtx.hasClientConfig(),
      suggestGoogle: googleCtx.hasClientConfig() && config.listGoogleAccounts().length === 0 && !config.getStore().get('googleSuggestionDismissed'),
      screenpipe: !!screenpipe.findDatabase(settings.screenpipeDbPath),
      fileTools: mcp.isConnected()
    });
  });

  return app;
}

async function gatherRearwardContext(ctxSettings) {
  const settings = ctxSettings || config.getSettings();
  let sinceIso = null;
  try { sinceIso = JSON.parse(fs.readFileSync(storage.layoutPaths(settings).syncStatePath, 'utf-8')).last_sync || null; } catch (e) { /* first run */ }
  const [g, sp] = await Promise.all([
    googleCtx.fetchRearwardContext({ sinceIso, accounts: settings.googleAccounts }),
    screenpipe.getScreenpipeContext(settings.screenpipeDbPath)
  ]);
  const notices = [...g.notices];
  if (sp.notice) notices.push(sp.notice);
  return { text: [g.text, sp.text].filter(Boolean).join('\n\n'), notices };
}

async function gatherForwardContext(ctxSettings) {
  const settings = ctxSettings || config.getSettings();
  return googleCtx.fetchForwardContext({ accounts: settings.googleAccounts });
}

// ---------------------------------------------------------------------------

function attachOrchestrator(ws) {
  let session = null;
  let pendingMime = 'audio/webm';
  let pendingFinal = false;
  let chain = Promise.resolve();

  const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const notice = (text, level = 'info', action = null) => send({ type: 'notice', text, level, action });
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

    const contextId = data.context_id || settings.activeContextId;
    config.setActiveContext(contextId);
    const mode = data.mode === 'inbox' ? 'inbox' : 'interview';
    session = new Session({ model: modelId, persona, deepDive: data.deep_dive, context: data.context, contextId, mode });
    try { storage.migrateLayout(session.ctxSettings); } catch (e) { log('layout migration skipped:', e.message); }
    storage.ensureDirs(session.paths);
    session.known = storage.listEntities(session.paths);
    sessions.set(session.id, session);

    let items = [];
    if (mode === 'inbox') {
      items = inbox.scan(settings.inboxes, config.getInboxProcessed());
      if (items.length === 0) throw new Error(settings.inboxes.length ? 'Your inbox has no new items to review.' : 'No inbox folder is set. Add one in Settings under Inbox folders.');
    }
    send({ type: 'session', session_id: session.id, model: modelId, persona, supports_video: info.video, mode, context: session.context.name, inbox_total: items.length });

    let tools = null;
    if (info.vendor !== 'gemini') {
      status('Connecting to your notes folder…');
      const ok = await mcp.ensure(session.ctxSettings.workspaceDir, log);
      if (ok) tools = { list: () => mcp.listTools(), call: mcp.callTool };
      else notice('File tools are unavailable for this session. The interview will continue without them.');
    }

    const dossier = storage.readDossier(session.paths);
    session.provider = providers.createProvider({
      modelId, keys, tools, log,
      systemPrompt: prompts.systemPrompt({ persona, dossier, hasVault: !!tools, known: session.known })
    });

    if (mode === 'inbox') {
      const placeholders = items.filter(it => it.placeholder);
      if (placeholders.length) {
        status(`Downloading ${placeholders.length} item${placeholders.length === 1 ? '' : 's'} from iCloud…`);
        for (const it of placeholders) {
          if (!(await inbox.ensureDownloaded(it, { timeoutMs: Number(process.env.MADRONE_ICLOUD_WAIT_MS || 30000) }))) notice(`"${it.name}" has not finished downloading from iCloud; it will be skipped this time.`);
        }
        items = items.filter(it => !it.placeholder);
      }
      const audioItems = items.filter(it => it.kind === 'audio');
      let n = 0;
      for (const it of items) {
        try {
          if (it.kind === 'audio') {
            n++;
            status(`Transcribing voice memo ${n} of ${audioItems.length}…`);
            const { buffer, mime } = await inbox.readAudio(it);
            it.text = await session.provider.transcribe(buffer, mime);
          } else {
            it.text = inbox.readText(it);
          }
        } catch (e) {
          it.text = '';
          notice(`Could not read "${it.name}": ${e.message}`, 'error');
        }
      }
      items = items.filter(it => it.text && it.text.trim());
      if (items.length === 0) throw new Error('None of the inbox items could be read or transcribed.');
      session.inboxItems = items.map(it => ({ ...it, status: 'pending' }));
      session.provider.systemPrompt = prompts.inboxSystemPrompt({ contexts: settings.contexts, items: session.inboxItems, known: session.known });
      send({ type: 'inbox_ready', total: session.inboxItems.length, items: session.inboxItems.map(it => ({ id: it.id, name: it.name, kind: it.kind })) });
    }

    status(mode === 'inbox' ? 'Reading the first item…' : 'Thinking of a first question…');
    const opening = await session.provider.respond(mode === 'inbox'
      ? prompts.inboxOpeningPrompt()
      : prompts.openingPrompt({ deepDive: session.deepDive, context: session.deepDiveContext, hasDossier: !!dossier }));
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

    // Notes for entities mentioned in earlier turns ride along on this one; the
    // current turn's transcript is only known after the model has heard it.
    const pending = session.pendingContext || [];
    session.pendingContext = [];
    const note = (session.windDown ? prompts.WIND_DOWN_NOTE : '') + prompts.vaultContextNote(pending);
    const { parsed, raw, transcript } = await session.provider.respondToAudio(buffer, mime, note);
    if (transcript) {
      session.addTranscript('user', transcript, at);
      session.pendingContext = session.vaultContextFor(transcript);
    }

    let question = null;
    if (parsed && parsed.tool === 'fetch_rearward_context') {
      status('Pulling up your recent context…');
      const ctx = await gatherRearwardContext(session.ctxSettings);
      ctx.notices.forEach(n => notice(n, 'info', n.startsWith('No Google account') ? 'connect_google' : (n.startsWith('Screenpipe') ? 'screenpipe' : null)));
      const follow = await session.provider.respond(prompts.contextFollowupPrompt('rearward', ctx.text || '(No context sources are connected.)') + note);
      const fp = providers.extractJson(follow);
      question = (fp && fp.question) || follow;
    } else if (parsed && parsed.tool === 'fetch_forward_context') {
      status('Pulling up your calendar…');
      const ctx = await gatherForwardContext(session.ctxSettings);
      ctx.notices.forEach(n => notice(n, 'info', n.startsWith('No Google account') ? 'connect_google' : null));
      const follow = await session.provider.respond(prompts.contextFollowupPrompt('forward', ctx.text || '(No calendar sources are connected.)') + note);
      const fp = providers.extractJson(follow);
      question = (fp && fp.question) || follow;
    } else if (parsed && parsed.question) {
      question = parsed.question;
    } else {
      question = raw || 'Could you say a little more about that?';
    }
    if (parsed && Array.isArray(parsed.triage) && session.mode === 'inbox') {
      await applyTriage(parsed.triage);
    }
    session.lastQuestion = question;
    session.addTranscript('ai', question);
    send({ type: 'question', text: question, transcript: transcript || '' });
    if (parsed && parsed.done && session.mode === 'inbox') send({ type: 'inbox_done', remaining: session.inboxItems.filter(it => it.status === 'pending').length });
  }

  function resolveContext(name) {
    const contexts = config.listContexts();
    const wanted = String(name || '').trim().toLowerCase();
    return contexts.find(c => c.name.toLowerCase() === wanted)
      || contexts.find(c => wanted && (c.name.toLowerCase().includes(wanted) || wanted.includes(c.name.toLowerCase())))
      || session.context;
  }

  // Writes each decision into its context and retires the inbox item.
  async function applyTriage(decisions) {
    const settings = config.getSettings();
    for (const d of decisions) {
      if (!d || typeof d !== 'object') continue;
      const item = session.inboxItems.find(it => it.id === String(d.item || '').trim() && it.status === 'pending');
      if (!item) continue;
      const kind = ['todo', 'thought', 'discard'].includes(d.kind) ? d.kind : 'thought';
      const ctx = resolveContext(d.context);
      const ctxSettings = config.contextSettings(ctx.id);
      const title = String(d.title || item.text.slice(0, 60)).trim();
      const text = String(d.text || item.text).trim();
      const due = typeof d.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.due) ? d.due : null;
      const linked = [];
      try {
        if (kind !== 'discard') {
          const p = storage.layoutPaths(ctxSettings);
          storage.ensureDirs({ ...p, mediaDir: null });
          for (const [key, k] of [['people', 'people'], ['projects', 'projects'], ['topics', 'topics']]) {
            for (const name of Array.isArray(d[key]) ? d[key] : []) {
              const resolved = storage.upsertEntityNote(p, k, { name, note: title }, session.id);
              if (resolved) linked.push(resolved);
            }
          }
          if (kind === 'todo') inbox.appendActionItem(ctxSettings, { title, due, capturedAt: item.capturedAt, sessionId: session.id, note: text !== title ? text : '' });
          else inbox.appendThought(ctxSettings, { title, text, capturedAt: item.capturedAt, sessionId: session.id, links: linked });
        }
        const movedTo = inbox.moveProcessed(item, { move: settings.inboxMoveProcessed });
        config.markInboxProcessed(item.path, { decision: kind, context: ctx.name, movedTo, session: session.id });
        item.status = 'done';
        const decision = { itemId: item.id, itemName: item.name, capturedAt: item.capturedAt, kind, contextName: ctx.name, title, due };
        session.decisions.push(decision);
        session.addTranscript('ai', kind === 'discard' ? `[Discarded "${item.name}"]` : `[Filed "${title}" as ${kind === 'todo' ? 'a to-do' : 'a thought'} in ${ctx.name}${due ? `, due ${due}` : ''}]`);
        send({ type: 'triage', item: { id: item.id, name: item.name }, kind, context: ctx.name, title, due, remaining: session.inboxItems.filter(it => it.status === 'pending').length });
      } catch (e) {
        notice(`Could not file "${title}": ${e.message}`, 'error');
      }
    }
  }

  async function handleEnd() {
    if (!session || session.ended) return;
    session.ended = true;
    session.endedAt = new Date().toISOString();
    await session.waitMediaClosed(5000);

    status('Summarizing the conversation…');
    if (session.provider && session.transcript.some(t => t.role === 'user')) {
      try {
        const out = await session.provider.respond(prompts.textSummaryPrompt(session.known));
        const p = providers.extractJson(out);
        session.summary = (p && p.summary) || out;
        session.insights = (p && p.insights) || '';
        for (const kind of ['people', 'projects', 'topics']) {
          session.rawEntities[kind] = Array.isArray(p && p[kind]) ? p[kind].filter(e => e && typeof e.name === 'string' && e.name.trim()).slice(0, 12) : [];
        }
        session.scores.energy = p && ['high', 'neutral', 'depleted'].includes(p.energy) ? p.energy : null;
        const conf = p && Number(p.confidence);
        session.scores.confidence = Number.isFinite(conf) ? Math.max(1, Math.min(10, Math.round(conf))) : null;
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
          session.scores.incongruence = p && typeof p.incongruence === 'boolean' ? p.incongruence : /detected incongruence:\s*(?!none)/i.test(session.synergy);
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
    // Entity notes first, so the session note links to the names the vault actually uses.
    for (const kind of ['people', 'projects', 'topics']) {
      const names = [];
      for (const entity of session.rawEntities[kind]) {
        try {
          const name = storage.upsertEntityNote(session.paths, kind, entity, session.id);
          if (name && !names.includes(name)) names.push(name);
        } catch (e) { log(`entity note failed for ${entity.name}:`, e.message); }
      }
      session.entities[kind] = names;
    }
    let baseCreated = false;
    try { baseCreated = storage.ensureBaseFile(session.paths); } catch (e) { log('base file failed:', e.message); }

    const combinedInsights = [session.insights, session.videoInsights ? `\n**From the video**\n${session.videoInsights}` : ''].filter(Boolean).join('\n');
    const notePath = storage.writeSessionNote({
      sessionId: session.id, startedAt: session.startedAt, endedAt: session.endedAt,
      model: session.model, persona: session.persona, deepDive: session.deepDive,
      summary: session.summary, insights: combinedInsights, synergy: session.synergy,
      transcript: session.transcript, mediaPath: session.mediaPath, mediaKind: session.mediaKind,
      videoAnalysis: session.videoAnalysis, paths: session.paths,
      entities: session.entities, scores: session.scores,
      sessionType: session.mode === 'inbox' ? 'inbox-review' : null,
      extraSections: session.mode === 'inbox' ? [{ title: 'Inbox decisions', markdown: inbox.triageSummaryMarkdown(session.decisions) }] : []
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
    try { fs.writeFileSync(session.paths.syncStatePath, JSON.stringify({ last_sync: new Date().toISOString() })); } catch (e) { /* ignore */ }

    const inVault = !!storage.findVaultRoot(session.paths.workspace);
    send({
      type: 'saved', note_path: notePath, dossier_updated: dossierUpdated, synergy: session.synergy, video_status: session.videoAnalysis,
      entities: session.entities, base_created: baseCreated, decisions: session.decisions.length, context: session.context.name,
      obsidian_url: inVault ? storage.obsidianUrl(notePath) : null
    });
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
