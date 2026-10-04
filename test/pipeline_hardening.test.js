'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const distiller = require('../src/distiller');
const proposalApplier = require('../src/proposal_applier');
const queuePlanner = require('../src/queue_planner');
const deckBuilder = require('../src/deck_builder');
const frontmatter = require('../src/frontmatter');

async function runTests() {
  console.log('--- Running Pipeline Hardening Verification Suite ---');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madrone-hardening-'));
  const hypothesesDir = path.join(tmpDir, '_Inbox', 'Agent_Hypotheses');
  const distillationsDir = path.join(tmpDir, '_Inbox', 'Distillations');
  const sessionsDir = path.join(tmpDir, 'Core', 'Sessions');
  fs.mkdirSync(hypothesesDir, { recursive: true });
  fs.mkdirSync(distillationsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  try {
    // 1. Setup sample cards
    const card1Meta = { id: 'hyp-tahoe-str', status: 'open', answer_status: 'unasked', ask_count: 0, priority: 0.8 };
    const card2Meta = { id: 'hyp-unasked-card', status: 'open', answer_status: 'unasked', ask_count: 0, priority: 0.7 };
    fs.writeFileSync(path.join(hypothesesDir, '01_tahoe.md'), frontmatter.serialize(card1Meta, 'Tahoe body'));
    fs.writeFileSync(path.join(hypothesesDir, '02_unasked.md'), frontmatter.serialize(card2Meta, 'Unasked body'));

    // 2. Setup turns
    const sessionId = 'session_test_hardening';
    const turnsPath = path.join(sessionsDir, `${sessionId}_turns.jsonl`);
    const turns = [
      { turnId: 'turn-1', cardId: 'hyp-tahoe-str', prompt_card_id: 'hyp-tahoe-str', transcript: 'We are active on Airbnb and direct bookings only.' }
    ];
    fs.writeFileSync(turnsPath, turns.map(t => JSON.stringify(t)).join('\n') + '\n');

    // 3. Test Distiller State Machine (.pending -> .processing -> unlink)
    const pendingMarker = path.join(distillationsDir, `${sessionId}.pending`);
    fs.writeFileSync(pendingMarker, JSON.stringify({ sessionId, expected_turns: 1 }));
    assert.strictEqual(fs.existsSync(pendingMarker), true, 'Pending marker should exist before run');

    const distillRes = await distiller.distillSession(sessionId, {
      settings: { workspaceDir: tmpDir, distillerModel: 'none' }
    });
    assert.strictEqual(distillRes.ok, true, 'Distillation should succeed');
    assert.strictEqual(fs.existsSync(pendingMarker), false, 'Pending marker should be removed');
    assert.strictEqual(fs.existsSync(path.join(distillationsDir, `${sessionId}.processing`)), false, 'Processing marker should be cleaned up');
    assert.strictEqual(fs.existsSync(distillRes.outPath), true, 'Distillation output should exist');

    // 4. Test Proposal Applier Structural Evidence Verification (P3-b)
    const proposalsData = JSON.parse(fs.readFileSync(distillRes.outPath, 'utf-8'));
    
    // Add an unasked card close proposal with high confidence (simulating injection or hallucination)
    proposalsData.proposals.push({
      proposal_id: 'prop_unasked_hallucination',
      type: 'close_card',
      target: 'hyp-unasked-card',
      confidence: 0.99,
      evidence: ['fake-turn-999'],
      rationale: 'Hallucinated or injected close'
    });

    const applyRes = proposalApplier.applyProposals(tmpDir, proposalsData.proposals, {
      sessionId,
      sessionTurns: turns
    });

    // Verify: hyp-tahoe-str should be auto-accepted because it was asked in turn-1
    const tahoeCard = frontmatter.parse(fs.readFileSync(path.join(hypothesesDir, '01_tahoe.md'), 'utf-8')).meta;
    assert.strictEqual(tahoeCard.status, 'resolved', 'Asked card with evidence should be resolved');
    assert.strictEqual(tahoeCard.answer_status, 'answered', 'Asked card should be answered');

    // Verify: hyp-unasked-card should NOT be auto-accepted because it has no structural turn evidence
    const unaskedCard = frontmatter.parse(fs.readFileSync(path.join(hypothesesDir, '02_unasked.md'), 'utf-8')).meta;
    assert.strictEqual(unaskedCard.status, 'open', 'Unasked card must NOT be closed despite 0.99 confidence');
    assert.strictEqual(unaskedCard.answer_status, 'unasked', 'Unasked card must remain unasked');

    // 5. Test Proposal Idempotency (P3-c)
    const secondApply = proposalApplier.applyProposals(tmpDir, proposalsData.proposals, {
      sessionId,
      sessionTurns: turns
    });
    assert.strictEqual(secondApply.autoAccepted, 0, 'Re-applying should auto-accept 0 proposals');
    assert.strictEqual(secondApply.skippedIdempotent > 0, true, 'Duplicate proposals should be skipped via ledger');

    // 6. Test Contradiction Cap & Dedup (P3-e)
    const contradictionProps = [
      { proposal_id: 'c1', type: 'contradiction', payload: { claim_a: { card_id: 'a' }, claim_b: { card_id: 'b' } } },
      { proposal_id: 'c2', type: 'contradiction', payload: { claim_a: { card_id: 'b' }, claim_b: { card_id: 'a' } } }, // duplicate pair
      { proposal_id: 'c3', type: 'contradiction', payload: { claim_a: { card_id: 'c' }, claim_b: { card_id: 'd' } } },
      { proposal_id: 'c4', type: 'contradiction', payload: { claim_a: { card_id: 'e' }, claim_b: { card_id: 'f' } } }  // exceeds cap of 2
    ];
    const cApply = proposalApplier.applyProposals(tmpDir, contradictionProps);
    assert.strictEqual(cApply.autoAccepted, 2, 'Contradictions should be capped at 2 and deduplicated by pair');

    // 7. Test Queue Planner deterministic tie-breaking & slot shifting
    const planRes = queuePlanner.planDeck(tmpDir);
    assert.strictEqual(fs.existsSync(planRes.planPath), true, 'Deck plan should be written');
    assert.strictEqual(planRes.plannedCards.length >= 2, true, 'Deck should contain cards');
    assert.strictEqual(planRes.plannedCards[0].id, 'freeform-dump', 'Slot 0 must be freeform-dump');
    assert.strictEqual(planRes.plannedCards[1].id, 'warmup-readiness', 'Slot 1 must be warmup');

    // 8. Test Deck Builder stale plan filtering (P4-a)
    // Manually add the resolved tahoe card to deck_plan.json to simulate a stale plan
    const stalePlan = JSON.parse(fs.readFileSync(planRes.planPath, 'utf-8'));
    stalePlan.deck.push({ id: 'hyp-tahoe-str', file: '01_tahoe.md', status: 'open' });
    fs.writeFileSync(planRes.planPath, JSON.stringify(stalePlan));

    const servedDeck = deckBuilder.buildDeck(tmpDir);
    const hasResurrectedTahoe = servedDeck.some(c => c.id === 'hyp-tahoe-str');
    assert.strictEqual(hasResurrectedTahoe, false, 'Deck builder must filter out resolved cards from stale deck_plan.json');

    console.log('✅ ALL PIPELINE HARDENING TESTS PASSED CLEANLY (100%)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('❌ Pipeline hardening test failed:', err);
  process.exit(1);
});
