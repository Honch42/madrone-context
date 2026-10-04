'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.NODE_ENV = 'test';
process.env.MADRONE_ALLOW_ENV_OVERRIDES = '1';
process.env.MADRONE_EXTRA_VAULT_PATHS = os.tmpdir();

const { TranscriptAssembler } = require('../src/transcript_assembler');
const { getLexicon } = require('../src/lexicon');
const { classifySensitivity, getPrivateDir } = require('../src/sensitivity_router');
const { lexicalStancePrior, reconcileStance } = require('../src/stance');
const { computeAdjudicationStatus } = require('../src/slot_tracker');
const { evaluateAssumptions } = require('../src/assumption_engine');
const { reconcileSessionMath } = require('../src/reconcile');
const { buildDeck, countQuestions, validateCard } = require('../src/deck_builder');
const { detectUncertainties, surfaceUncertaintiesToDeskQueue } = require('../src/uncertainty_detector');

console.log('[test/structural_remediation] Running verification test suite...');

// 1. Transcript Assembler Test (Interim Concatenation Fix)
const assembler = new TranscriptAssembler();
['my', 'my sense', 'my sense is', 'my sense is that'].forEach(text => {
  assembler.ingest({ is_final: false, text });
});
assembler.ingest({ is_final: true, text: 'My sense is that having a mortgage is helpful,', segment_id: 0 });
assembler.ingest({ is_final: true, text: 'My sense is that having a mortgage is helpful,', segment_id: 0 }); // duplicate final
assembler.ingest({ is_final: false, text: 'given the tax' });
assembler.ingest({ is_final: true, text: 'given the tax benefits.', segment_id: 1 });

const assembled = assembler.finalize().text;
assert.strictEqual(
  assembled,
  'My sense is that having a mortgage is helpful, given the tax benefits.',
  'Assembler should never concatenate interim partial hypotheses'
);
console.log('ok - TranscriptAssembler eliminates interim stutter concatenation and duplicate finals');

// 2. Domain Lexicon & Keyword Boosting
const lex = getLexicon();
const rawSpoken = "I took my dose of endeo and visited pat in nights ferry to see the barnamiento.";
const corrected = lex.postCorrect(rawSpoken);
assert(corrected.text.includes('Foundayo'), 'endeo must be corrected to Foundayo');
assert(corrected.text.includes('Pax'), 'pat must be corrected to Pax');
assert(corrected.text.includes('Knights Ferry'), 'nights ferry must be corrected to Knights Ferry');
assert(corrected.text.includes('barndominium'), 'barnamiento must be corrected to barndominium');
const hints = lex.toProviderHints('google');
assert(hints.speechContexts[0].phrases.includes('Foundayo'), 'Provider hints must include canonical terms');
console.log('ok - Lexicon provides speech boosting hints and post-corrects phonetic aliases');

// 3. Sensitive Health & Medication Isolation
const healthTurn = "I reduced my dose of Foundayo to reduce nausea and side effects.";
const healthSens = classifySensitivity(healthTurn);
assert.strictEqual(healthSens.isSensitive, true, 'Foundayo turn must be classified as sensitive');
assert.strictEqual(healthSens.level, 'private', 'Pure health turn must be routed to private level');
assert(healthSens.redactedText.includes('[REDACTED:health:'), 'Sensitive terms must be redacted for strategy views');

const strategyTurn = "We will purchase a property in Reno with a large mortgage.";
const stratSens = classifySensitivity(strategyTurn);
assert.strictEqual(stratSens.isSensitive, false, 'Strategy turn must not be flagged sensitive');
console.log('ok - SensitivityRouter isolates medical/health content and redacts strategy spans');

// 4. Stance Extraction & Lexical Prior
const hedgedText = "I potentially actually will likely lease high end space in California.";
assert.strictEqual(lexicalStancePrior(hedgedText), 'leaning', 'Hedge markers must produce leaning stance prior');

const modelProposedDecided = reconcileStance('decided', hedgedText);
assert.strictEqual(modelProposedDecided.stance, 'leaning', 'Lexical override must downgrade false decided to leaning');
assert.strictEqual(modelProposedDecided.source, 'lexical_override');

const unhedgedText = "We are definitely moving our domicile to Nevada, locked in.";
const modelConfirmed = reconcileStance('decided', unhedgedText);
assert.strictEqual(modelConfirmed.stance, 'decided', 'Unhedged statement preserves decided stance');
console.log('ok - Stance reconciliation preserves hedges and prevents false decided promotions');

// 5. Slot Tracking & Adjudication State Machine
const multiClauseCard = {
  id: 'ca-nv-domicile',
  question: 'What is your target domicile state, what date must the 183-day count be defensible from, and what is the Reno purchase deadline that implies?',
  expects: {
    slots: [
      { name: 'state', type: 'enum', required: true },
      { name: 'start_date', type: 'date', required: true, elicit_if_missing: 'What date must domicile be defensible from?' },
      { name: 'purchase_deadline', type: 'date', required: true, elicit_if_missing: 'What is the Reno purchase deadline?' }
    ]
  }
};

// Response gives state, but omits date and deadline
const partialTranscript = "Target domicile state is Nevada given access to California and Lake Tahoe.";
const statusRes = computeAdjudicationStatus({
  card: multiClauseCard,
  transcript: partialTranscript
});
assert.strictEqual(statusRes.status, 'partially_resolved', 'Missing required dates must NOT be marked resolved');
assert(statusRes.missingSlots.includes('start_date'), 'start_date must be marked missing');
assert(statusRes.missingSlots.includes('purchase_deadline'), 'purchase_deadline must be marked missing');

