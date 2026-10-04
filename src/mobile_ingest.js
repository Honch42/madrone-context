'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const config = require('./config');
const prompts = require('./prompts');
const { TranscriptAssembler } = require('./transcript_assembler');
const { getLexicon } = require('./lexicon');
const { classifySensitivity, getPrivateDir } = require('./sensitivity_router');
const { reconcileStance } = require('./stance');
const { computeAdjudicationStatus } = require('./slot_tracker');
const { evaluateAssumptions } = require('./assumption_engine');
const { reconcileSessionMath } = require('./reconcile');
const { detectUncertainties, surfaceUncertaintiesToDeskQueue } = require('./uncertainty_detector');

function extractFrontmatter(content) {
  if (!content) return {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const res = {};
  const lines = fmMatch[1].split('\n');
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (match) {
      let key = match[1].trim();
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      res[key] = val;
    }
  }
  return res;
}

const processedTurns = new Map();
const sessionHeaders = new Map();
const sessionTurnsMap = new Map();

/**
 * Ensures a directory exists synchronously.
 */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Sanitizes path component to prevent traversal.
 */
function sanitizePathComponent(val, fallback = 'unknown') {
  if (!val) return fallback;
  const clean = String(val).replace(/\.\./g, '').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('.')) return fallback;
  return clean;
}


/**
 * Atomically writes data to disk on the same filesystem.
 */
function writeFileSyncAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Extracts fenced or unfenced JSON safely.
 */
function parseJsonSafe(text) {
  if (!text) return null;
  let clean = text.trim();
  const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) clean = match[1].trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

/**
 * Resolves the raw dumps inbox directory in the workspace.
 */
function getRawDumpsDir(workspaceDir) {
  const candidates = [
    path.join(workspaceDir, '00_Inbox', 'Raw_Dumps'),
    path.join(workspaceDir, '_Inbox', 'Raw_Dumps')
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) {
      ensureDir(c);
      return c;
    }
  }
  const fallback = path.join(workspaceDir, '_Inbox', 'Raw_Dumps');
  ensureDir(fallback);
  return fallback;
}

/**
 * Resolves the staged deltas directory in the workspace.
 */
function getStagedDeltasDir(workspaceDir) {
  const p = path.join(workspaceDir, '_Inbox', 'Staged_Dossier_Deltas');
  ensureDir(p);
  return p;
}

/**
 * Path of the Master Dossier that staged deltas are applied against.
 */
