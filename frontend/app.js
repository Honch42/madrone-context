'use strict';
// Interview screen. States: idle -> starting -> listening <-> thinking (paused)
// -> ending -> review -> done.

const $ = id => document.getElementById(id);
const questionDisplay = $('question-display');
const transcriptDisplay = $('transcript-display');
const statusIndicator = $('status-indicator');
const statusText = $('status-text');
const statusDot = statusIndicator.querySelector('.dot');
const timerEl = $('timer');
const modelSelect = $('model-select');
const personaSelect = $('persona-select');
const contextSelect = $('context-select');
const hiddenVideo = $('hidden-video');

const ui = {
  state: 'idle',
  frozen: false,
  session: null,
  orchestratorWs: null,
  archiveWs: null,
  stream: null,
  hasVideo: false,
  backgroundRecorder: null,
  turnRecorder: null,
  turnChunks: [],
  turnStartedAt: 0,
  turnSpeechDetected: false,
  lastSpeechAt: 0,
  noiseFloor: 4,
  audioContext: null,
  analyser: null,
  dataArray: null,
  visualizerFrame: null,
  timerInterval: null,
  sessionStartedAt: 0,
  silenceMs: 1800,
  softLimitMinutes: 15,
  softLimitNotified: false,
  review: null,
  lastNotePath: null
};

window.onerror = message => {
  if (ui.orchestratorWs && ui.orchestratorWs.readyState === WebSocket.OPEN) {
    ui.orchestratorWs.send(JSON.stringify({ type: 'log_error', text: String(message) }));
  }
};

// ---------------------------------------------------------------------------
// Small UI helpers

function setStatus(text, mode) {
  statusText.innerText = text;
  statusIndicator.className = 'status-listening' + (mode ? ' ' + mode : '');
  if (mode === 'thinking' || mode === 'paused' || mode === 'idle') {
    statusDot.style.transform = 'scale(1)';
    statusDot.style.boxShadow = '';
  }
}

function setQuestion(text, thinking = false) {
  questionDisplay.classList.toggle('thinking', thinking);
  questionDisplay.innerText = text;
  questionDisplay.style.animation = 'none';
  void questionDisplay.offsetWidth;
  questionDisplay.style.animation = '';
}

function showOverlay(id) {
  for (const s of ['start-screen', 'error-screen', 'review-screen', 'done-screen']) $(s).hidden = s !== id;
}

const NOTICE_ACTIONS = {
  connect_google: { label: 'Connect Google', focus: 'google' },
  screenpipe: { label: 'Set up Screenpipe', focus: 'screenpipe' }
};

