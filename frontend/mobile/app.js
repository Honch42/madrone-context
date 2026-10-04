'use strict';

// ---------------------------------------------------------------------------
// Madrone Context - Mobile Context Capture PWA Client
// ---------------------------------------------------------------------------

let db = null;
let currentDeck = [];
let currentCardIndex = 0;
let sessionId = null;
let sessionStartTime = null;
let sessionTimerInterval = null;
let turnIndex = 0;

let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recordingStartTime = null;
let recordingTimerInterval = null;
let isRecording = false;
let isPaused = false;
let wakeLock = null;
let isDraining = false;

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// IndexedDB Initialization
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('madrone_mobile_db', 1);
    request.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('turns')) {
        const store = d.createObjectStore('turns', { keyPath: 'id', autoIncrement: true });
        store.createIndex('session_id', 'session_id', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    request.onsuccess = e => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = e => reject(e.target.error);
  });
}

// Save turn to IndexedDB with verified commit
async function queueTurnLocally(turnData) {
  if (!db) {
    await initDatabase();
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('turns', 'readwrite');
    const store = tx.objectStore('turns');
    turnData.status = 'queued';
    turnData.created_at = new Date().toISOString();
    store.add(turnData);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

let activeUploadingTurn = null;

// Check pending turns in IndexedDB
function checkPendingTurnsCount() {
  if (!db) return;
  try {
    const tx = db.transaction('turns', 'readonly');
    const store = tx.objectStore('turns');
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const turns = allReq.result || [];
      const pending = turns.filter(t => t.status !== 'uploaded' && t.status !== 'discarded' && t.status !== 'corrupted_empty');
      const uploaded = turns.filter(t => t.status === 'uploaded');
      const bannerTextEl = document.getElementById('sync-banner-text');
      if (bannerTextEl) {
        if (turns.length === 0) {
          bannerTextEl.textContent = 'Storage: 0 recordings found in this browser.';
        } else if (pending.length > 0) {
          bannerTextEl.textContent = `Storage: ${turns.length} total (${pending.length} pending sync, ${uploaded.length} synced).`;
        } else {
          bannerTextEl.textContent = `Storage: All ${turns.length} recordings synced to Mac! ✅`;
        }
      }
      if (pending.length > 0) {
        updateStatusBadge(`Syncing (${pending.length})`, 'amber');
      } else {
        updateStatusBadge('Ready', '');
      }
    };
  } catch (e) {}
}

// Sync queued turns to the server with concurrency lock and retry limits
async function drainUploadQueue(forceAll = false) {
  if (!db || isDraining) return;
  isDraining = true;

  // Safety ceiling: never let isDraining stay locked indefinitely
  const drainSafetyTimer = setTimeout(() => {
    if (isDraining) {
      console.warn('[mobile] isDraining safety timeout — releasing lock');
      isDraining = false;
      activeUploadingTurn = null;
    }
  }, 40000);

  try {
    const tx = db.transaction('turns', 'readonly');
    const store = tx.objectStore('turns');
    const req = store.getAll();

    req.onsuccess = async () => {
      try {
        const allTurns = req.result || [];
        const turnsToSync = allTurns.filter(t => {
          if (t.status === 'uploaded' || t.status === 'discarded' || t.status === 'corrupted_empty') return false;
          if (forceAll) return true;
          return t.status === 'queued' || t.status === 'error' || t.status === 'failed';
        });

        if (!turnsToSync.length) {
          activeUploadingTurn = null;
          updateStatusBadge('Ready', '');
          checkPendingTurnsCount();
          return;
        }

        updateStatusBadge('Syncing (' + turnsToSync.length + ')', 'live');
        const bannerTextEl = document.getElementById('sync-banner-text');
        if (bannerTextEl) bannerTextEl.textContent = `Uploading ${turnsToSync.length} turn(s) to your Mac...`;

        for (const turn of turnsToSync) {
          // Guard: Skip and mark empty/corrupted blobs so they never block the queue
          if (!turn.blob || turn.blob.size === 0) {
            console.warn('[mobile] Skipping empty/corrupted turn blob for turn', turn.turn_index);
            try {
              const writeTx = db.transaction('turns', 'readwrite');
              turn.status = 'corrupted_empty';
              turn.error = 'Empty audio blob';
              writeTx.objectStore('turns').put(turn);
            } catch (err) {}
            continue;
          }

          // If device is offline, pause drain without burning retries
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            console.log('[mobile] Device offline. Pausing sync for turn', turn.turn_index);
            activeUploadingTurn = null;
            break;
          }

          activeUploadingTurn = {
            turn_index: turn.turn_index,
            card_id: turn.card_id,
            started_at: Date.now()
          };

          try {
            console.log('[mobile] Syncing turn ' + turn.turn_index + ' (' + turn.card_id + '), attempt ' + (turn.retry_count || 0) + '...');
            
            // 20s timeout so hanging connections fail fast and can be retried cleanly
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(new Error('Upload timeout (20s)')), 20000);

            let res;
            try {
              res = await fetch('/api/mobile/turn', {
                method: 'POST',
                headers: {
                  'Content-Type': turn.mime_type || 'audio/mp4',
                  'x-session-id': turn.session_id,
                  'x-card-id': turn.card_id,
                  'x-turn-index': String(turn.turn_index),
                  'x-turn-id': turn.turn_id || '',
                  'x-is-freeform': String(turn.is_freeform),
                  'x-duration': String(turn.duration_seconds),
                  'x-card-prompt': encodeURIComponent(turn.card_prompt || ''),
                  'x-card-source': encodeURIComponent(turn.card_source || '')
                },
                body: turn.blob,
                signal: controller.signal
              });
            } finally {
              clearTimeout(timeoutId);
            }

            if (res.ok) {
              const resData = await res.json().catch(() => ({}));
              const writeTx = db.transaction('turns', 'readwrite');
              turn.status = 'uploaded';
              turn.error = null;
              turn.retry_count = 0;
              if (resData && resData.transcript) {
                turn.transcript = resData.transcript;
              }
              writeTx.objectStore('turns').put(turn);
              console.log('[mobile] Turn ' + turn.turn_index + ' uploaded successfully!');
            } else {
              console.warn('[mobile] Server returned ' + res.status + ' for turn ' + turn.turn_index);
              const writeTx = db.transaction('turns', 'readwrite');
              if ([400, 413, 415, 422].includes(res.status)) {
                turn.status = 'error';
                turn.error = `HTTP ${res.status}: Unprocessable payload`;
              } else {
                turn.retry_count = (turn.retry_count || 0) + 1;
                turn.error = `HTTP ${res.status}`;
                if (turn.retry_count >= 10) {
                  turn.status = 'failed';
                  turn.error = `HTTP ${res.status}: Exceeded 10 retries`;
                } else {
                  turn.status = 'error';
                }
              }
              writeTx.objectStore('turns').put(turn);
            }
          } catch (e) {
            const isOfflineOrAborted = (typeof navigator !== 'undefined' && !navigator.onLine) || e.name === 'AbortError' || e instanceof TypeError;
            console.warn('[mobile] Sync pause for turn ' + turn.turn_index + ' (' + (isOfflineOrAborted ? 'network/timeout' : e.message) + ')');
            
            try {
              const writeTx = db.transaction('turns', 'readwrite');
              turn.status = 'error';
              turn.error = e.message || 'Connection paused';
              if (!isOfflineOrAborted) {
                turn.retry_count = (turn.retry_count || 0) + 1;
                if (turn.retry_count >= 10) {
                  turn.status = 'failed';
                  turn.error = `Network error: ${e.message}`;
                }
              }
              writeTx.objectStore('turns').put(turn);
            } catch (err) {}
            break;
          }
        }
      } finally {
        activeUploadingTurn = null;
        clearTimeout(drainSafetyTimer);
        isDraining = false;
        checkPendingTurnsCount();
      }
    };
    req.onerror = () => {
      activeUploadingTurn = null;
      clearTimeout(drainSafetyTimer);
      isDraining = false;
    };
  } catch (e) {
    activeUploadingTurn = null;
    clearTimeout(drainSafetyTimer);
    isDraining = false;
  }
}