function getDossierPath(workspaceDir) {
  return path.join(workspaceDir, 'Core', 'master_dossier.md');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * SHA256 of the current Master Dossier, or null when it does not exist yet.
 * Recorded on staged deltas as `base_hash` so a commit can detect that the
 * dossier moved underneath a pending review.
 */
function computeDossierHash(workspaceDir) {
  const p = getDossierPath(workspaceDir);
  if (!fs.existsSync(p)) return null;
  try {
    return sha256Hex(fs.readFileSync(p));
  } catch (e) {
    return null;
  }
}

/**
 * Returns the cached result for an already-processed turn (fast ack or full
 * synthesis, whichever is latest), or null if the turn has not been seen.
 */
function getCachedTurn(sessionId, turnId) {
  if (!turnId) return null;
  const key = `${sanitizePathComponent(sessionId, 'mobile-session')}:${sanitizePathComponent(turnId, 'turn')}`;
  return processedTurns.get(key) || null;
}

/**
 * Handles incoming audio turn from mobile client.
 */
async function processTurn({
  sessionId,
  cardId,
  turnIndex,
  turnId,
  audioBuffer,
  mimeType = 'audio/mp4',
  durationSeconds = 0,
  isFreeform = false,
  cardPrompt = '',
  cardSourceFile = '',
  provider,
  ctxSettings,
  waitForSynthesis = true
}) {
  const safeSessionId = sanitizePathComponent(sessionId, 'mobile-session');
  const safeCardId = sanitizePathComponent(cardId, 'card');
  const safeTurnIndex = parseInt(turnIndex, 10) || 0;
  const safeTurnId = sanitizePathComponent(turnId || `${safeSessionId}_${safeTurnIndex}`, 'turn');

  if (!audioBuffer || audioBuffer.length === 0) {
    return { ok: false, error: 'Empty audio buffer', code: 'EMPTY_PAYLOAD' };
  }

  // Idempotency check: if turn was already processed, return cached output
  const idempotencyKey = `${safeSessionId}:${safeTurnId}`;
  if (processedTurns.has(idempotencyKey)) {
    return processedTurns.get(idempotencyKey);
  }

  const settings = ctxSettings || config.getSettings();
  const workspace = settings.workspaceDir || storage.defaultWorkspace();
  const now = new Date();

  // 1. Archive raw media to local archives
  let ext = 'mp4';
  if (mimeType.includes('webm')) ext = 'webm';
  else if (mimeType.includes('aac')) ext = 'aac';
  else if (mimeType.includes('wav')) ext = 'wav';

  // Fix fragmented MP4 if header is missing
  let finalAudioBuffer = audioBuffer;
  if (ext === 'mp4' && audioBuffer && audioBuffer.length >= 8) {
    const tag = audioBuffer.slice(4, 8).toString('latin1');
    if (tag === 'ftyp') {
      const moofIdx = audioBuffer.indexOf(Buffer.from('moof'));
      if (moofIdx >= 4) {
        sessionHeaders.set(safeSessionId, audioBuffer.slice(0, moofIdx - 4));
      }
    } else if (tag === 'moof') {
      const cached = sessionHeaders.get(safeSessionId);
      if (cached) {
        finalAudioBuffer = Buffer.concat([cached, audioBuffer]);
      }
    }
  }

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const mediaDir = path.join(settings.mediaDir || workspace, 'archives', yyyy, mm);
  ensureDir(mediaDir);
  const mediaFilename = `${safeSessionId}_turn_${safeTurnIndex}_${safeCardId}.${ext}`;
  const mediaPath = path.join(mediaDir, mediaFilename);
  fs.writeFileSync(mediaPath, finalAudioBuffer);

  // Durable per-session JSONL write: record turn receipt immediately
  const sessionDir = path.join(workspace, 'Core', 'Sessions');
  ensureDir(sessionDir);
  const sessionJsonlPath = path.join(sessionDir, `${safeSessionId}_turns.jsonl`);

  const initialRecord = {
    sessionId: safeSessionId,
    turnId: safeTurnId,
    turnIndex: safeTurnIndex,
    cardId: safeCardId,
    prompt_card_id: safeCardId === 'freeform' ? null : safeCardId,
    cardPrompt,
    duration_s: Number(durationSeconds) || 0,
    transcript: '[Transcription in progress...]',
    modelUsed: 'pending',
    isFreeform,
    durationSeconds,
    mediaFilename,
    timestamp: now.toISOString(),
    status: 'received',
    answer_status: null
  };

  try {
    let exists = false;
    if (fs.existsSync(sessionJsonlPath)) {
      const existingText = fs.readFileSync(sessionJsonlPath, 'utf-8');
      if (existingText.includes(`"turnId":"${safeTurnId}"`)) exists = true;
    }
    if (!exists) {
      fs.appendFileSync(sessionJsonlPath, JSON.stringify(initialRecord) + '\n', 'utf-8');
    }
  } catch (err) {
    console.error('[mobile_ingest] Error appending initial turn record:', err.message);
  }

  // Full AI synthesis worker function (handles transcription + oneShot extraction + reconciliation)
  async function runSynthesis() {
    let transcript = '';
    let modelUsed = 'gemini-flash-latest';
    if (provider && typeof provider.transcribe === 'function') {
      try {
        const tRes = await provider.transcribe(finalAudioBuffer, mimeType);
        if (typeof tRes === 'object' && tRes !== null) {
          transcript = tRes.transcript || '';
          modelUsed = tRes.model || 'gemini-flash-latest';
        } else {
          transcript = String(tRes || '');
          modelUsed = 'gemini-flash-latest';
        }
      } catch (e) {
        transcript = `[Transcription failed: ${e.message}]`;
      }
    } else {
      transcript = '[Audio archived. Transcription provider not configured.]';
    }

    // Apply domain lexicon post-correction
    const lex = getLexicon();
    const correctedRes = lex.postCorrect(transcript);
    transcript = correctedRes.text;

    // Check sensitivity (health, medications, etc.)
    const sensitivity = classifySensitivity(transcript);

    let extraction = null;
    let dumpNotePath = null;

    if (isFreeform) {
      if (provider && typeof provider.oneShot === 'function') {
        try {
          const rawExtraction = await provider.oneShot(prompts.brainDumpExtractionPrompt(transcript));
          extraction = parseJsonSafe(rawExtraction);
        } catch (e) {
          console.warn('[mobile_ingest] Freeform extraction error:', e.message);
        }
      }
      if (!extraction) {
        extraction = {
          title: 'Unprompted Brain Dump',
          summary: transcript.slice(0, 150) + '...',
          decisions: [],
          people: [],
          projects: [],
          topics: [],
          dossier_updates: [],
          follow_up_questions: []
        };
      }

      const isPrivateHealth = sensitivity.isSensitive && sensitivity.level === 'private';
      const dumpsDir = isPrivateHealth ? getPrivateDir(workspace) : getRawDumpsDir(workspace);
      const dateSlug = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const safeTitle = (extraction.title || 'brain_dump').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
      const noteFilename = `${dateSlug}_${safeTitle}.md`;
      dumpNotePath = path.join(dumpsDir, noteFilename);

      const noteLines = [
        '---',
        `title: "${extraction.title || 'Unprompted Brain Dump'}"`,
        `date: ${now.toISOString()}`,
        `source: mobile_dump`,
        `session_id: "${safeSessionId}"`,
        `turn_index: ${safeTurnIndex}`,
        `turn_id: "${safeTurnId}"`,
        `duration_seconds: ${durationSeconds}`,
        `media_archive: "${mediaFilename}"`,
        `verified: false`,
        `sensitivity: "${sensitivity.level}"`,
        '---',
        '',
        `# ${extraction.title || 'Unprompted Brain Dump'}`,
        '',
        '## Executive Summary',
        extraction.summary || '(none)',
        ''
      ];

      if (extraction.decisions && extraction.decisions.length) {
        noteLines.push('## Decisions & Realizations');
        extraction.decisions.forEach(d => noteLines.push(`- ${d}`));
        noteLines.push('');
      }

      const entities = [];
      (extraction.people || []).forEach(p => entities.push(`[[${p.name}]] (Person: ${p.note || ''})`));
      (extraction.projects || []).forEach(pr => entities.push(`[[${pr.name}]] (Project: ${pr.note || ''})`));
      (extraction.topics || []).forEach(t => entities.push(`[[${t.name}]] (Topic: ${t.note || ''})`));
      if (entities.length) {
        noteLines.push('## Mentioned Entities');
        entities.forEach(e => noteLines.push(`- ${e}`));
        noteLines.push('');
      }

      if (extraction.dossier_updates && extraction.dossier_updates.length) {
        noteLines.push('## Candidate Master Dossier Updates');
        extraction.dossier_updates.forEach(u => noteLines.push(`- ${u}`));
        noteLines.push('');
      }

      if (extraction.follow_up_questions && extraction.follow_up_questions.length) {
        noteLines.push('## Follow-Up Seed Questions');
        extraction.follow_up_questions.forEach(q => noteLines.push(`- ${q}`));
        noteLines.push('');
      }

      noteLines.push('## Raw Transcript', transcript);
      writeFileSyncAtomic(dumpNotePath, noteLines.join('\n'));

      // Stage candidate dossier deltas ONLY if not private health data
      if (extraction.dossier_updates && extraction.dossier_updates.length && !isPrivateHealth) {
        const stagedDir = getStagedDeltasDir(workspace);
        const stagedFile = path.join(stagedDir, `${dateSlug}_${safeTitle}.json`);
        writeFileSyncAtomic(stagedFile, JSON.stringify({
          source_note: dumpNotePath,
          created_at: now.toISOString(),
          base_file: 'Core/master_dossier.md',
          base_hash: computeDossierHash(workspace),
          title: extraction.title,
          dossier_updates: extraction.dossier_updates,
          decisions: extraction.decisions || [],
          human_reviewed: false
        }, null, 2));
      }

      // Surface unverified assumptions or novel tokens from freeform brain dump
      const turnAssumptions = evaluateAssumptions(transcript);
      const turnUncertainties = detectUncertainties({
        transcript,
        extraction,
        assumptions: turnAssumptions
      });
      surfaceUncertaintiesToDeskQueue(workspace, safeSessionId, turnUncertainties);
    }

    // Reconcile and update session JSONL with completed synthesis
    const finalRecord = {
      sessionId: safeSessionId,
      turnId: safeTurnId,
      turnIndex: safeTurnIndex,
      cardId: safeCardId,
      prompt_card_id: safeCardId === 'freeform' ? null : safeCardId,
      cardPrompt,
      duration_s: Number(durationSeconds) || 0,
      transcript,
      modelUsed,
      isFreeform,
      durationSeconds,
      mediaFilename,
      timestamp: now.toISOString(),
      status: 'synthesized'
    };

    try {
      if (fs.existsSync(sessionJsonlPath)) {
        const rows = fs.readFileSync(sessionJsonlPath, 'utf-8').split('\n').filter(Boolean);
        let replaced = false;
        for (let i = 0; i < rows.length; i++) {
          try {
            const parsed = JSON.parse(rows[i]);
            if (parsed.turnId === safeTurnId || (parsed.sessionId === safeSessionId && parsed.turnIndex === safeTurnIndex)) {
              rows[i] = JSON.stringify(finalRecord);
              replaced = true;
              break;
            }
          } catch (e) {}
        }
        if (!replaced) rows.push(JSON.stringify(finalRecord));
        writeFileSyncAtomic(sessionJsonlPath, rows.join('\n') + '\n');
      }
    } catch (err) {
      console.error('[mobile_ingest] Error updating session JSONL:', err.message);
    }

    const res = {
      ok: true,
      sessionId: safeSessionId,
      cardId: safeCardId,
      turnIndex: safeTurnIndex,
      turnId: safeTurnId,
      transcript,
      mediaPath,
      extraction,
      dumpNotePath
    };
    processedTurns.set(idempotencyKey, res);
    return res;
  }

  // Synthesis is spawned immediately with guaranteed error capture
  const synthesisPromise = runSynthesis();
  synthesisPromise.catch(err => {
    console.error(`[mobile_ingest] Background synthesis error for turn ${safeTurnId}:`, err);
  });

  if (waitForSynthesis !== false) {
    return await synthesisPromise;
  }

  // Fast-path: return sub-second acknowledgment so mobile client never times out
  const fastAck = {
    ok: true,
    saved: true,
    sessionId: safeSessionId,
    cardId: safeCardId,
    turnIndex: safeTurnIndex,
    turnId: safeTurnId,
    mediaPath,
    status: 'received'
  };
  processedTurns.set(idempotencyKey, fastAck);
  return fastAck;

  // Record into in-memory session turns map
  if (!sessionTurnsMap.has(safeSessionId)) {
    sessionTurnsMap.set(safeSessionId, []);
  }
  const sTurns = sessionTurnsMap.get(safeSessionId);
  const existingIdx = sTurns.findIndex(t => t.turnIndex === safeTurnIndex);
  const turnSummary = {
    cardId: safeCardId,
    question: cardPrompt,
    cardPrompt,
    transcript,
    isFreeform,
    sourceFile: cardSourceFile,
    cardSourceFile,
    turnIndex: safeTurnIndex
  };
  if (existingIdx >= 0) sTurns[existingIdx] = turnSummary;
  else sTurns.push(turnSummary);

  return result;
}

/**
 * Concludes a mobile drive session and compiles the session dossier.
 */
async function concludeDriveSession({
  sessionId,
  turns = [],
  ctxSettings,
  provider
}) {
  const safeSessionId = sanitizePathComponent(sessionId, 'mobile-session');
  const settings = ctxSettings || config.getSettings();
  const workspace = settings.workspaceDir || storage.defaultWorkspace();
  const now = new Date();

  const paths = storage.sessionPaths(settings, safeSessionId, now);
  storage.ensureDirs(paths);

  // 1. Recover turns from durable turns.jsonl on disk
  const sessionDir = path.join(workspace, 'Core', 'Sessions');
  const sessionJsonlPath = path.join(sessionDir, `${safeSessionId}_turns.jsonl`);
  const diskTurns = [];
  if (fs.existsSync(sessionJsonlPath)) {
    try {
      const lines = fs.readFileSync(sessionJsonlPath, 'utf-8').split('\n');
      let corruptCount = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          diskTurns.push(JSON.parse(line));
        } catch (e) {
          corruptCount++;
        }
      }
      if (corruptCount > 0) {
        console.warn(`[mobile_ingest] Recovered ${diskTurns.length} turns, skipped ${corruptCount} corrupt/truncated lines in ${sessionJsonlPath}`);
      }
    } catch (e) {
      console.error(`[mobile_ingest] Failed reading durable session log ${sessionJsonlPath}:`, e.message);
    }
  }

  // Reconcile client turns with durable disk turns by turnId
  const reconciledMap = new Map();
  for (const dt of diskTurns) {
    reconciledMap.set(dt.turnId || `turn_${dt.turnIndex}`, {
      cardId: dt.cardId,
      question: dt.cardPrompt,
      transcript: dt.transcript,
      isFreeform: dt.isFreeform,
      turnIndex: dt.turnIndex
    });
  }
  for (const ct of turns) {
    const key = ct.turnId || ct.turn_id || `turn_${ct.turnIndex || ct.turn_index}`;
    if (!reconciledMap.has(key)) {
      reconciledMap.set(key, {
        cardId: ct.cardId || ct.card_id,
        question: ct.question || ct.cardPrompt || ct.card_prompt,
        transcript: ct.transcript || '',
        isFreeform: !!(ct.isFreeform || ct.is_freeform),
        turnIndex: ct.turnIndex || ct.turn_index || 0
      });
    }
  }

  const qna = Array.from(reconciledMap.values()).sort((a, b) => (a.turnIndex || 0) - (b.turnIndex || 0));

  const transcriptLines = [];
  for (const item of qna) {
    if (item.isFreeform) {
      transcriptLines.push(`### Unprompted Dump\n${item.transcript}\n`);
    } else {
      transcriptLines.push(`### Q: ${item.question}\n**A:** ${item.transcript}\n`);
    }
  }

  let summary = 'Capture session concluded.';
  if (qna.length > 0 && provider) {
    try {
      const synthesisPrompt = `You are summarizing a spoken context capture session.
Synthesize the primary realizations, decisions, and strategic updates into clean Markdown.

Session Turns:
${transcriptLines.join('\n')}

Output ONLY Markdown starting with "## Executive Summary".`;
      summary = await provider.oneShot(synthesisPrompt);
    } catch (e) {
      summary = `## Executive Summary\nSession recorded ${qna.length} turns.`;
    }
  }

  // Cross-turn analysis
  const allTurnsText = qna.map(it => it.transcript || '').join(' ');
  const mathIssues = reconcileSessionMath(qna);
  const sessionAssumptions = evaluateAssumptions(allTurnsText);
  const uncertainties = detectUncertainties({
    transcript: allTurnsText,
    assumptions: sessionAssumptions
  });
  const generatedClarificationCards = surfaceUncertaintiesToDeskQueue(workspace, safeSessionId, uncertainties);

  const analysisSections = [];
  if (sessionAssumptions.length > 0) {
    analysisSections.push('\n## Strategic & Tax Assumptions to Verify');
    sessionAssumptions.forEach(a => {
      analysisSections.push(`- **[${a.domain.toUpperCase()}] ${a.flag}**: ${a.note}\n  *Suggested follow-up: "${a.followUp}"*`);
    });
  }

  if (mathIssues.length > 0) {
    analysisSections.push('\n## Financial & Allocation Discrepancies');
    mathIssues.forEach(m => {
      analysisSections.push(`- **${m.id}**: ${m.note}\n  *Suggested follow-up: "${m.followUp}"*`);
    });
  }

  const sessionNoteLines = [
    '---',
    `session_id: "${safeSessionId}"`,
    `type: "session"`,
    `date: ${now.toISOString()}`,
    `verified_by: "staged_for_review"`,
    `total_turns: ${qna.length}`,
    '---',
    '',
    `# Session: ${safeSessionId}`,
    '',
    summary,
    ...analysisSections,
    '',
    '## Detailed Q&A Log',
    ...transcriptLines
  ];

  const notePath = paths.notePath.replace(/_session\.md$/, '_drive_session.md');
  writeFileSyncAtomic(notePath, sessionNoteLines.join('\n'));

  // Stage hypothesis resolutions via server-side file resolution
  const stagedHypotheses = [];
  const hypothesesDirs = [
    path.join(workspace, '_Inbox', 'Agent_Hypotheses'),
    path.join(workspace, '00_Inbox', 'Agent_Hypotheses')
  ];

  for (const item of qna) {
    if (item.isFreeform || !item.cardId) continue;

    // Quality gate: require substantive answer (>20 chars, not a refusal/skip)
    const tLower = (item.transcript || '').trim().toLowerCase();
    if (tLower.length < 20 || /^(skip|next|pass|no comment|i don't know|idk|not sure)\b/.test(tLower)) {
      continue;
    }

    // Server-side path lookup
    let hypPath = null;
    let cardFm = {};
    for (const hDir of hypothesesDirs) {
      if (!fs.existsSync(hDir)) continue;
      const files = fs.readdirSync(hDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const full = path.join(hDir, file);
        try {
          const c = fs.readFileSync(full, 'utf-8');
          const fm = extractFrontmatter(c);
          if (fm.id === item.cardId || file.replace(/\.md$/, '') === item.cardId || file.includes(item.cardId)) {
            hypPath = full;
            cardFm = fm;
            break;
          }
        } catch (e) {}
      }
      if (hypPath) break;
    }

    if (hypPath && fs.existsSync(hypPath)) {
      try {
        const hypContent = fs.readFileSync(hypPath, 'utf-8');
        const turnAssumptions = evaluateAssumptions(item.transcript);
        const statusRes = computeAdjudicationStatus({
          card: { id: item.cardId, question: item.question, expects: cardFm.expects || {} },
          transcript: item.transcript,
          contradictions: mathIssues
        });
        const stanceRes = reconcileStance(null, item.transcript);

        const updateData = {
          file: hypPath,
          card_id: item.cardId,
          verdict: statusRes.status,
          status: statusRes.status,
          stance: stanceRes.stance,
          missingSlots: statusRes.missingSlots,
          assumptions: turnAssumptions,
          transcript: item.transcript,
          session_note: notePath
        };
        stagedHypotheses.push(updateData);

        if (!hypContent.includes('staged_adjudication:')) {
          const cleanSummary = item.transcript.slice(0, 160).replace(/["\n\r]/g, ' ').trim();
          const adjudicationYaml = [
            'staged_adjudication:',
            `  status: "${statusRes.status}"`,
            `  verdict: "${statusRes.status}"`,
            `  stance: "${stanceRes.stance}"`,
            `  summary: "${cleanSummary}..."`,
            `  session_id: "${safeSessionId}"`,
            `  missing_slots: ${JSON.stringify(statusRes.missingSlots || [])}`,
            `  assumptions_flagged: ${JSON.stringify(turnAssumptions.map(a => a.id))}`,
            '  human_reviewed: false'
          ].join('\n');

          const updatedHyp = hypContent.replace(/^---\n/, `---\nstatus: "${statusRes.status}"\n${adjudicationYaml}\n`);
          writeFileSyncAtomic(hypPath, updatedHyp);
        }
      } catch (e) {
        console.warn(`[mobile_ingest] Failed to update hypothesis ${hypPath}:`, e.message);
      }
    }
  }

  // Phase 2: Write offline distillation queue marker
  const distillationsDir = path.join(workspace, '_Inbox', 'Distillations');
  ensureDir(distillationsDir);
  const pendingMarkerPath = path.join(distillationsDir, `${safeSessionId}.pending`);
  try {
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    writeFileSyncAtomic(pendingMarkerPath, JSON.stringify({
      sessionId: safeSessionId,
      queuedAt: now.toISOString(),
      turnsCount: turns.length,
      expected_turns: turns.length,
      last_turn_id: lastTurn ? (lastTurn.turnId || lastTurn.turn || null) : null,
      notePath
    }, null, 2));
  } catch (err) {
    console.warn('[mobile_ingest] Failed to write distillation pending marker:', err.message);
  }

  return {
    ok: true,
    sessionId: safeSessionId,
    notePath,
    turnsCount: turns.length,
    stagedHypotheses,
    uncertainties,
    generatedClarificationCards
  };
}

/**
 * Logs dismissed card feedback.
 */
function logDismissedFeedback(workspaceDir, cardId, reason = 'irrelevant') {
  const p = path.join(workspaceDir, '_Inbox', 'Dismissed_Feedback.jsonl');
  ensureDir(path.dirname(p));
  const entry = {
    card_id: cardId,
    dismissed_at: new Date().toISOString(),
    reason
  };
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
  return { ok: true, logged: entry };
}

/**
 * Lists pending staged items for desktop review.
 */
function listStagedItems(workspaceDir) {
  const stagedDir = getStagedDeltasDir(workspaceDir);
  const items = [];
  if (fs.existsSync(stagedDir)) {
    const files = fs.readdirSync(stagedDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(stagedDir, f), 'utf-8'));
        items.push({ id: f, ...content });
      } catch (e) {
        console.warn(`[mobile_ingest] Failed to parse staged file ${f}:`, e.message);
      }
    }
  }
  return items;
}