function notify(text, level = 'info', ms = 9000, action = null) {
  const el = document.createElement('div');
  el.className = 'notice' + (level === 'error' ? ' error' : '');
  const span = document.createElement('span');
  span.innerText = text;
  el.appendChild(span);
  const act = action && NOTICE_ACTIONS[action];
  if (act && window.electronAPI) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-quiet'; btn.innerText = act.label;
    btn.onclick = () => openSettingsFor(act.focus);
    el.appendChild(btn);
    ms = Math.max(ms, 20000);
  }
  $('notices').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function openSettingsFor(focus) {
  if (!window.electronAPI) return;
  if (['listening', 'thinking', 'starting', 'ending'].includes(ui.state) && !confirm('Leave this session to open Settings? The recording so far is kept, but the conversation will not be summarized or saved.')) return;
  cleanupConnections();
  window.electronAPI.openSettings(focus);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function lockSelectors(locked) {
  modelSelect.disabled = locked;
  personaSelect.disabled = locked;
  contextSelect.disabled = locked;
}

// ---------------------------------------------------------------------------
// Setup: models, personas, settings

async function loadCatalog() {
  try {
    const [models, status] = await Promise.all([
      fetch('/api/models').then(r => r.json()),
      fetch('/api/status').then(r => r.json())
    ]);
    ui.catalog = models.models;
    ui.status = status;
    modelSelect.innerHTML = '';
    for (const m of models.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.available ? m.label : `${m.label} (needs a ${m.missing.join(' + ')} key)`;
      opt.disabled = !m.available && !window.electronAPI;
      opt.title = m.note;
      modelSelect.appendChild(opt);
    }
    const preferred = models.lastModel && models.models.find(m => m.id === models.lastModel && m.available);
    const firstAvailable = models.models.find(m => m.available);
    modelSelect.value = preferred ? preferred.id : (firstAvailable ? firstAvailable.id : (models.models[0] ? models.models[0].id : ''));
    personaSelect.innerHTML = '';
    for (const p of models.personas) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.label;
      personaSelect.appendChild(opt);
    }
    if (models.lastPersona) personaSelect.value = models.lastPersona;

    contextSelect.innerHTML = '';
    for (const c of status.contexts || []) {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name; opt.title = c.notesDir;
      contextSelect.appendChild(opt);
    }
    if (status.activeContextId) contextSelect.value = status.activeContextId;

    const inboxBtn = $('btn-inbox');
    if (!status.inboxConfigured) {
      inboxBtn.innerText = 'Review inbox';
      inboxBtn.disabled = true;
      $('inbox-hint').innerText = 'To review voice memos and notes captured on your phone, add an inbox folder in Settings.';
    } else if (status.inboxNew === 0) {
      inboxBtn.innerText = 'Review inbox';
      inboxBtn.disabled = true;
      $('inbox-hint').innerText = 'Your inbox has no new items.';
    } else {
      inboxBtn.innerText = `Review inbox (${status.inboxNew} new)`;
      inboxBtn.disabled = false;
      $('inbox-hint').innerText = `${status.inboxNew} captured ${status.inboxNew === 1 ? 'item' : 'items'} waiting to be sorted into your contexts.`;
    }

    ui.silenceMs = Math.max(600, Number(status.silenceSeconds || 1.8) * 1000);
    ui.softLimitMinutes = Number(status.sessionMinutesSoftLimit || 15);
    $('start-hint').innerText = `Notes are saved to ${status.workspaceDir}.`;
    await refreshMediaStatus();
    updateModelReadiness();
  } catch (e) {
    $('start-hint').innerText = 'Could not reach the local server. Try restarting the app.';
    $('btn-start').disabled = true;
  }
}

// Which key, if any, the chosen model still needs. Offers keys already on this
// Mac before asking the user to paste one.
async function updateModelReadiness() {
  const m = (ui.catalog || []).find(x => x.id === modelSelect.value);
  const panel = $('key-panel');
  if (!m || m.available) {
    panel.hidden = true;
    $('btn-start').disabled = !m;
    return;
  }
  $('btn-start').disabled = true;
  const vendor = m.missing.includes('Gemini') ? 'gemini' : m.vendor;
  panel.dataset.vendor = vendor;
  const vendorName = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' }[vendor];
  $('key-panel-text').innerText = vendor === 'gemini'
    ? 'Every model needs a Gemini key: it transcribes your speech. Free from Google AI Studio.'
    : `${m.label} needs an ${vendorName} API key. It receives the transcript of what you say, not the audio.`;
  $('key-panel-input').placeholder = `Paste your ${vendorName} API key`;
  $('key-panel-msg').innerText = '';
  $('key-panel-found').innerHTML = '';
  panel.hidden = false;
  if (!window.electronAPI) return;
  $('key-panel-op').hidden = !(ui.status && ui.status.onePasswordInstalled);
  try {
    const found = await window.electronAPI.detectKeys();
    if (panel.dataset.vendor !== vendor) return;
    for (const c of found[vendor] || []) addKeyCandidate(vendor, c);
    if (vendor === 'anthropic' && found.anthropicProfile && found.anthropicProfile.found) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.innerText = `Found an Anthropic CLI sign-in (profile "${found.anthropicProfile.profile}")`;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-primary'; btn.innerText = 'Use my sign-in';
      btn.onclick = async () => { try { await window.electronAPI.useAnthropicProfile(); await loadCatalog(); } catch (e) { $('key-panel-msg').innerText = cleanError(e); } };
      li.append(left, btn);
      $('key-panel-found').appendChild(li);
    }
  } catch (e) { /* detection is best-effort */ }
}

function addKeyCandidate(vendor, c) {
  const vendorName = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' }[vendor];
  const li = document.createElement('li');
  const left = document.createElement('div');
  left.innerHTML = `Found a ${vendorName} key <code></code><span class="src"></span>`;
  left.querySelector('code').innerText = c.masked;
  left.querySelector('.src').innerText = c.source;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-primary'; btn.innerText = 'Use this key';
  btn.onclick = async () => { try { await window.electronAPI.useDetectedKey(c.id); await loadCatalog(); } catch (e) { $('key-panel-msg').innerText = cleanError(e); } };
  li.append(left, btn);
  $('key-panel-found').prepend(li);
}

