'use strict';

/**
 * Madrone Context Proposal Applier.
 * Enforces the auto-accept vs. human review gate matrix.
 * Hardened with structural evidence verification, idempotency checking,
 * reversibility diffs (before/after), and deck plan cache invalidation.
 * Logs all actions to _Inbox/Proposals/ledger.jsonl.
 */

const fs = require('fs');
const path = require('path');
const frontmatter = require('./frontmatter');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function getExistingProposalIds(workspaceDir) {
  const ledgerPath = path.join(workspaceDir, '_Inbox', 'Proposals', 'ledger.jsonl');
  const seen = new Set();
  if (fs.existsSync(ledgerPath)) {
    try {
      const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.proposal_id) seen.add(entry.proposal_id);
        } catch (e) {}
      }
    } catch (e) {}
  }
  return seen;
}

function appendLedger(workspaceDir, entry) {
  const proposalsDir = path.join(workspaceDir, '_Inbox', 'Proposals');
  ensureDir(proposalsDir);
  const ledgerPath = path.join(proposalsDir, 'ledger.jsonl');
  fs.appendFileSync(ledgerPath, JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString()
  }) + '\n', 'utf-8');
}

function findCardFile(hypothesesDir, target) {
  if (!fs.existsSync(hypothesesDir) || !target) return null;
  const files = fs.readdirSync(hypothesesDir).filter(f => f.endsWith('.md'));
  const byName = files.find(f => f.includes(target) || f.replace(/\.md$/, '') === target);
  if (byName) return path.join(hypothesesDir, byName);
  for (const f of files) {
    try {
      const full = path.join(hypothesesDir, f);
      const { meta } = frontmatter.parse(fs.readFileSync(full, 'utf-8'));
      if (meta && meta.id === target) return full;
    } catch (e) {}
  }
  return null;
}

/**
 * Loads session turns for structural evidence verification.
 */