// Request Screen Wake Lock
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      console.warn('Wake Lock error:', e.message);
    }
  }
}

// Determine best supported audio MIME type for iOS Safari
function getSupportedAudioMime() {
  const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return 'audio/mp4';
}

// DOM Elements
const cardTagEl = document.getElementById('card-tag');
const cardCountEl = document.getElementById('card-count');
const cardQuestionEl = document.getElementById('card-question');
const cardContextEl = document.getElementById('card-context');
const timerDisplayEl = document.getElementById('timer-display');
const timerPillEl = document.getElementById('timer-pill');
const statusBadgeEl = document.getElementById('status-badge');
const recordingBarEl = document.getElementById('recording-bar');
const recTimerEl = document.getElementById('rec-timer');
const passengerModalEl = document.getElementById('passenger-modal');
const passengerSyncStatusEl = document.getElementById('passenger-sync-status');
const btnPassengerConfirmEl = document.getElementById('btn-passenger-confirm');
const btnPassengerBypassEl = document.getElementById('btn-passenger-bypass');
const passengerSyncActionsEl = document.getElementById('passenger-sync-actions');
const btnPassengerDiscardStuckEl = document.getElementById('btn-passenger-discard-stuck');
const concludeModalEl = document.getElementById('conclude-modal');
const concludeProgressLabelEl = document.getElementById('conclude-progress-label');
const concludeProgressPercentEl = document.getElementById('conclude-progress-percent');
const concludeProgressBarEl = document.getElementById('conclude-progress-bar');
const concludeLiveStatusEl = document.getElementById('conclude-live-status');
const concludeWarningEl = document.getElementById('conclude-warning');
const concludeTurnsListEl = document.getElementById('conclude-turns-list');
const btnConcludeDoneEl = document.getElementById('btn-conclude-done');
const btnConcludeRetryEl = document.getElementById('btn-conclude-retry');
const btnConcludeOfflineEl = document.getElementById('btn-conclude-offline');
const savingOverlayEl = document.getElementById('saving-overlay');