async function keyPanelFromOnePassword() {
  const vendor = $('key-panel').dataset.vendor;
  const vendorName = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' }[vendor];
  const msg = $('key-panel-msg');
  msg.innerText = 'Asking 1Password… approve the prompt if it appears.';
  try {
    const items = await window.electronAPI.onePasswordList(vendor);
    $('key-panel-found').innerHTML = '';
    msg.innerText = items.length ? 'Choose the item that holds the key:' : `No likely ${vendorName} items found. Name the item after the vendor, or paste an op:// reference above.`;
    for (const it of items) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.innerHTML = `<span></span><span class="src"></span>`;
      left.querySelector('span').innerText = it.title;
      left.querySelector('.src').innerText = `1Password · ${it.vault}${it.category ? ' · ' + it.category : ''}`;
      const use = document.createElement('button');
      use.type = 'button'; use.className = 'btn btn-primary'; use.innerText = 'Use this item';
      use.onclick = async () => {
        use.disabled = true; msg.innerText = 'Reading from 1Password…';
        try { await window.electronAPI.onePasswordImport(vendor, it.id); await loadCatalog(); }
        catch (e) { use.disabled = false; msg.innerText = cleanError(e); }
      };
      li.append(left, use);
      $('key-panel-found').appendChild(li);
    }
  } catch (e) { msg.innerText = cleanError(e); }
}

const KEY_URLS = {
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys'
};

function cleanError(e) { return String(e && e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''); }

async function refreshMediaStatus() {
  const row = $('camera-row');
  if (!window.electronAPI) { row.hidden = true; ui.cameraStatus = 'unknown'; return; }
  try {
    const st = await window.electronAPI.getStatus();
    ui.cameraStatus = st.media.camera;
    ui.micStatus = st.media.microphone;
    if (ui.status) ui.status.onePasswordInstalled = !!(st.onePassword && st.onePassword.installed);
  } catch (e) { ui.cameraStatus = 'unknown'; }
  row.hidden = ui.cameraStatus === 'denied' || ui.cameraStatus === 'restricted';
  let remembered = null;
  try { remembered = localStorage.getItem('recordVideo'); } catch (e) { /* storage unavailable */ }
  $('camera-toggle').checked = remembered === null ? ui.cameraStatus === 'granted' : remembered === 'yes';
  $('camera-label').innerText = ui.cameraStatus === 'granted'
    ? 'Also record video, so Gemini can compare what you say with how you look and sound. Never shown on screen.'
    : 'Also record video, so Gemini can compare what you say with how you look and sound. macOS will ask for camera access when you begin. Never shown on screen.';
}

// ---------------------------------------------------------------------------
// Media

async function setupMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const wantVideo = $('camera-row').hidden ? false : $('camera-toggle').checked;
  try { localStorage.setItem('recordVideo', wantVideo ? 'yes' : 'no'); } catch (e) { /* ignore */ }
  if (wantVideo && window.electronAPI && ui.cameraStatus === 'not-determined') {
    // Ask macOS now, while the explanation is still on screen, rather than mid-session.
    try { const st = await window.electronAPI.requestCamera(); ui.cameraStatus = st.camera; } catch (e) { /* fall through */ }
  }
  ui.hasVideo = false;
  if (wantVideo) {
    try {
      ui.stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' }
      });
      ui.hasVideo = ui.stream.getVideoTracks().length > 0;
    } catch (e) {
      notify('The camera is not available, so this session records audio only.');
    }
  }
  if (!ui.stream) ui.stream = await navigator.mediaDevices.getUserMedia({ audio });
  hiddenVideo.srcObject = ui.stream;
  setupVisualizer();
}

function releaseMedia() {
  stopVisualizer();
  if (ui.stream) {
    for (const track of ui.stream.getTracks()) { try { track.stop(); } catch (e) { /* ignore */ } }
  }
  ui.stream = null;
  hiddenVideo.srcObject = null;
  if (ui.audioContext) { try { ui.audioContext.close(); } catch (e) { /* ignore */ } ui.audioContext = null; }
}

function pickMime(candidates) {
  for (const m of candidates) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
  return '';
}

