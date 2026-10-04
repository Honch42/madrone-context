'use strict';

const assert = require('assert');
const frontmatter = require('../src/frontmatter');
const deckBuilder = require('../src/deck_builder');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}: ${err.message}`);
    process.exit(1);
  }
}

console.log('[test/frontmatter_deck] Running Phase 1 verification tests...');

// 1. Frontmatter parsing & edge cases
test('BOM stripping and clean parsing', () => {
  const content = '\uFEFF---\nid: test_bom\nkind: hypothesis\n---\nBody';
  const { meta, body } = frontmatter.parse(content);
  assert.strictEqual(meta.id, 'test_bom');
  assert.strictEqual(body.trim(), 'Body');
});

test('CRLF line endings handled cleanly', () => {
  const content = '---\r\nid: crlf_card\r\nstatus: open\r\n---\r\n\r\nBody text\r\n';
  const { meta, body } = frontmatter.parse(content);
  assert.strictEqual(meta.id, 'crlf_card');
  assert.strictEqual(meta.status, 'open');
  assert.strictEqual(body.trim(), 'Body text');
});

test('Empty frontmatter handled without throwing', () => {
  const content = '---\n---\nBody only';
  const { meta, body } = frontmatter.parse(content);
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body.trim(), 'Body only');
});

test('Horizontal rule --- in body does not truncate body', () => {
  const content = '---\nid: hr_card\n---\nFirst section\n\n---\n\nSecond section';
  const { meta, body } = frontmatter.parse(content);
  assert.strictEqual(meta.id, 'hr_card');
  assert.ok(body.includes('First section'));
  assert.ok(body.includes('Second section'));
  assert.ok(body.includes('---'));
});

test('Date scalar round-trip preservation (no ISO timestamp/TZ ballooning)', () => {
  const content = '---\nid: date_card\ncreated: 2026-09-28\n---\nBody';
  const parsed = frontmatter.parse(content);
  assert.strictEqual(parsed.meta.created, '2026-09-28');
  const serialized = frontmatter.serialize(parsed.meta, parsed.body);
  assert.ok(serialized.includes('created: "2026-09-28"'));
  assert.ok(!serialized.includes('00:00:00.000Z'));
  const reparsed = frontmatter.parse(serialized);
  assert.strictEqual(reparsed.meta.created, '2026-09-28');
});

test('Serialization idempotency s(p(s(p(x)))) === s(p(x))', () => {
  const input = '---\nid: idemp_card\nstatus: open\nopen_ranges:\n  - key: budget\n    low: 5000\n    high: 10000\n---\n\n## Question\nWhat is the budget?';
  const p1 = frontmatter.parse(input);
  const s1 = frontmatter.serialize(p1.meta, p1.body);
  const p2 = frontmatter.parse(s1);
  const s2 = frontmatter.serialize(p2.meta, p2.body);
  assert.strictEqual(s1, s2);
});

test('Undefined values stripped without throwing', () => {
  const meta = { id: 'undef_card', missing: undefined, valid: 10 };
  const s = frontmatter.serialize(meta, 'Body');
  assert.ok(s.includes('id: undef_card'));
  assert.ok(s.includes('valid: 10'));
  assert.ok(!s.includes('missing'));
});

// 2. Deck Builder Filter Logic
test('DeckBuilder skips status: resolved, staged, retired, archived', () => {
  const deck = deckBuilder.buildDeck();
  // None of the resolved 24 cards from today's drive session should be in the deck
  const ids = deck.map(c => c.id);
  assert.ok(!ids.includes('tier2-21-agent-wire-limits'), 'Resolved wire limits card must not be in deck');
  assert.ok(!ids.includes('tier1-08-key-person-risk'), 'Resolved key person card must not be in deck');
  assert.ok(!ids.includes('tier2-26-tesla-diagnostic-escalation'), 'Resolved tesla card must not be in deck');
  assert.ok(!ids.includes('tier1-12-post-acq-capital'), 'Resolved capital tranche card must not be in deck');
});

test('DeckBuilder preserves unasked open cards', () => {
  const deck = deckBuilder.buildDeck();
  const ids = deck.map(c => c.id);
  // Warmup and unprompted dump are always present
  assert.ok(ids.includes('freeform-dump'), 'Freeform dump card must be in deck');
  assert.ok(ids.includes('warmup-readiness'), 'Warmup card must be in deck');
});

// 3. Step 4 Queue Planner & Proposal Applier
const queuePlanner = require('../src/queue_planner');
const proposalApplier = require('../src/proposal_applier');

test('queuePlanner scores cards deterministically', () => {
  const highPriority = queuePlanner.scoreCard({ priority: 0.9, kind: 'contradiction_probe', answer_status: 'partial' });
  const lowPriority = queuePlanner.scoreCard({ priority: 0.3, ask_count: 4, presupposition_check: { unverified: ['fact'] } });
  assert.ok(highPriority > lowPriority, `High priority card (${highPriority}) should score higher than low priority card (${lowPriority})`);
});

test('queuePlanner plans deck with slot composition', () => {
  const { plannedCards } = queuePlanner.planDeck(require('os').homedir() + '/Documents/MadroneContext');
  assert.ok(plannedCards.length >= 2, 'Should plan at least 2 cards');
  assert.strictEqual(plannedCards[0].id, 'freeform-dump', 'Slot 0 must be freeform dump');
  assert.strictEqual(plannedCards[1].id, 'warmup-readiness', 'Slot 1 must be warmup check-in');
});

console.log('\nAll Phase 1-4 verification tests passed successfully!\n');