/**
 * Commits approved staged deltas to the Master Dossier and marks as reviewed.
 */
function commitStagedItem(workspaceDir, itemId, approvedDossierUpdates = [], options = {}) {
  const updates = Array.isArray(approvedDossierUpdates) ? approvedDossierUpdates : [];
  const safeItemId = sanitizePathComponent(itemId, '');
  const stagedDir = getStagedDeltasDir(workspaceDir);
  const itemPath = safeItemId ? path.join(stagedDir, safeItemId) : null;
  if (!itemPath || !fs.existsSync(itemPath) || !fs.statSync(itemPath).isFile()) {
    return { ok: false, code: 'NOT_FOUND', error: 'Item not found' };
  }

  let staged = {};
  try {
    staged = JSON.parse(fs.readFileSync(itemPath, 'utf-8')) || {};
  } catch (e) {
    staged = {};
  }

  const dossierPath = getDossierPath(workspaceDir);
  const currentHash = computeDossierHash(workspaceDir);
  const baseMoved = !!(staged.base_hash && currentHash && staged.base_hash !== currentHash);

  // Stale-base guard: the delta was reviewed against a specific dossier. If the
  // dossier changed since staging, refuse to append until the reviewer re-reads
  // it (or explicitly forces the commit).
  if (updates.length && baseMoved && !options.force) {
    return {
      ok: false,
      code: 'STALE_BASE',
      error: 'Master Dossier changed since this delta was staged; re-review before committing.',
      item_id: safeItemId,
      expected_base_hash: staged.base_hash,
      current_base_hash: currentHash
    };
  }

  if (updates.length && fs.existsSync(dossierPath)) {
    let existing = fs.readFileSync(dossierPath, 'utf-8');
    existing += `\n\n### Accretive Additions (${new Date().toISOString().slice(0, 10)})\n`;
    for (const u of updates) {
      existing += `- ${u}\n`;
    }
    writeFileSyncAtomic(dossierPath, existing);
  }

  try {
    fs.unlinkSync(itemPath);
  } catch (e) {
    console.warn(`[mobile_ingest] Could not unlink ${itemPath}:`, e.message);
  }

  return {
    ok: true,
    item_id: safeItemId,
    committed: updates.length,
    base_hash: staged.base_hash || null,
    new_base_hash: computeDossierHash(workspaceDir),
    forced: !!(options.force && baseMoved)
  };
}

module.exports = {
  processTurn,
  concludeSession: concludeDriveSession,
  concludeDriveSession,
  logDismissedFeedback,
  listStagedItems,
  commitStagedItem,
  getRawDumpsDir,
  getStagedDeltasDir,
  getDossierPath,
  computeDossierHash,
  getCachedTurn,
  sanitizePathComponent,
  writeFileSyncAtomic
};