function startBackgroundRecording() {
  if (!ui.stream || !ui.session) return;
  const kind = ui.hasVideo ? 'video' : 'audio';
  const wsBase = `ws://${window.location.host}`;
  ui.archiveWs = new WebSocket(`${wsBase}/ws/archive?session=${encodeURIComponent(ui.session.session_id)}&kind=${kind}`);
  ui.archiveWs.binaryType = 'arraybuffer';
  const options = { audioBitsPerSecond: 64000 };
  if (ui.hasVideo) {
    options.videoBitsPerSecond = 800000; // roughly 90 MB per 15 minutes at 720p
    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    if (mime) options.mimeType = mime;
  } else {
    const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm']);
    if (mime) options.mimeType = mime;
  }
  ui.archiveWs.onopen = () => {
    try {
      ui.backgroundRecorder = new MediaRecorder(ui.stream, options);
      ui.backgroundRecorder.ondataavailable = e => {
        if (e.data.size > 0 && ui.archiveWs && ui.archiveWs.readyState === WebSocket.OPEN) ui.archiveWs.send(e.data);
      };
      ui.backgroundRecorder.start(3000);
    } catch (e) {
      notify('Background recording could not start: ' + e.message, 'error');
    }
  };
  ui.archiveWs.onerror = () => notify('The recording connection failed. The interview continues without a recording.', 'error');
}

function stopBackgroundRecording() {
  return new Promise(resolve => {
    const rec = ui.backgroundRecorder;
    const finish = () => {
      setTimeout(() => {
        if (ui.archiveWs && ui.archiveWs.readyState === WebSocket.OPEN) ui.archiveWs.close();
        ui.archiveWs = null;
        resolve();
      }, 400);
    };
    if (!rec || rec.state === 'inactive') return finish();
    rec.onstop = finish;
    try { rec.stop(); } catch (e) { finish(); }
  });
}

// One MediaRecorder per turn on the audio track only. Recording never stops
// between turns, so speech during "thinking" is captured for the next turn.
function startTurnRecording() {
  if (!ui.stream) return;
  const track = ui.stream.getAudioTracks()[0];
  if (!track) return;
  ui.turnChunks = [];
  ui.turnSpeechDetected = false;
  ui.turnStartedAt = performance.now();
  ui.lastSpeechAt = 0;
  const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm']);
  const rec = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  rec.ondataavailable = e => { if (e.data.size > 0) ui.turnChunks.push(e.data); };
  rec.start();
  ui.turnRecorder = rec;
}

// Stops the current turn recorder and resolves with its audio blob.
function stopTurnRecording() {
  return new Promise(resolve => {
    const rec = ui.turnRecorder;
    ui.turnRecorder = null;
    if (!rec || rec.state === 'inactive') return resolve(null);
    const chunks = ui.turnChunks;
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    try { rec.stop(); } catch (e) { resolve(null); }
  });
}

function sendAudio(blob, final = false) {
  if (!blob || !ui.orchestratorWs || ui.orchestratorWs.readyState !== WebSocket.OPEN) return false;
  ui.orchestratorWs.send(JSON.stringify({ type: 'audio_meta', mime: blob.type || 'audio/webm', final }));
  ui.orchestratorWs.send(blob);
  return true;
}

// ---------------------------------------------------------------------------
// Level meter and silence detection

function setupVisualizer() {
  ui.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = ui.audioContext.createMediaStreamSource(ui.stream);
  ui.analyser = ui.audioContext.createAnalyser();
  ui.analyser.fftSize = 256;
  source.connect(ui.analyser);
  ui.dataArray = new Uint8Array(ui.analyser.frequencyBinCount);
  const frame = () => {
    ui.visualizerFrame = requestAnimationFrame(frame);
    if (!ui.analyser) return;
    ui.analyser.getByteFrequencyData(ui.dataArray);
    let sum = 0;
    for (let i = 0; i < ui.dataArray.length; i++) sum += ui.dataArray[i];
    const level = sum / ui.dataArray.length;
    const threshold = Math.max(14, ui.noiseFloor * 1.8 + 6);
    const speaking = level > threshold;
    if (!speaking) ui.noiseFloor = ui.noiseFloor * 0.98 + level * 0.02;

    if (ui.state === 'listening' && !ui.frozen) {
      statusDot.style.transform = `scale(${Math.min(2.5, 1 + level / 50)})`;
      statusDot.style.boxShadow = speaking ? `0 0 10px rgba(46, 160, 67, ${Math.min(1, level / 100)})` : 'none';
      statusText.innerText = speaking ? 'LISTENING' : (ui.turnSpeechDetected ? 'LISTENING (pause to send)' : 'LISTENING');
    }
    if (speaking && (ui.state === 'listening' || ui.state === 'thinking') && !ui.frozen) {
      ui.turnSpeechDetected = true;
      ui.lastSpeechAt = performance.now();
    }
    if (ui.state === 'listening' && !ui.frozen && ui.turnSpeechDetected) {
      const now = performance.now();
      if (now - ui.lastSpeechAt > ui.silenceMs && now - ui.turnStartedAt > 1500) submitTurn('silence');
    }
  };
  frame();
}