const btnRecordEl = document.getElementById('btn-record');
const btnSkipEl = document.getElementById('btn-skip');
const btnDismissEl = document.getElementById('btn-dismiss');
const btnConcludeEl = document.getElementById('btn-conclude');
const btnPauseEl = document.getElementById('btn-pause');
const btnFinishTurnEl = document.getElementById('btn-finish-turn');
const btnQuickDumpEl = document.getElementById('btn-quick-dump');

function updateStatusBadge(text, cls = '') {
  statusBadgeEl.textContent = text;
  statusBadgeEl.className = 'status-badge ' + cls;
}

// Load Deck from server
async function loadDeck() {
  updateStatusBadge('Loading...', '');
  try {
    const res = await fetch('/api/mobile/deck');
    const data = await res.json();
    if (data.ok && Array.isArray(data.deck) && data.deck.length > 0) {
      currentDeck = data.deck;
      currentCardIndex = 0;
      renderCurrentCard();
      updateStatusBadge('Ready', '');
    } else {
      renderEmptyDeck();
    }
  } catch (e) {
    console.error('Failed to load deck:', e);
    updateStatusBadge('Offline', '');
    currentDeck = [{
      id: 'offline-freeform',
      type: 'freeform',
      badge: 'OFFLINE CAPTURE',
      question: 'Offline mode active. Tap record to capture an unprompted brain dump or session answer.',
      context: 'Turns will sync to your Mac automatically when connection returns.',
      is_freeform: true
    }];
    renderCurrentCard();
  }
}

function renderCurrentCard() {
  if (!currentDeck.length || currentCardIndex >= currentDeck.length) {
    renderEmptyDeck();
    return;
  }
  const card = currentDeck[currentCardIndex];
  cardTagEl.textContent = card.badge || card.type.toUpperCase();
  cardCountEl.textContent = `${currentCardIndex + 1} of ${currentDeck.length}`;
  cardQuestionEl.textContent = card.question;
  cardContextEl.textContent = card.context || '';
}

function renderEmptyDeck() {
  cardTagEl.textContent = 'ALL CARDS COMPLETED';
  cardCountEl.textContent = '';
  cardQuestionEl.textContent = 'You have answered all available questions in this deck! Tap Quick Dump for spontaneous thoughts, or conclude the session.';
  cardContextEl.textContent = 'Great work! Review staged items when you return to your Mac.';
  btnRecordEl.style.display = 'none';
  btnSkipEl.style.display = 'none';
  btnDismissEl.style.display = 'none';
}

// Session Timer Management (15:00 ceiling)
function startSessionTimer() {
  sessionStartTime = Date.now();
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);

  sessionTimerInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - sessionStartTime) / 1000);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    const text = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timerDisplayEl.textContent = text;

    if (elapsedSec >= 15 * 60) {
      timerPillEl.classList.add('amber');
    }
    if (elapsedSec === 20 * 60) {
      alert('20-minute session ceiling reached. Wrap up your current thought or tap Conclude to take a break.');
    }
  }, 1000);
}