function loadSessionTurns(workspaceDir, sessionId) {
  if (!sessionId) return [];
  const turnsPath = path.join(workspaceDir, 'Core', 'Sessions', `${sessionId}_turns.jsonl`);
  if (!fs.existsSync(turnsPath)) return [];
  try {
    return fs.readFileSync(turnsPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Applies a list of proposals from a distillation result.
 * @param {string} workspaceDir
 * @param {Array<object>} proposals
 * @param {object} [opts]
 * @returns {object}
 */
function applyProposals(workspaceDir, proposals = [], opts = {}) {
  const hypothesesDir = path.join(workspaceDir, '_Inbox', 'Agent_Hypotheses');
  const stagedDir = path.join(workspaceDir, '_Inbox', 'Staged_Dossier_Deltas');
  ensureDir(hypothesesDir);
  ensureDir(stagedDir);

  const existingProposals = getExistingProposalIds(workspaceDir);
  const sessionId = opts.sessionId || (proposals[0] && proposals[0].session_id);
  const sessionTurns = opts.sessionTurns || loadSessionTurns(workspaceDir, sessionId);

  let autoAccepted = 0;
  let stagedCount = 0;
  let skippedIdempotent = 0;
  let spawnedContradictions = 0;
  const spawnedContradictionPairs = new Set();

  for (const prop of proposals) {
    const { proposal_id, type, target, payload, evidence = [], confidence = 0, rationale = '' } = prop;

    // Idempotency check: skip already applied proposals
    if (proposal_id && existingProposals.has(proposal_id)) {
      skippedIdempotent++;
      continue;
    }

    // 1. Close Card: Structural evidence verification gate (P3-b)
    if (type === 'close_card' && target) {
      // Must verify target card was actually asked in this session
      const matchingTurn = sessionTurns.find(t => 
        t.cardId === target || 
        t.prompt_card_id === target ||
        (t.turnId && evidence.includes(t.turnId))
      );

      const hasStructuralEvidence = Boolean(matchingTurn);

      if (hasStructuralEvidence && confidence >= 0.8) {
        const fullPath = findCardFile(hypothesesDir, target);
        if (fullPath) {
          try {
            const rawContent = fs.readFileSync(fullPath, 'utf-8');
            const { meta, body } = frontmatter.parse(rawContent);
            const beforeState = { status: meta.status, answer_status: meta.answer_status, ask_count: meta.ask_count };
            
            meta.answer_status = 'answered';
            meta.status = 'resolved';
            meta.ask_count = Math.max(1, (meta.ask_count || 0) + 1);
            
            const afterState = { status: meta.status, answer_status: meta.answer_status, ask_count: meta.ask_count };
            fs.writeFileSync(fullPath, frontmatter.serialize(meta, body), 'utf-8');
            autoAccepted++;
            appendLedger(workspaceDir, {
              proposal_id,
              type,
              target,
              by: 'auto',
              confidence,
              rationale,
              before: beforeState,
              after: afterState
            });
            continue;
          } catch (e) {
            console.warn(`[proposal_applier] Failed to close card ${target}:`, e.message);
          }
        }
      }

      // If structural evidence check failed or confidence < 0.8, fall through to staged
    }

    // 2. Narrow Range: Auto-accepted with before/after reversibility (P3-d)
    if (type === 'narrow_range' && target && payload) {
      const fullPath = findCardFile(hypothesesDir, target);
      if (fullPath) {
        try {
          const rawContent = fs.readFileSync(fullPath, 'utf-8');
          const { meta, body } = frontmatter.parse(rawContent);
          const beforeRange = meta.range || meta.bounds || null;
          meta.range = payload.range || payload;
          const afterRange = meta.range;
          fs.writeFileSync(fullPath, frontmatter.serialize(meta, body), 'utf-8');
          autoAccepted++;
          appendLedger(workspaceDir, {
            proposal_id,
            type,
            target,
            by: 'auto',
            confidence,
            rationale,
            before: { range: beforeRange },
            after: { range: afterRange }
          });
          continue;
        } catch (e) {}
      }
    }

    // 3. Contradiction Probe: Cap at 2 per session, dedup by pair (P3-e)
    if (type === 'contradiction' && payload) {
      const pairKey = [payload.claim_a?.card_id || 'a', payload.claim_b?.card_id || 'b'].sort().join('_');
      if (spawnedContradictions < 2 && !spawnedContradictionPairs.has(pairKey)) {
        spawnedContradictions++;
        spawnedContradictionPairs.add(pairKey);
        const probeId = `probe_${Date.now().toString(36)}_${spawnedContradictions}`;
        const probeFile = path.join(hypothesesDir, `99_contradiction_${probeId}.md`);
        const cardMeta = {
          id: probeId,
          kind: 'contradiction_probe',
          status: 'open',
          answer_status: 'unasked',
          created: new Date().toISOString().slice(0, 10),
          source: 'distiller',
          priority: 0.85,
          evidence,
          rationale
        };
        const probeBody = `## Contradiction Probe\n\n**Claim A:** ${payload.claim_a?.text || ''}\n**Claim B:** ${payload.claim_b?.text || ''}\n\n**Question:** How should these two positions be reconciled?`;
        fs.writeFileSync(probeFile, frontmatter.serialize(cardMeta, probeBody), 'utf-8');
        autoAccepted++;
        appendLedger(workspaceDir, {
          proposal_id,
          type,
          target: probeId,
          by: 'auto',
          confidence,
          rationale,
          before: null,
          after: { card_id: probeId }
        });
        continue;
      }
    }

    // 4. Staged items: core_fact, retire_card, supersede_card, unverified close_card
    const deltaId = `delta_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const deltaPath = path.join(stagedDir, `${deltaId}.json`);
    fs.writeFileSync(deltaPath, JSON.stringify({
      proposal_id,
      proposal_type: type,
      target,
      payload,
      evidence,
      confidence,
      rationale,
      human_reviewed: false
    }, null, 2), 'utf-8');
    stagedCount++;
    appendLedger(workspaceDir, {
      proposal_id,
      type,
      target,
      by: 'staged',
      confidence,
      rationale
    });
  }

  // P4-a: Invalidate deck_plan.json whenever cards were auto-accepted/resolved
  if (autoAccepted > 0) {
    const planPath = path.join(workspaceDir, '_Inbox', 'deck_plan.json');
    if (fs.existsSync(planPath)) {
      try { fs.unlinkSync(planPath); } catch (e) {}
    }
  }

  return { ok: true, autoAccepted, stagedCount, skippedIdempotent };
}

module.exports = {
  applyProposals,
  appendLedger,
  getExistingProposalIds
};