function stopVisualizer() {
  if (ui.visualizerFrame) cancelAnimationFrame(ui.visualizerFrame);
  ui.visualizerFrame = null;
  ui.analyser = null;
}

// ---------------------------------------------------------------------------
// Timer

function startTimer() {
  ui.sessionStartedAt = Date.now();
  ui.softLimitNotified = false;
  timerEl.hidden = false;
  timerEl.classList.remove('over');
  ui.timerInterval = setInterval(() => {
    const elapsed = (Date.now() - ui.sessionStartedAt) / 1000;
    timerEl.innerText = formatClock(elapsed);
    if (!ui.softLimitNotified && elapsed >= ui.softLimitMinutes * 60) {
      ui.softLimitNotified = true;
      timerEl.classList.add('over');
      notify(`You've been going for ${ui.softLimitMinutes} minutes. Wrap up when you're ready with Cmd+Enter.`, 'info', 12000);
      if (ui.orchestratorWs && ui.orchestratorWs.readyState === WebSocket.OPEN) ui.orchestratorWs.send(JSON.stringify({ type: 'time_check' }));
    }
  }, 500);
}

function stopTimer() {
  clearInterval(ui.timerInterval);
  ui.timerInterval = null;
}

// ---------------------------------------------------------------------------
// Session lifecycle

async function beginSession({ deepDive = false, context = '', mode = 'interview' } = {}) {
  showOverlay(null);
  lockSelectors(true);
  ui.state = 'starting';
  ui.frozen = false;
  ui.review = null;
  ui.mode = mode;
  $('triage-progress').hidden = true;
  transcriptDisplay.innerText = '';
  setQuestion('Starting up…', true);
  setStatus('STARTING CAMERA & MIC', 'thinking');

  try {
    await setupMedia();
  } catch (e) {
    showError('Madrone Context needs microphone access to run an interview. Grant access in System Settings > Privacy & Security > Microphone, then try again.');
    return;
  }

  const wsBase = `ws://${window.location.host}`;
  const ws = new WebSocket(`${wsBase}/ws/orchestrator`);
  ui.orchestratorWs = ws;
  ws.onopen = () => {
    setStatus('CONNECTING', 'thinking');
    const payload = { type: 'init', model: modelSelect.value, persona: personaSelect.value, context_id: contextSelect.value || null, mode };
    if (deepDive) { payload.deep_dive = true; payload.context = context; }
    ws.send(JSON.stringify(payload));
  };
  ws.onmessage = event => handleServerMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (ui.state === 'starting' || ui.state === 'listening' || ui.state === 'thinking') {
      showError('The connection to the local server was lost. Your recording so far is kept in the archives folder.');
    }
  };
  ws.onerror = () => { /* onclose reports it */ };
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'session':
      ui.session = data;
      startBackgroundRecording();
      startTimer();
      if (data.mode === 'inbox') {
        ui.inboxTotal = data.inbox_total || 0;
        ui.inboxDone = 0;
        $('triage-progress').innerText = `Inbox 0 / ${ui.inboxTotal}`;
        $('triage-progress').hidden = false;
      }
      break;
    case 'inbox_ready':
      ui.inboxTotal = data.total;
      $('triage-progress').innerText = `Inbox 0 / ${ui.inboxTotal}`;
      break;
    case 'triage': {
      ui.inboxDone = ui.inboxTotal - data.remaining;
      $('triage-progress').innerText = `Inbox ${ui.inboxDone} / ${ui.inboxTotal}`;
      const what = data.kind === 'discard' ? 'Discarded' : data.kind === 'todo' ? 'To-do' : 'Thought';
      notify(data.kind === 'discard' ? `Discarded "${data.item.name}".` : `${what} in ${data.context}: "${data.title}"${data.due ? `, due ${data.due}` : ''}.`, 'info', 7000);
      break;
    }
    case 'inbox_done':
      notify('Inbox clear. Press Cmd+Enter to finish and save the review.', 'info', 15000);
      break;
    case 'status':
      if (ui.state !== 'review') setQuestion(data.text, true);
      else $('review-status').innerText = data.text;
      break;
    case 'notice':
      notify(data.text, data.level || 'info', 9000, data.action || null);
      break;
    case 'question':
      transcriptDisplay.innerText = data.transcript ? `"${data.transcript}"` : '';
      setQuestion(data.text);
      ui.state = 'listening';
      if (!ui.turnRecorder) startTurnRecording();
      if (ui.frozen) setStatus('PAUSED (Shift+Esc to resume)', 'paused');
      else setStatus('LISTENING', '');
      break;
    case 'listen':
      notify(data.text);
      ui.state = 'listening';
      if (!ui.turnRecorder) startTurnRecording();
      setStatus('LISTENING', '');
      break;
    case 'review':
      showReview(data);
      break;
    case 'analysis':
      applyAnalysis(data);
      break;
    case 'saved':
      showDone(data);
      break;
    case 'discarded':
      ui.state = 'done';
      $('done-title').innerText = 'Session discarded';
      $('done-text').innerText = data.removed && data.removed.length ? 'The recording was deleted. Nothing was written to your notes.' : 'Nothing was written to your notes.';
      $('btn-show-note').hidden = true;
      showOverlay('done-screen');
      cleanupConnections();
      break;
    case 'error':
      showError(data.text);
      break;
    default:
      break;
  }
}

