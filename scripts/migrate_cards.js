'use strict';

/**
 * Migration script for Phase 1 of Madrone Context Card Schema (Hardened).
 * Ensures schema_version: 1, enforces invariants, and normalizes date scalars.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const frontmatter = require('../src/frontmatter');

const targetDirs = [
  path.resolve(__dirname, '../../_Inbox/Agent_Hypotheses'),
  path.join(os.homedir(), 'Documents/MadroneContext/_Inbox/Agent_Hypotheses'),
  path.resolve(__dirname, '../_Inbox/Agent_Hypotheses')
];

let totalMigrated = 0;
let totalSkipped = 0;
let invariantFailures = 0;

function normalizeDateStr(val) {
  if (!val) return new Date().toISOString().slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  return new Date().toISOString().slice(0, 10);
}

function migrateDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  console.log(`\n📂 Scanning directory: ${dirPath}`);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const { meta, body } = frontmatter.parse(content);

      if (!meta || Object.keys(meta).length === 0) {
        console.warn(`  ⚠️ Skipping unparseable frontmatter in ${file}`);
        totalSkipped++;
        continue;
      }

      let changed = false;

      // 1. Schema version
      if (meta.schema_version !== 1) {
        meta.schema_version = 1;
        changed = true;
      }

      // 2. Establish card kind
      if (!meta.kind) {
        if (file.startsWith('99_clarify_') || (meta.id && String(meta.id).startsWith('unc_'))) {
          meta.kind = 'clarify_token';
        } else if (meta.is_freeform) {
          meta.kind = 'freeform';
        } else {
          meta.kind = 'hypothesis';
        }
        changed = true;
      }

      // 3. Resolve status and answer_status
      const hasAdjudication = meta.staged_adjudication != null;
      if (!meta.status) {
        meta.status = hasAdjudication ? 'staged' : 'open';
        changed = true;
      }

      if (!meta.answer_status) {
        meta.answer_status = hasAdjudication ? 'answered' : 'unasked';
        changed = true;
      }

      // Invariant enforcement:
      // status === 'resolved' => answer_status must be 'answered'
      if (meta.status === 'resolved' && meta.answer_status !== 'answered') {
        meta.answer_status = 'answered';
        changed = true;
      }

      // answer_status === 'answered' => ask_count must be >= 1
      if (meta.answer_status === 'answered') {
        if (typeof meta.ask_count !== 'number' || meta.ask_count < 1) {
          meta.ask_count = 1;
          changed = true;
        }
      } else if (meta.answer_status === 'unasked') {
        if (typeof meta.ask_count !== 'number' || meta.ask_count !== 0) {
          meta.ask_count = 0;
          changed = true;
        }
      }

      // 4. Date normalization (ensure YYYY-MM-DD string, never ISO with time/TZ)
      const cleanCreated = normalizeDateStr(meta.created);
      if (meta.created !== cleanCreated) {
        meta.created = cleanCreated;
        changed = true;
      }

      if (!meta.source) {
        meta.source = file.startsWith('99_clarify_') ? 'uncertainty_detector' : 'manual';
        changed = true;
      }

      if (!meta.presupposition_check) {
        meta.presupposition_check = {
          presupposes: [],
          verified_by: [],
          unverified: []
        };
        changed = true;
      }

      if (!Array.isArray(meta.open_ranges)) {
        meta.open_ranges = [];
        changed = true;
      }

      if (!Array.isArray(meta.entities)) {
        meta.entities = [];
        changed = true;
      }

      // Verify invariants
      if (meta.status === 'resolved' && meta.answer_status !== 'answered') {
        console.error(`  ❌ INVARIANT VIOLATION in ${file}: status=resolved but answer_status=${meta.answer_status}`);
        invariantFailures++;
      }

      if (changed) {
        const updatedContent = frontmatter.serialize(meta, body);
        fs.writeFileSync(fullPath, updatedContent, 'utf-8');
        totalMigrated++;
        console.log(`  ✓ Updated: ${file} (kind=${meta.kind}, status=${meta.status}, answer_status=${meta.answer_status})`);
      } else {
        totalSkipped++;
      }
    } catch (err) {
      console.error(`  ✗ Error processing ${file}:`, err.message);
    }
  }
}

console.log('Starting Madrone Context card schema migration (Hardened v1)...');
const uniqueDirs = [...new Set(targetDirs)];
for (const dir of uniqueDirs) {
  migrateDir(dir);
}

console.log(`\n✅ Migration Complete. ${totalMigrated} cards updated, ${totalSkipped} already conformant. Invariant failures: ${invariantFailures}\n`);
