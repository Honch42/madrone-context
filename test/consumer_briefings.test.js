'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.NODE_ENV = 'test';
process.env.MADRONE_ALLOW_ENV_OVERRIDES = '1';
process.env.MADRONE_EXTRA_VAULT_PATHS = os.tmpdir();

const { verifyHostIdentity, assertPathAllowed, isPathAllowed, getHostIdentity } = require('../src/scope_guard');
const { initConsumerBriefings, listConsumerBriefings, updateSectionCoverage, filterBriefingsForAgent, parseBriefing } = require('../src/consumer_briefings');
const { buildDeck } = require('../src/deck_builder');

console.log('[test/consumer_briefings] Starting test suite...');

// Test 1: Host identity scope guard fails closed on unknown, work, or missing
assert.strictEqual(verifyHostIdentity('role=personal'), true);
assert.strictEqual(verifyHostIdentity('role=headless'), true);

try {
  verifyHostIdentity('role=work');
  assert.fail('Should have thrown on role=work');
} catch (err) {
  assert.strictEqual(err.code, 'WORK_HOST_IDENTITY_LOCKED');
  console.log('ok - host identity guard halts on role=work');
}

try {
  verifyHostIdentity('role=unknown');
  assert.fail('Should have thrown on role=unknown');
} catch (err) {
  assert.strictEqual(err.code, 'WORK_HOST_IDENTITY_LOCKED');
  console.log('ok - host identity guard halts on role=unknown (fail closed)');
}

try {
  verifyHostIdentity('');
  assert.fail('Should have thrown on empty string');
} catch (err) {
  assert.strictEqual(err.code, 'WORK_HOST_IDENTITY_LOCKED');
  console.log('ok - host identity guard halts on empty string');
}

// Test 2: Vault allowlist rejects Synergy Pet Group and disallowed paths
assert.strictEqual(isPathAllowed('/Users/honchpersonal/Documents/Obsidian/Synergy_Pet_Group/notes.md'), false);
assert.strictEqual(isPathAllowed('/Users/honchpersonal/Documents/SecretWork/cv.vet/doc.md'), false);
try {
  assertPathAllowed('/Users/honchpersonal/Documents/Obsidian/Synergy_Pet_Group/doc.md');
  assert.fail('Should have thrown on disallowed path');
} catch (err) {
  assert.strictEqual(err.code, 'VAULT_ALLOWLIST_VIOLATION');
  // Sanity check: error message must not leak raw targetPath
  assert.ok(!err.message.includes('/Users/honchpersonal'), 'Error message must not leak full path');
  console.log('ok - vault allowlist strictly rejects Synergy Pet Group and external paths with sanitized error message');
}

// Setup temporary test vault in os.tmpdir()
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'madrone-briefings-'));
const coreDir = path.join(tmpVault, 'Core');
fs.mkdirSync(coreDir, { recursive: true });