async function submitTurn(reason) {
  if (ui.state !== 'listening' || ui.frozen) return;
  ui.state = 'thinking';
  transcriptDisplay.innerText = '';
  setQuestion(reason === 'silence' ? 'Got it, thinking…' : 'Thinking…', true);
  setStatus('THINKING', 'thinking');
  const blob = await stopTurnRecording();
  // Keep capturing right away so nothing said while the model thinks is lost.
  startTurnRecording();
  if (!sendAudio(blob)) {
    ui.state = 'listening';
    setStatus('LISTENING', '');
  }
}

function toggleFreeze() {
  if (ui.state !== 'listening' && ui.state !== 'thinking') return;
  ui.frozen = !ui.frozen;
  const recs = [ui.backgroundRecorder, ui.turnRecorder];
  if (ui.frozen) {
    for (const r of recs) { if (r && r.state === 'recording') r.pause(); }
    setStatus('PAUSED (Shift+Esc to resume)', 'paused');
  } else {
    for (const r of recs) { if (r && r.state === 'paused') r.resume(); }
    ui.lastSpeechAt = performance.now(); // give the user a moment before silence counts again
    setStatus(ui.state === 'thinking' ? 'THINKING' : 'LISTENING', ui.state === 'thinking' ? 'thinking' : '');
  }
}

async function concludeSession() {
  if (!['listening', 'thinking'].includes(ui.state)) return;
  const wasFrozen = ui.frozen;
  ui.frozen = false;
  ui.state = 'ending';
  stopTimer();
  transcriptDisplay.innerText = '';
  setQuestion('Wrapping up…', true);
  setStatus('FINISHING', 'thinking');

  if (wasFrozen) {
    for (const r of [ui.backgroundRecorder, ui.turnRecorder]) { if (r && r.state === 'paused') r.resume(); }
  }
  const hadSpeech = ui.turnSpeechDetected;
  const blob = await stopTurnRecording();
  if (hadSpeech && blob) sendAudio(blob, true);
  await stopBackgroundRecording();
  releaseMedia();
  if (ui.orchestratorWs && ui.orchestratorWs.readyState === WebSocket.OPEN) {
    ui.orchestratorWs.send(JSON.stringify({ type: 'end_session' }));
  } else {
    showError('The connection to the local server was lost before the session could be summarized. Your recording is kept in the archives folder.');
  }
}