// Audio Recording Lifecycle
async function startRecording() {
  if (isRecording) return;
  try {
    const mimeType = getSupportedAudioMime();
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const currentCard = currentDeck[currentCardIndex] || {};
    const localChunks = [];
    const localStream = audioStream;
    const localRecorder = new MediaRecorder(localStream, { mimeType });
    mediaRecorder = localRecorder;

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onmute = () => {
        updateStatusBadge('⚠️ Mic Muted by iOS', 'amber');
      };
      audioTrack.onunmute = () => {
        updateStatusBadge('Listening', 'live');
      };
      audioTrack.onended = () => {
        if (isRecording) {
          finishTurn(true);
        }
      };
    }

    localRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) localChunks.push(e.data);
    };

    let finishPromiseResolve = null;
    let finishPromiseReject = null;
    localRecorder._finishPromise = new Promise((res, rej) => {
      finishPromiseResolve = res;
      finishPromiseReject = rej;
    });

    localRecorder.onstop = async () => {
      try {
        if (savingOverlayEl) savingOverlayEl.style.display = 'flex';
        const audioBlob = new Blob(localChunks, { type: mimeType });
        if (localStream) {
          localStream.getTracks().forEach(t => t.stop());
        }

        turnIndex++;
        localStorage.setItem('madrone_turn_index', String(turnIndex));

        const turnData = {
          session_id: sessionId,
          card_id: currentCard.id || 'freeform',
          turn_index: turnIndex,
          turn_id: generateUUID(),
          duration_seconds: Math.round((Date.now() - recordingStartTime) / 1000),
          is_freeform: !!currentCard.is_freeform,
          card_prompt: currentCard.question || '',
          card_source: currentCard.source_file || '',
          mime_type: mimeType,
          blob: audioBlob
        };

        await queueTurnLocally(turnData);
        drainUploadQueue();

        currentCardIndex++;
        localStorage.setItem('madrone_card_index', String(currentCardIndex));
        renderCurrentCard();

        // Card is ready immediately once previous turn is confirmed saved
        btnRecordEl.disabled = false;
        btnRecordEl.textContent = '🎙 Record Answer';

        if (finishPromiseResolve) finishPromiseResolve();
      } catch (err) {
        console.error('Error saving turn:', err);
        if (finishPromiseReject) finishPromiseReject(err);
      } finally {
        if (savingOverlayEl) savingOverlayEl.style.display = 'none';
        isRecording = false;
        isPaused = false;
        recordingBarEl.style.display = 'none';
        btnFinishTurnEl.style.display = 'none';
        btnPauseEl.style.display = 'none';
        btnRecordEl.style.display = 'flex';
        btnSkipEl.style.display = 'flex';
        btnDismissEl.style.display = 'flex';
      }
    };

    localRecorder.onstart = () => {
      // Audio capture is actively confirmed running by hardware
      btnFinishTurnEl.disabled = false;
      btnFinishTurnEl.textContent = '■ Finish Speaking';
      updateStatusBadge('Listening', 'live');
    };

    localRecorder.start();
    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    requestWakeLock();
    btnRecordEl.style.display = 'none';
    btnSkipEl.style.display = 'none';
    btnDismissEl.style.display = 'none';
    recordingBarEl.style.display = 'flex';
    btnFinishTurnEl.style.display = 'flex';
    btnPauseEl.style.display = 'flex';

    // Gate finish button until recorder confirms it has started
    btnFinishTurnEl.disabled = true;
    btnFinishTurnEl.textContent = '⏳ Initializing Mic...';

    if (recordingTimerInterval) clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      recTimerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);

  } catch (e) {
    alert('Microphone access failed: ' + e.message);
    isRecording = false;
  }
}

async function pauseOrResumeRecording() {
  if (!mediaRecorder) return;
  if (!isPaused) {
    mediaRecorder.pause();
    isPaused = true;
    btnPauseEl.textContent = '▶ Resume';
    updateStatusBadge('Paused', '');
  } else {
    mediaRecorder.resume();
    isPaused = false;
    btnPauseEl.textContent = '⏸ Pause';
    updateStatusBadge('Listening', 'live');
  }
}

async function finishTurn(interrupted = false) {
  if (!mediaRecorder || !isRecording) return;
  btnFinishTurnEl.disabled = true;
  if (savingOverlayEl) savingOverlayEl.style.display = 'flex';
  clearInterval(recordingTimerInterval);

  const rec = mediaRecorder;
  if (rec.state === 'inactive') {
    if (savingOverlayEl) savingOverlayEl.style.display = 'none';
    return;
  }

  const stopTimeout = new Promise(resolve => setTimeout(resolve, 8000));
  try {
    rec.stop();
    if (rec._finishPromise) {
      await Promise.race([rec._finishPromise, stopTimeout]);
    }
  } catch (e) {
    console.warn('Error during finishTurn:', e);
  } finally {
    if (savingOverlayEl) savingOverlayEl.style.display = 'none';
  }
}