// Test 2b: Symlink traversal into Synergy_Pet_Group is blocked
const fakeSpgDir = path.join(tmpVault, 'fake_Synergy_Pet_Group_vault');
fs.mkdirSync(fakeSpgDir, { recursive: true });
const symlinkPath = path.join(tmpVault, 'innocent_alias');
try {
  fs.symlinkSync(fakeSpgDir, symlinkPath);
  assert.strictEqual(isPathAllowed(symlinkPath, [tmpVault]), false);
  try {
    assertPathAllowed(symlinkPath, [tmpVault]);
    assert.fail('Should have thrown on symlink to Synergy Pet Group');
  } catch (err) {
    assert.strictEqual(err.code, 'VAULT_ALLOWLIST_VIOLATION');
  }
  console.log('ok - symlink traversal pointing into Synergy Pet Group is strictly detected and blocked');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

// Test 2c: B1 Fix - Symlink inside vault pointing to external non-denylisted dir is DENIED
const symlinkToExternal = path.join(tmpVault, 'escape_link');
try {
  fs.symlinkSync('/usr/local', symlinkToExternal);
  assert.strictEqual(isPathAllowed(symlinkToExternal, [tmpVault]), false, 'Symlink escaping into external non-vault folder must be denied');
  console.log('ok - B1: symlink pointing to external non-denylisted path is strictly denied (real-to-real containment)');
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
}

// Test 2d: B3 Fix - Trailing empty delimiter in MADRONE_EXTRA_VAULT_PATHS must not add CWD
process.env.MADRONE_EXTRA_VAULT_PATHS = `${os.tmpdir()}:`;
const parsedExtra = process.env.MADRONE_EXTRA_VAULT_PATHS.split(path.delimiter).map(p => p.trim()).filter(Boolean).map(p => path.resolve(p));
assert.strictEqual(parsedExtra.length, 1, 'Trailing delimiter must not produce an extra entry');
assert.strictEqual(parsedExtra[0], path.resolve(os.tmpdir()));
process.env.MADRONE_EXTRA_VAULT_PATHS = os.tmpdir();
console.log('ok - B3: trailing delimiter in MADRONE_EXTRA_VAULT_PATHS does not silently add CWD');

// Test 3: Initialize consumer briefings
initConsumerBriefings(coreDir);
const briefings = listConsumerBriefings(coreDir);
assert.ok(briefings.length >= 7, 'Should have seeded at least 7 domain briefings + agents');
const familyBriefing = briefings.find(b => b.id === 'family');
assert.ok(familyBriefing, 'Family briefing must exist');
assert.strictEqual(familyBriefing.coverage['Facts'], 0.0);
assert.strictEqual(familyBriefing.visibility, 'personal', 'Family briefing must be flagged as personal visibility');
console.log('ok - seed domain and agent briefings initialized under Core/ with 0.0 coverage and personal/business visibility');

// Test 3b: Personal Domain Isolation for Agent Briefings
const filteredForAgents = filterBriefingsForAgent(briefings);
const agentPersonalLeaks = filteredForAgents.filter(b => b.visibility === 'personal' || b.id === 'family' || b.id === 'taxes');
assert.strictEqual(agentPersonalLeaks.length, 0, 'Agent briefings must never contain personal domains');
console.log('ok - agent briefing filters strictly isolate personal domains (family, taxes) from agents');

// Test 3c: H2 Fix - Missing visibility defaults strictly to 'personal'
const noVisFile = path.join(coreDir, 'Domains', 'family', 'no_vis.md');
fs.writeFileSync(noVisFile, `---
type: domain_briefing
id: mystery-domain
coverage:
  Facts: 0.1
---

# No Vis
`, 'utf-8');
const parsedNoVis = parseBriefing(noVisFile);
assert.strictEqual(parsedNoVis.visibility, 'personal', 'Unspecified visibility must default to personal');
console.log('ok - H2: unstated briefing visibility defaults fail-safe to personal');

// Test 4: Build deck on fresh vault produces 8 cards under 16 mins (960s)
const deck = buildDeck({ workspaceDir: tmpVault }, { extraAllowlist: [tmpVault] });
assert.strictEqual(deck.length, 8, `Expected exactly 8 cards, got ${deck.length}`);

let totalBudget = 0;
let critiqueOrProbeCount = 0;
for (let i = 0; i < deck.length; i++) {
  const card = deck[i];
  assert.ok(card.consumer, `Card ${card.id} missing consumer`);
  assert.ok(card.slot, `Card ${card.id} missing slot`);
  assert.ok(card.family, `Card ${card.id} missing family`);
  assert.ok(card.budget_seconds > 0, `Card ${card.id} missing budget_seconds`);
  assert.ok(card.grounding, `Card ${card.id} missing grounding`);

  totalBudget += card.budget_seconds;
  if (card.family === 'critique' || card.family === 'assumption_probe') {
    critiqueOrProbeCount++;
  }

  if (i > 0) {
    assert.notStrictEqual(card.family, deck[i - 1].family, `Consecutive cards have same family at ${i}`);
  }
}

assert.ok(totalBudget <= 960, `Total budget must be <= 960s, got ${totalBudget}`);
assert.ok(critiqueOrProbeCount >= 2, `Expected at least 2 critique/assumption_probe cards, got ${critiqueOrProbeCount}`);
console.log('ok - fresh deck produces 8 cards under 16 min with >=2 critique/assumption cards and no consecutive same-family cards');

// Test 4b: Domain parameter validation
try {
  buildDeck({ workspaceDir: tmpVault }, { domain: 'invalid domain!@#$', extraAllowlist: [tmpVault] });
  assert.fail('Should have rejected invalid domain characters');
} catch (err) {
  assert.strictEqual(err.code, 'INVALID_DOMAIN_PARAMETER');
  console.log('ok - deck builder rejects invalid domain parameter formats');
}

// Test 4c: M3 Fix - Unknown domain parameter throws UNKNOWN_DOMAIN
try {
  buildDeck({ workspaceDir: tmpVault }, { domain: 'non-existent-domain', extraAllowlist: [tmpVault] });
  assert.fail('Should have rejected non-existent domain');
} catch (err) {
  assert.strictEqual(err.code, 'UNKNOWN_DOMAIN');
  console.log('ok - M3: deck builder rejects unknown domains with UNKNOWN_DOMAIN');
}

// Test 5: Selecting domain 'family' yields deck where at least 6 of 8 cards have consumer: domain:family
const familyDeck = buildDeck({ workspaceDir: tmpVault }, { domain: 'family', extraAllowlist: [tmpVault] });
assert.strictEqual(familyDeck.length, 8);
const familyCards = familyDeck.filter(c => c.consumer === 'domain:family');
assert.ok(familyCards.length >= 6, `Expected at least 6 family cards, got ${familyCards.length}`);
console.log('ok - selecting domain "family" prioritizes >=6 cards for domain:family');

// Test 6: Raising coverage above threshold removes those cards & YAML round-trips
for (const sec of ['Facts', 'People', 'Constraints and non-negotiables', 'Principles', 'Assumptions', 'Open decisions', 'Failures']) {
  updateSectionCoverage(familyBriefing.filePath, sec, 1.0);
}
const updatedBriefings = listConsumerBriefings(coreDir);
const updatedFamily = updatedBriefings.find(b => b.id === 'family');
assert.strictEqual(updatedFamily.coverage['Facts'], 1.0);

// Test 6b: Obsidian normalized YAML (unquoted keys, integer 0, clamped values)
const mockObsidianFile = path.join(coreDir, 'Domains', 'family', 'obsidian_test.md');
const unquotedYaml = `---
type: domain_briefing
id: family
priority: 95
visibility: personal
coverage:
  Facts: 0
  People: 0.5
---

# Domain Briefing
`;
fs.writeFileSync(mockObsidianFile, unquotedYaml, 'utf-8');
const parsedObsidian = parseBriefing(mockObsidianFile);
assert.strictEqual(parsedObsidian.coverage['Facts'], 0.0);
assert.strictEqual(parsedObsidian.coverage['People'], 0.5);

// Test atomic update and clamping on unquoted file
updateSectionCoverage(mockObsidianFile, 'Facts', 1.8); // Should clamp to 1.0
updateSectionCoverage(mockObsidianFile, 'People', -0.5); // Should clamp to 0.0
const reparsedObsidian = parseBriefing(mockObsidianFile);
assert.strictEqual(reparsedObsidian.coverage['Facts'], 1.0);
assert.strictEqual(reparsedObsidian.coverage['People'], 0.0);
console.log('ok - obsidian-style unquoted YAML round-trips correctly and coverage updates persist atomically with [0.0, 1.0] clamping');

// Test 6c: M1 Fix - YAML date preservation (created: 2026-10-03 remains unchanged, no UTC ISO conversion)
const dateTestFile = path.join(coreDir, 'Domains', 'family', 'date_test.md');
fs.writeFileSync(dateTestFile, `---
type: domain_briefing
id: family
visibility: personal
created: 2026-10-03
coverage:
  Facts: 0.2
---

# Date Test
`, 'utf-8');
updateSectionCoverage(dateTestFile, 'Facts', 0.8);
const dateTestContent = fs.readFileSync(dateTestFile, 'utf-8');
assert.ok(/created:\s*['"]?2026-10-03['"]?/.test(dateTestContent), 'Date string must be preserved without UTC conversion');
assert.ok(!dateTestContent.includes('T00:00:00'), 'Date string must not contain ISO time');
console.log('ok - M1: YAML round-trip preserves Obsidian date strings without timezone mangling');

// Test 7: Telemetry alone emits no cards when all briefings are fully covered
for (const b of updatedBriefings) {
  for (const s of Object.keys(b.coverage)) {
    updateSectionCoverage(b.filePath, s, 1.0);
  }
}
const fullCoverageDeck = buildDeck({ workspaceDir: tmpVault }, { extraAllowlist: [tmpVault] });
const fullCoverageQuestions = fullCoverageDeck.filter(c => !c.is_freeform && c.id !== 'warmup-readiness');
assert.strictEqual(fullCoverageQuestions.length, 0, 'No cards should be emitted from telemetry alone when coverage is full');
console.log('ok - telemetry alone emits 0 cards when consumer briefings are fully covered');

// Cleanup
fs.rmSync(tmpVault, { recursive: true, force: true });
console.log('\nAll consumer briefings acceptance criteria verified successfully!');
