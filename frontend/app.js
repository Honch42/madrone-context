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

function notify(text, level = 'info', ms = 9000) {
  const el = document.createElement('div');
  el.className = 'notice' + (level === 'error' ? ' error' : '');
  el.innerText = text;
  $('notices').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function lockSelectors(locked) {
  modelSelect.disabled = locked;
  personaSelect.disabled = locked;
}

// ---------------------------------------------------------------------------
// Setup: models, personas, settings

async function loadCatalog() {
  try {
    const [models, status] = await Promise.all([
      fetch('/api/models').then(r => r.json()),
      fetch('/api/status').then(r => r.json())
    ]);
    modelSelect.innerHTML = '';
    for (const m of models.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.available ? m.label : `${m.label} (needs ${m.missing.join(' + ')} key)`;
      opt.disabled = !m.available;
      opt.title = m.note;
      modelSelect.appendChild(opt);
    }
    const preferred = models.lastModel && models.models.find(m => m.id === models.lastModel && m.available);
    const firstAvailable = models.models.find(m => m.available);
    modelSelect.value = preferred ? preferred.id : (firstAvailable ? firstAvailable.id : '');
    personaSelect.innerHTML = '';
    for (const p of models.personas) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.label;
      personaSelect.appendChild(opt);
    }
    if (models.lastPersona) personaSelect.value = models.lastPersona;

    ui.silenceMs = Math.max(600, Number(status.silenceSeconds || 1.8) * 1000);
    ui.softLimitMinutes = Number(status.sessionMinutesSoftLimit || 15);
    const bits = [];
    bits.push(`Notes are saved to ${status.workspaceDir}.`);
    if (!firstAvailable) bits.push('Add a Gemini API key in Settings to begin.');
    $('start-hint').innerText = bits.join(' ');
    $('btn-start').disabled = !firstAvailable;
  } catch (e) {
    $('start-hint').innerText = 'Could not reach the local server. Try restarting the app.';
    $('btn-start').disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Media

async function setupMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    ui.stream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' }
    });
    ui.hasVideo = ui.stream.getVideoTracks().length > 0;
  } catch (e) {
    // No camera (or camera denied): fall back to audio only. The interview still works.
    ui.stream = await navigator.mediaDevices.getUserMedia({ audio });
    ui.hasVideo = false;
    notify('No camera available. Recording audio only; the session will not get a video analysis.');
  }
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

async function beginSession({ deepDive = false, context = '' } = {}) {
  showOverlay(null);
  lockSelectors(true);
  ui.state = 'starting';
  ui.frozen = false;
  ui.review = null;
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
    const payload = { type: 'init', model: modelSelect.value, persona: personaSelect.value };
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
      break;
    case 'status':
      if (ui.state !== 'review') setQuestion(data.text, true);
      else $('review-status').innerText = data.text;
      break;
    case 'notice':
      notify(data.text, data.level || 'info');
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
  $('done-text').innerText = data.dossier_updated
    ? `Session note saved and your Master Dossier updated.\n${data.note_path}`
    : `Session note saved.\n${data.note_path}`;
  $('btn-show-note').hidden = !window.electronAPI;
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

$('btn-start').addEventListener('click', () => beginSession());
$('btn-error-restart').addEventListener('click', resetToStart);
$('btn-error-settings').addEventListener('click', () => { if (window.electronAPI) window.electronAPI.openSettings(); });
$('settings-btn').addEventListener('click', () => {
  if (!window.electronAPI) { alert('Settings are available in the desktop app.'); return; }
  if (['listening', 'thinking', 'starting', 'ending'].includes(ui.state) && !confirm('Leave this session? The recording so far is kept, but the conversation will not be summarized or saved.')) return;
  cleanupConnections();
  window.electronAPI.openSettings();
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

window.addEventListener('beforeunload', () => releaseMedia());

setStatus('IDLE', 'idle');
loadCatalog();