function showReview(data) {
  ui.state = 'review';
  ui.review = data;
  $('review-summary').innerText = data.summary || 'No summary was generated.';
  const insights = $('review-insights');
  insights.className = 'review-body';
  insights.innerText = data.insights || 'No insights were generated.';
  const synergy = $('review-synergy');
  if (data.video_status === 'pending') {
    synergy.className = 'review-body pending';
    synergy.innerText = 'Analyzing the video for body language and tone… You can save now; the analysis is added when it finishes.';
  } else {
    synergy.className = 'review-body';
    synergy.innerText = 'Not analyzed. This model does not analyze video; the recording is archived for later.';
  }
  $('btn-investigate').hidden = true;
  $('btn-save').disabled = false;
  $('btn-save').innerText = 'Save to notes';
  $('btn-discard').disabled = false;
  $('review-status').innerText = '';
  showOverlay('review-screen');
}

function applyAnalysis(data) {
  const synergy = $('review-synergy');
  if (data.error) {
    synergy.className = 'review-body error';
    synergy.innerText = `Video analysis failed: ${data.error}. The recording is archived and can be analyzed later.`;
    return;
  }
  synergy.className = 'review-body';
  synergy.innerText = data.synergy || 'No discrepancies were detected.';
  if (data.insights) {
    const insights = $('review-insights');
    insights.innerText = `${insights.innerText}\n\nFrom the video:\n${data.insights}`;
  }
  if (ui.review) ui.review.synergy = data.synergy;
  $('btn-investigate').hidden = !data.synergy;
}

function showDone(data) {
  ui.state = 'done';
  ui.lastNotePath = data.note_path;
  if (ui.pendingInvestigate && data.synergy) {
    ui.pendingInvestigate = false;
    cleanupConnections();
    beginSession({ deepDive: true, context: data.synergy });
    return;
  }
  ui.pendingInvestigate = false;
  $('done-title').innerText = 'Saved';
  const linked = data.entities ? [...(data.entities.people || []), ...(data.entities.projects || []), ...(data.entities.topics || [])] : [];
  const linkedText = linked.length ? `\nLinked notes: ${linked.slice(0, 6).join(', ')}${linked.length > 6 ? ` and ${linked.length - 6} more` : ''}.` : '';
  const decisionsText = data.decisions ? `\n${data.decisions} inbox ${data.decisions === 1 ? 'item' : 'items'} filed.` : '';
  $('done-text').innerText = (data.dossier_updated
    ? `Session note saved in ${data.context || 'your notes'} and its Master Dossier updated.`
    : `Session note saved in ${data.context || 'your notes'}.`) + decisionsText + linkedText + `\n${data.note_path}`;
  ui.lastObsidianUrl = data.obsidian_url || null;
  $('btn-open-obsidian').hidden = !(window.electronAPI && data.obsidian_url);
  $('btn-show-note').hidden = !window.electronAPI;
  $('google-suggest').hidden = !(window.electronAPI && ui.status && ui.status.suggestGoogle);
  showOverlay('done-screen');
  cleanupConnections();
}

function cleanupConnections() {
  if (ui.orchestratorWs) { ui.orchestratorWs.onclose = null; try { ui.orchestratorWs.close(); } catch (e) { /* ignore */ } }
  ui.orchestratorWs = null;
  ui.session = null;
  releaseMedia();
}

function showError(text) {
  stopTimer();
  ui.state = 'error';
  $('error-text').innerText = text;
  showOverlay('error-screen');
  cleanupConnections();
  lockSelectors(false);
}

function resetToStart() {
  stopTimer();
  cleanupConnections();
  ui.state = 'idle';
  ui.frozen = false;
  lockSelectors(false);
  timerEl.hidden = true;
  $('triage-progress').hidden = true;
  transcriptDisplay.innerText = '';
  setQuestion('Ready when you are.');
  setStatus('IDLE', 'idle');
  loadCatalog();
  showOverlay('start-screen');
}

// ---------------------------------------------------------------------------
// Keys and buttons

window.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement && document.activeElement.tagName);
  if (e.code === 'Space' && !e.repeat && !typing) {
    if (ui.state === 'listening' && !ui.frozen) { e.preventDefault(); submitTurn('space'); }
    return;
  }
  if (e.code === 'Escape' && e.shiftKey) { e.preventDefault(); toggleFreeze(); return; }
  if (e.code === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); concludeSession(); }
});