// Response with premise rejection
const rejectedTranscript = "I don't think we need to freeze any of these developments for 12 months.";
const premiseRes = computeAdjudicationStatus({
  card: { id: 'kill-list', question: 'Which two are frozen for 12 months?' },
  transcript: rejectedTranscript
});
assert.strictEqual(premiseRes.status, 'premise_rejected', 'Rejected question premise must be tagged premise_rejected');
console.log('ok - SlotTracker computes authoritative states and prevents false resolved marks');

// 6. Assumption Engine Verification
const taxTranscript = "I want a much higher amount of mortgage to maximize the tax deduction with the Reno property rented out.";
const flags = evaluateAssumptions(taxTranscript);
assert(flags.some(f => f.id === 'TAX_MORTGAGE_INTEREST_CAP'), 'Must flag $750k federal mortgage interest deduction limit');
assert(flags.some(f => f.id === 'TAX_SCHEDULE_E_RENTAL_ALLOCATION'), 'Must flag Schedule E rental allocation check');

const combinedSessionText = "We target Nevada domicile, visit Pax in California weekly, and lease high-end space in California.";
const ftbFlags = evaluateAssumptions('', { allSessionTurnsText: combinedSessionText });
assert(ftbFlags.some(f => f.id === 'LEGAL_CA_FTB_CLOSEST_CONNECTIONS'), 'Must flag CA FTB closest connections audit exposure');
console.log('ok - AssumptionEngine flags mortgage deduction caps and CA FTB closest-connections audit exposure');

// 7. Cross-Turn Math Reconciliation
const mathTurns = [
  { transcript: "I received a $3 million cash injection from the first payout of that acquisition." },
  { transcript: "I intend to spend 3 to $400,000 paying down debt and $3 to $400,000 on toys like the Tesla Roadster." },
  { transcript: "I will put 1.5 to 2 million dollars into Reno down payment and Madrone La Ventana." },
  { transcript: "I will keep half a million to a million dollars left in liquid securities." }
];
const mathIssues = reconcileSessionMath(mathTurns);
assert.strictEqual(mathIssues.length, 1, 'Must detect budget allocation overrun');
assert.strictEqual(mathIssues[0].id, 'MATH_WINDFALL_ALLOCATION_OVERRUN');
console.log('ok - Reconcile module catches windfall allocation overrun ($3.8M vs $3.0M)');

// 8. Card Validation & Deck Builder
const multiCard = { question: 'What is your target domicile state, what date must it start from, and what is the deadline?' };
assert(countQuestions(multiCard.question) > 1, 'countQuestions must detect compound multi-clause interrogatives');
const cardErrors = validateCard(multiCard);
assert.strictEqual(cardErrors.length, 1, 'validateCard must flag multi-question prompts');

const deck = buildDeck({ workspaceDir: os.tmpdir() });
assert(deck.some(c => c.id === 'warmup-readiness'), 'Deck must include cognitive warm-up card');
console.log('ok - DeckBuilder validates atomic cards and includes warm-up check-in card');

// 9. Uncertainty Detector & Epistemic 'Held as Unknown' Queue
const novelTranscript = "I was speaking with Zorkon regarding the Endeo shipment.";
const novelUncertainties = detectUncertainties({
  transcript: novelTranscript,
  assumptions: [{
    id: 'TAX_MORTGAGE_INTEREST_CAP',
    domain: 'Mortgage Interest Deduction',
    flag: 'STATUTORY_LIMIT_EXCEEDED',
    severity: 'material',
    note: 'Deduction capped at $750k acquisition indebtedness under TCJA.',
    followUp: 'Are you planning to deduct interest above $750,000?'
  }]
});

assert(novelUncertainties.some(u => u.suspectToken === 'Zorkon'), 'Novel word Zorkon must be flagged');
assert(novelUncertainties.some(u => u.suspectToken === 'Endeo'), 'Novel word Endeo must be flagged');
assert(novelUncertainties.some(u => u.kind === 'assumption_verification'), 'Material assumption must be flagged');
assert(novelUncertainties.every(u => u.status === 'held_as_unknown'), 'All detected uncertainties must be held as unknown');

// Verify desk queue surface
const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'madrone-unc-test-'));
const generatedFiles = surfaceUncertaintiesToDeskQueue(testWorkspace, 'test-session-001', novelUncertainties);
assert.strictEqual(generatedFiles.length, novelUncertainties.length, 'Should create clarification cards for all uncertainties');
assert(fs.existsSync(generatedFiles[0]), 'Clarification card file must exist on disk');

const cardSample = fs.readFileSync(generatedFiles[0], 'utf-8');
assert(cardSample.includes('epistemic_state: "held_as_unknown"'), 'Card must declare epistemic_state held_as_unknown');
assert(cardSample.includes('type: "clarification"'), 'Card must have clarification type');
assert(cardSample.includes('badge: "CLARIFICATION: UNKNOWN"'), 'Card must have clarification badge');
fs.rmSync(testWorkspace, { recursive: true, force: true });
console.log('ok - UncertaintyDetector holds novel tokens and assumptions as unknown and generates clarification cards');

console.log('\nAll structural remediation checks passed with 100% success!');
