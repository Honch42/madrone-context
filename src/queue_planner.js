'use strict';

/**
 * Madrone Context Step 4 Queue Planner.
 * Deterministically re-ranks candidate cards and enforces deck slot composition.
 * Emits _Inbox/deck_plan.json atomically with source_hash and slot shifting.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const frontmatter = require('./frontmatter');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
}

function writeFileSyncAtomic(filepath, content, encoding = 'utf-8') {
  const tmp = `${filepath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, content, encoding);
  fs.renameSync(tmp, filepath);
}

/**
 * Computes deterministic priority score without external model calls.
 * Employs factor floors to ensure no card is permanently silenced to zero.
 */
function scoreCard(card) {
  const baseValue = Math.max(0.1, Number(card.priority) || 0.5);
  const now = Date.now();
  const createdMs = card.created ? new Date(card.created).getTime() : now;
  const ageDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
  const recencyDecay = Math.max(0.5, 1.0 - (ageDays * 0.015));

  const partialBoost = card.answer_status === 'partial' ? 1.4 : 1.0;
  const nagDampener = Math.max(0.2, (card.ask_count || 0) >= 3 ? 0.4 : 1.0);
  const hasUnverified = card.presupposition_check?.unverified?.length > 0;
  const presuppositionPenalty = Math.max(0.2, hasUnverified ? 0.3 : 1.0);
  const kindBoost = card.kind === 'contradiction_probe' ? 1.6 :
                    card.kind === 'range_closer' ? 1.3 : 1.0;

  return Number((baseValue * recencyDecay * partialBoost * nagDampener * presuppositionPenalty * kindBoost).toFixed(3));
}

/**
 * Plans the next session deck and writes _Inbox/deck_plan.json.
 * @param {string} workspaceDir
 * @returns {object} { planPath, plannedCards }
 */
function planDeck(workspaceDir) {
  const hypothesesDir = path.join(workspaceDir, '_Inbox', 'Agent_Hypotheses');
  const openCards = [];

  if (fs.existsSync(hypothesesDir)) {
    const files = fs.readdirSync(hypothesesDir).filter(f => f.endsWith('.md')).sort();
    for (const f of files) {
      try {
        const fullPath = path.join(hypothesesDir, f);
        const { meta, body } = frontmatter.parse(fs.readFileSync(fullPath, 'utf-8'));
        const st = String(meta.status || '').toLowerCase().trim();
        const ans = String(meta.answer_status || '').toLowerCase().trim();

        // Strictly exclude resolved, staged, retired, or answered cards
        if (st === 'open' && ans !== 'answered' && !meta.staged_adjudication) {
          const scored = {
            ...meta,
            file: f,
            body,
            calculated_priority: scoreCard(meta)
          };
          openCards.push(scored);
        }
      } catch (e) {
        // Skip malformed
      }
    }
  }

  // Deterministic sort: priority descending, tie-breaker on card id/file ascending
  openCards.sort((a, b) => 
    b.calculated_priority - a.calculated_priority || 
    String(a.id || a.file).localeCompare(String(b.id || b.file))
  );

  // Compute source hash of active cards and statuses
  const sourceHashInput = openCards.map(c => `${c.id || c.file}:${c.status}:${c.answer_status}`).join('|');
  const sourceHash = sha256(sourceHashInput);

  // Enforce slot composition template
  const plannedCards = [
    {
      id: 'freeform-dump',
      kind: 'freeform',
      slot: 'freeform',
      badge: 'UNPROMPTED BRAIN DUMP',
      question: 'Tap to record an unprompted thought, realization, or friction dump. No question needed.',
      context: 'Spontaneous stream-of-consciousness context dump.',
      is_freeform: true
    },
    {
      id: 'warmup-readiness',
      kind: 'warmup',
      slot: 'warmup',
      badge: 'WARM-UP CHECK-IN',
      question: 'How is your energy, physical comfort, and cognitive focus as you start this session?',
      context: 'Low-stakes cognitive baseline to establish cadence.',
      is_freeform: false
    }
  ];

  // Slot: Contradiction Probe (1 max)
  const probe = openCards.find(c => c.kind === 'contradiction_probe');
  if (probe) {
    plannedCards.push({ ...probe, slot: 'contradiction' });
  }

  // Slot: Range Closer (1 max)
  const rangeCard = openCards.find(c => c.kind === 'range_closer' && c.id !== probe?.id);
  if (rangeCard) {
    plannedCards.push({ ...rangeCard, slot: 'range_closer' });
  }

  // Slot shifting: Fill remaining slots up to target deck size (target: 7-9 cards)
  const usedIds = new Set(plannedCards.map(c => c.id));
  const remainingCapacity = Math.max(5, 9 - plannedCards.length);
  const coreCards = openCards.filter(c => !usedIds.has(c.id)).slice(0, remainingCapacity);
  for (const c of coreCards) {
    plannedCards.push({ ...c, slot: 'core' });
  }

  // Write _Inbox/deck_plan.json atomically
  const planPath = path.join(workspaceDir, '_Inbox', 'deck_plan.json');
  ensureDir(path.dirname(planPath));
  const planPayload = {
    planned_at: new Date().toISOString(),
    source_hash: sourceHash,
    total_cards: plannedCards.length,
    deck: plannedCards
  };
  writeFileSyncAtomic(planPath, JSON.stringify(planPayload, null, 2), 'utf-8');

  return { planPath, plannedCards };
}

module.exports = {
  scoreCard,
  planDeck
};