$('btn-start').addEventListener('click', () => beginSession({ mode: 'interview' }));
$('btn-inbox').addEventListener('click', () => beginSession({ mode: 'inbox' }));
contextSelect.addEventListener('change', () => { if (window.electronAPI) window.electronAPI.setActiveContext(contextSelect.value).then(() => loadCatalog()); });
modelSelect.addEventListener('change', updateModelReadiness);
$('key-panel-save').addEventListener('click', async () => {
  const vendor = $('key-panel').dataset.vendor;
  const value = $('key-panel-input').value.trim();
  if (!value || !window.electronAPI) return;
  const name = { gemini: 'geminiApiKey', anthropic: 'anthropicApiKey', openai: 'openaiApiKey' }[vendor];
  try { await window.electronAPI.setSecret(name, value); $('key-panel-input').value = ''; await loadCatalog(); }
  catch (e) { $('key-panel-msg').innerText = cleanError(e); }
});
$('key-panel-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('key-panel-save').click(); });
$('key-panel-clip').addEventListener('click', async () => {
  const vendor = $('key-panel').dataset.vendor;
  if (!window.electronAPI) return;
  const c = await window.electronAPI.clipboardKey(vendor);
  if (c) { addKeyCandidate(vendor, c); $('key-panel-msg').innerText = ''; }
  else $('key-panel-msg').innerText = 'The clipboard does not contain a key of that kind. Copy the key first, then click again.';
});
$('key-panel-env').addEventListener('click', async () => {
  const vendor = $('key-panel').dataset.vendor;
  if (!window.electronAPI) return;
  const r = await window.electronAPI.importEnvFile();
  if (!r) return;
  if (r[vendor].length) { for (const c of r[vendor]) addKeyCandidate(vendor, c); $('key-panel-msg').innerText = ''; }
  else $('key-panel-msg').innerText = `No matching key was found in ${r.file.split('/').pop()}.`;
});
$('key-panel-op').addEventListener('click', keyPanelFromOnePassword);
$('key-panel-link').addEventListener('click', () => { const url = KEY_URLS[$('key-panel').dataset.vendor]; if (window.electronAPI) window.electronAPI.openExternal(url); else window.open(url); });
$('btn-suggest-google').addEventListener('click', () => openSettingsFor('google'));
$('btn-suggest-later').addEventListener('click', async () => { $('google-suggest').hidden = true; if (window.electronAPI) await window.electronAPI.dismissGoogleSuggestion(); });
$('btn-error-restart').addEventListener('click', resetToStart);
$('btn-error-settings').addEventListener('click', () => { if (window.electronAPI) window.electronAPI.openSettings(null); });
$('settings-btn').addEventListener('click', () => {
  if (!window.electronAPI) { alert('Settings are available in the desktop app.'); return; }
  openSettingsFor(null);
});

$('btn-save').addEventListener('click', () => {
  $('btn-save').disabled = true;
  $('btn-discard').disabled = true;
  $('btn-investigate').disabled = true;
  $('btn-save').innerText = 'Saving…';
  if (ui.orchestratorWs && ui.orchestratorWs.readyState === WebSocket.OPEN) ui.orchestratorWs.send(JSON.stringify({ type: 'save_session' }));
  else showError('The connection to the local server was lost before the session could be saved.');
});

$('btn-investigate').addEventListener('click', () => {
  ui.pendingInvestigate = true;
  $('btn-save').click();
});

$('btn-discard').addEventListener('click', () => {
  if (!confirm('Discard this session? The recording will be deleted and nothing will be written to your notes.')) return;
  $('btn-save').disabled = true;
  $('btn-discard').disabled = true;
  if (ui.orchestratorWs && ui.orchestratorWs.readyState === WebSocket.OPEN) ui.orchestratorWs.send(JSON.stringify({ type: 'discard_session' }));
  else resetToStart();
});

$('btn-new-session').addEventListener('click', resetToStart);
$('btn-quit').addEventListener('click', () => { if (window.electronAPI) window.electronAPI.quitApp(); else resetToStart(); });
$('btn-show-note').addEventListener('click', () => { if (window.electronAPI && ui.lastNotePath) window.electronAPI.showPath(ui.lastNotePath); });
$('btn-open-obsidian').addEventListener('click', () => { if (window.electronAPI && ui.lastNotePath) window.electronAPI.openInObsidian(ui.lastNotePath); });

window.addEventListener('beforeunload', () => releaseMedia());

setStatus('IDLE', 'idle');
loadCatalog();