// Conclude Session with Monitored Uploads and Hard Gate
let concludePollInterval = null;
async function concludeSession() {
  if (isRecording) {
    await finishTurn();
  }
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);

  concludeModalEl.style.display = 'flex';
  btnConcludeDoneEl.disabled = true;
  btnConcludeDoneEl.style.background = '#334155';
  btnConcludeDoneEl.textContent = '⏳ Checking upload status...';
  if (btnConcludeOfflineEl) btnConcludeOfflineEl.style.display = 'none';
  if (btnConcludeRetryEl) btnConcludeRetryEl.style.display = 'none';

  // Force unlock and trigger immediate upload drain
  isDraining = false;
  drainUploadQueue(true);

  // Monitor upload completion in IndexedDB
  const concludeStartTime = Date.now();
  if (concludePollInterval) clearInterval(concludePollInterval);

  concludePollInterval = setInterval(async () => {
    if (!db) return;
    try {
      const tx = db.transaction('turns', 'readonly');
      const store = tx.objectStore('turns');
      const req = store.getAll();

      req.onsuccess = () => {
        const allTurns = req.result || [];
        const sessionTurns = allTurns.filter(t => t.session_id === sessionId);
        const uploadedSessionTurns = sessionTurns.filter(t => t.status === 'uploaded');
        const pendingSessionTurns = sessionTurns.filter(t => t.status !== 'uploaded' && t.status !== 'discarded' && t.status !== 'corrupted_empty');
        const total = sessionTurns.length;
        const uploaded = uploadedSessionTurns.length;
        const pct = total > 0 ? Math.round((uploaded / total) * 100) : 100;

        concludeProgressBarEl.style.width = `${pct}%`;
        concludeProgressPercentEl.textContent = `${pct}% (${uploaded}/${total})`;
        document.getElementById('conclude-summary-text').textContent =
          `Session ${sessionId} has ${total} recorded turn${total === 1 ? '' : 's'}. Verifying 100% transfer to your Mac.`;

        // Update live status text
        if (concludeLiveStatusEl) {
          if (pendingSessionTurns.length === 0) {
            concludeLiveStatusEl.textContent = total > 0 ? `✅ All ${total} audio recording(s) transferred successfully to your Mac!` : 'No recordings in this session.';
            concludeLiveStatusEl.style.color = '#10b981';
          } else {
            const activeMsg = activeUploadingTurn ? `Uploading Turn ${activeUploadingTurn.turn_index} to your Mac now...` : `Transferring ${pendingSessionTurns.length} pending turn(s)...`;
            concludeLiveStatusEl.textContent = `⏳ ${activeMsg}`;
            concludeLiveStatusEl.style.color = '#38bdf8';
          }
        }

        // Render turn checklist with clear, honest indicators
        concludeTurnsListEl.innerHTML = sessionTurns.map(t => {
          const isUploaded = t.status === 'uploaded';
          const isCurrentActive = activeUploadingTurn && activeUploadingTurn.turn_index === t.turn_index;
          let icon = '⏳';
          let statusText = 'Queued';
          let textColor = '#f59e0b';

          if (isUploaded) {
            icon = '✅';
            statusText = 'Synced to Mac';
            textColor = '#10b981';
          } else if (isCurrentActive) {
            icon = '🔄';
            const elapsed = Math.round((Date.now() - activeUploadingTurn.started_at) / 1000);
            statusText = `Uploading (${elapsed}s)...`;
            textColor = '#38bdf8';
          } else if (t.status === 'error' || t.status === 'failed') {
            icon = '⚠️';
            statusText = t.error ? `Stalled (${t.error})` : 'Upload paused — will retry';
            textColor = '#f87171';
          }

          const sizeKB = t.blob ? Math.round(t.blob.size / 1024) + ' KB' : '';
          return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0; border-bottom: 1px solid #1e293b;">
            <span>${icon} Turn ${t.turn_index}: ${t.card_id} (${sizeKB})</span>
            <span style="color: ${textColor}; font-weight: 600;">${statusText}</span>
          </div>`;
        }).join('');

        // Periodic kick: if not actively draining and pending turns exist, kick drain
        if (!isDraining && pendingSessionTurns.length > 0) {
          drainUploadQueue(true);
        }

        // HARD GATE: Completion requires 100% of session turns to be confirmed uploaded!
        if (pendingSessionTurns.length === 0 && total > 0 && uploaded === total) {
          clearInterval(concludePollInterval);
          btnConcludeDoneEl.disabled = false;
          btnConcludeDoneEl.textContent = '✅ All Audio Transferred to Mac! Done';
          btnConcludeDoneEl.style.background = '#10b981';
          concludeWarningEl.style.background = 'rgba(16, 185, 129, 0.15)';
          concludeWarningEl.style.borderColor = '#10b981';
          concludeWarningEl.style.color = '#34d399';
          concludeWarningEl.innerHTML = '🎉 <strong>Transfer Complete:</strong> All recordings are safely stored on your Mac. You may now close Safari or start a new session.';
          if (btnConcludeRetryEl) btnConcludeRetryEl.style.display = 'none';
          if (btnConcludeOfflineEl) btnConcludeOfflineEl.style.display = 'none';
        } else if (total === 0) {
          btnConcludeDoneEl.disabled = false;
          btnConcludeDoneEl.textContent = 'No Turns Recorded. Done';
          btnConcludeDoneEl.style.background = '#334155';
          concludeWarningEl.innerHTML = 'Session concluded with no audio recordings.';
        } else {
          // Upload is actively in-flight or pending - keep button disabled!
          btnConcludeDoneEl.disabled = true;
          btnConcludeDoneEl.style.background = '#334155';
          const activeIdx = activeUploadingTurn ? activeUploadingTurn.turn_index : pendingSessionTurns[0].turn_index;
          btnConcludeDoneEl.textContent = `⏳ Uploading Turn ${activeIdx} of ${total} (${uploaded}/${total} synced)...`;

          concludeWarningEl.style.background = 'rgba(245, 158, 11, 0.15)';
          concludeWarningEl.style.borderColor = '#f59e0b';
          concludeWarningEl.style.color = '#fbbf24';
          concludeWarningEl.innerHTML = `⚠️ <strong>DO NOT CLOSE SAFARI OR LOCK YOUR IPAD</strong> until all files are 100% uploaded to your Mac (${pendingSessionTurns.length} pending).`;

          // If concluding has been waiting > 6s, show Force Retry button
          if (Date.now() - concludeStartTime > 6000 && btnConcludeRetryEl) {
            btnConcludeRetryEl.style.display = 'block';
          }

          // If concluding has been waiting > 10s, offer Hung exit button
          if (Date.now() - concludeStartTime > 10000 && pendingSessionTurns.length > 0) {
            if (btnConcludeOfflineEl) {
              btnConcludeOfflineEl.style.display = 'block';
              btnConcludeOfflineEl.textContent = `⚠️ Appears Hung? Exit App (${pendingSessionTurns.length} turn(s) saved on iPad)`;
            }
          }
        }
      };
    } catch (e) {
      console.warn('Conclude poll error:', e);
    }
  }, 1000);

  // Notify server of conclusion with full session turns from IndexedDB
  try {
    let sessionTurns = [];
    if (db) {
      sessionTurns = await new Promise(resolve => {
        try {
          const tx = db.transaction('turns', 'readonly');
          const store = tx.objectStore('turns');
          const req = store.getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            resolve(all.filter(t => t.session_id === sessionId).map(t => ({
              cardId: t.card_id,
              cardPrompt: t.card_prompt,
              question: t.card_prompt,
              transcript: t.transcript || '',
              isFreeform: !!t.is_freeform,
              sourceFile: t.card_source
            })));
          };
          req.onerror = () => resolve([]);
        } catch (err) {
          resolve([]);
        }
      });
    }

    await fetch('/api/mobile/conclude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, turns_count: turnIndex, turns: sessionTurns })
    });
  } catch (e) {
    console.warn('Failed to notify server of conclusion:', e);
  }
}

// Card Actions: Skip and Dismiss
function skipCard() {
  if (!currentDeck.length) return;
  const skippedCard = currentDeck.splice(currentCardIndex, 1)[0];
  currentDeck.push(skippedCard);
  renderCurrentCard();
}

async function dismissCard() {
  if (!currentDeck.length) return;
  const dismissedCard = currentDeck.splice(currentCardIndex, 1)[0];
  renderCurrentCard();

  try {
    await fetch('/api/mobile/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: dismissedCard.id, reason: 'irrelevant' })
    });
  } catch (e) {
    // ignore
  }
}

// Quick Brain Dump (insert unprompted card at current position)
function triggerQuickDump() {
  const dumpCard = {
    id: `quick-dump-${Date.now()}`,
    type: 'freeform',
    badge: 'UNPROMPTED DUMP',
    question: 'Speak freely. What realization, strategic tension, or friction is on your mind?',
    context: 'Autonomous extraction will parse decisions, entities, and Master Dossier updates.',
    is_freeform: true
  };
  currentDeck.splice(currentCardIndex, 0, dumpCard);
  renderCurrentCard();
  startRecording();
}

// Event Listeners
btnRecordEl.addEventListener('click', startRecording);
btnFinishTurnEl.addEventListener('click', () => finishTurn(false));
btnPauseEl.addEventListener('click', pauseOrResumeRecording);
btnSkipEl.addEventListener('click', skipCard);
btnDismissEl.addEventListener('click', dismissCard);
btnConcludeEl.addEventListener('click', concludeSession);
btnQuickDumpEl.addEventListener('click', triggerQuickDump);

function startSessionFromModal() {
  passengerModalEl.style.display = 'none';
  if (!localStorage.getItem('madrone_session_id')) {
    sessionId = `session_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`;
    localStorage.setItem('madrone_session_id', sessionId);
  }
  startSessionTimer();
  loadDeck();
  drainUploadQueue(true);
}

document.getElementById('btn-passenger-confirm').addEventListener('click', startSessionFromModal);

if (btnPassengerBypassEl) {
  btnPassengerBypassEl.addEventListener('click', startSessionFromModal);
}

if (btnPassengerDiscardStuckEl) {
  btnPassengerDiscardStuckEl.addEventListener('click', async () => {
    if (!confirm('Discard unuploaded recordings from your previous session? This cannot be undone.')) return;
    try {
      if (!db) await initDatabase();
      const tx = db.transaction('turns', 'readwrite');
      const store = tx.objectStore('turns');
      const req = store.getAll();
      req.onsuccess = () => {
        const turns = req.result || [];
        turns.forEach(t => {
          if (t.status === 'queued' || t.status === 'error' || t.status === 'failed') {
            t.status = 'discarded';
            store.put(t);
          }
        });
        if (passengerSyncStatusEl) {
          passengerSyncStatusEl.innerHTML = '✅ Stuck queue discarded. Storage cleared.';
        }
        if (btnPassengerBypassEl) btnPassengerBypassEl.style.display = 'none';
        if (passengerSyncActionsEl) passengerSyncActionsEl.style.display = 'none';
        btnPassengerConfirmEl.disabled = false;
        btnPassengerConfirmEl.textContent = 'Start Session';
        checkPendingTurnsCount();
      };
    } catch (e) {
      console.warn('Failed to discard stuck turns:', e);
    }
  });
}

if (btnConcludeRetryEl) {
  btnConcludeRetryEl.addEventListener('click', () => {
    btnConcludeRetryEl.textContent = '⏳ Retrying uploads...';
    btnConcludeRetryEl.disabled = true;
    isDraining = false;
    drainUploadQueue(true);
    setTimeout(() => {
      btnConcludeRetryEl.textContent = '🔄 Force Retry Upload Now';
      btnConcludeRetryEl.disabled = false;
    }, 2500);
  });
}

if (btnConcludeOfflineEl) {
  btnConcludeOfflineEl.addEventListener('click', () => {
    const confirmExit = confirm(
      'Notice: Any unuploaded audio recordings are safely preserved in local storage on this iPad.\n\n' +
      'They will NOT be lost. They will automatically upload to your Mac next time you open Context on this iPad while connected to Wi-Fi.\n\n' +
      'Exit now and lock iPad?'
    );
    if (!confirmExit) return;

    if (concludePollInterval) clearInterval(concludePollInterval);
    localStorage.removeItem('madrone_session_id');
    localStorage.removeItem('madrone_turn_index');
    localStorage.removeItem('madrone_card_index');
    window.location.reload();
  });
}

document.getElementById('btn-conclude-done').addEventListener('click', () => {
  if (concludePollInterval) clearInterval(concludePollInterval);
  localStorage.removeItem('madrone_session_id');
  localStorage.removeItem('madrone_turn_index');
  localStorage.removeItem('madrone_card_index');
  window.location.reload();
});

statusBadgeEl.style.cursor = 'pointer';
statusBadgeEl.addEventListener('click', () => {
  isDraining = false;
  drainUploadQueue(true);
});

const btnBannerSync = document.getElementById('btn-banner-sync');
if (btnBannerSync) {
  btnBannerSync.addEventListener('click', () => {
    isDraining = false;
    drainUploadQueue(true);
  });
}

window.addEventListener('online', () => drainUploadQueue(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    drainUploadQueue(true);
  }
});

// Periodic auto-sync every 4 seconds
setInterval(() => drainUploadQueue(true), 4000);

// App Startup
(async function init() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/mobile/sw.js');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }
  await initDatabase();
  
  // Environment detection
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const bannerTextEl = document.getElementById('sync-banner-text');
  if (!isStandalone && bannerTextEl) {
    bannerTextEl.innerHTML = '<span style="color: #f59e0b;">Safari View:</span> Open the "Context" Home Screen icon if you recorded there.';
  }

  // Restore session if present
  sessionId = localStorage.getItem('madrone_session_id') || `session_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`;
  turnIndex = parseInt(localStorage.getItem('madrone_turn_index') || '0', 10);
  currentCardIndex = parseInt(localStorage.getItem('madrone_card_index') || '0', 10);

  // Safety pre-flight check before allowing session start
  passengerModalEl.style.display = 'flex';
  btnPassengerConfirmEl.disabled = true;
  if (passengerSyncStatusEl) {
    passengerSyncStatusEl.innerHTML = 'Connecting to John\'s MacBook Air and verifying local storage...';
  }

  // Grace timer: regardless of queue state, NEVER lock the user out for more than 3.5 seconds
  const autoUnlockTimer = setTimeout(() => {
    enablePassengerStart(true);
  }, 3500);

  // Check storage and connectivity
  try {
    const tx = db.transaction('turns', 'readonly');
    const store = tx.objectStore('turns');
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const turns = allReq.result || [];
      const pendingTurns = turns.filter(t => t.status !== 'uploaded' && t.status !== 'discarded' && t.status !== 'corrupted_empty');
      if (pendingTurns.length > 0) {
        if (passengerSyncStatusEl) {
          passengerSyncStatusEl.innerHTML = `⚠️ <strong>${pendingTurns.length} recording(s) from previous session syncing...</strong>`;
        }
        if (btnPassengerBypassEl) btnPassengerBypassEl.style.display = 'block';
        if (passengerSyncActionsEl) passengerSyncActionsEl.style.display = 'flex';
        drainUploadQueue(true);

        // Monitor upload completion
        const waitInterval = setInterval(() => {
          const checkTx = db.transaction('turns', 'readonly');
          const checkReq = checkTx.objectStore('turns').getAll();
          checkReq.onsuccess = () => {
            const all = checkReq.result || [];
            const remaining = all.filter(t => t.status !== 'uploaded' && t.status !== 'discarded' && t.status !== 'corrupted_empty').length;
            if (remaining === 0) {
              clearInterval(waitInterval);
              clearTimeout(autoUnlockTimer);
              enablePassengerStart(false);
            } else if (passengerSyncStatusEl) {
              passengerSyncStatusEl.innerHTML = `⚠️ <strong>${remaining} recording(s) from previous session syncing while app is open...</strong>`;
            }
          };
        }, 1500);
      } else {
        clearTimeout(autoUnlockTimer);
        enablePassengerStart(false);
      }
    };
  } catch (e) {
    clearTimeout(autoUnlockTimer);
    enablePassengerStart(false);
  }

  function enablePassengerStart(isBackgroundSync = false) {
    if (isBackgroundSync) {
      if (passengerSyncStatusEl) {
        passengerSyncStatusEl.innerHTML = '⚡ Ready. Any pending audio will continue syncing while app is open.';
      }
      btnPassengerConfirmEl.disabled = false;
      btnPassengerConfirmEl.textContent = 'Start Session';
      if (btnPassengerBypassEl) btnPassengerBypassEl.style.display = 'none';
    } else {
      if (passengerSyncStatusEl) {
        passengerSyncStatusEl.innerHTML = '✅ Connected to John\'s MacBook Air. Storage verified.';
      }
      btnPassengerConfirmEl.disabled = false;
      btnPassengerConfirmEl.textContent = 'Start Session';
      if (btnPassengerBypassEl) btnPassengerBypassEl.style.display = 'none';
      if (passengerSyncActionsEl) passengerSyncActionsEl.style.display = 'none';
    }
  }

  checkPendingTurnsCount();
  drainUploadQueue(true);
})();
