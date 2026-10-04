'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { assertPathAllowed } = require('./scope_guard');

const DOMAIN_SECTIONS = [
  'Facts',
  'People',
  'Constraints and non-negotiables',
  'Principles',
  'Assumptions',
  'Open decisions',
  'Failures'
];

const AGENT_SECTIONS = [
  'Objective',
  'Autonomy policy',
  'Entities in scope',
  'Exemplars',
  'Principles',
  'Failures',
  'People',
  'Handoff template'
];

const SEED_DOMAINS = [
  { id: 'family', priority: 95, visibility: 'personal' },
  { id: 'taxes', priority: 90, visibility: 'personal' },
  { id: 'madrone-collective', priority: 85, visibility: 'business' },
  { id: 'madrone-iv', priority: 80, visibility: 'business' },
  { id: 'openrez', priority: 75, visibility: 'business' },
  { id: 'rollco-spv', priority: 70, visibility: 'business' },
  { id: 'properties-madrone-ridge', priority: 70, visibility: 'business' }
];

const SEED_AGENTS = [
  { id: 'marketing-content-agent', priority: 100, visibility: 'business' }
];

const COVERAGE_THRESHOLD = 0.6;

function ensureDirectoryExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initConsumerBriefings(coreDir) {
  assertPathAllowed(coreDir);

  const domainsDir = path.join(coreDir, 'Domains');
  const agentsDir = path.join(coreDir, 'Agents');
  const policiesDir = path.join(coreDir, 'Policies');
  const factsDir = path.join(coreDir, 'Facts');
  const exemplarsDir = path.join(coreDir, 'Exemplars');
  const assumptionsDir = path.join(coreDir, 'Assumptions');

  ensureDirectoryExists(domainsDir);
  ensureDirectoryExists(agentsDir);
  ensureDirectoryExists(policiesDir);
  ensureDirectoryExists(factsDir);
  ensureDirectoryExists(exemplarsDir);
  ensureDirectoryExists(assumptionsDir);

  // Initialize Seed Domains
  for (const dom of SEED_DOMAINS) {
    const domFolder = path.join(domainsDir, dom.id);
    ensureDirectoryExists(domFolder);
    const briefingPath = path.join(domFolder, 'briefing.md');
    if (!fs.existsSync(briefingPath)) {
      const covObj = {};
      DOMAIN_SECTIONS.forEach(s => { covObj[s] = 0.0; });
      const fmObj = {
        type: 'domain_briefing',
        id: dom.id,
        priority: dom.priority,
        visibility: dom.visibility,
        coverage: covObj
      };
      const fmYaml = yaml.dump(fmObj).trim();
      const body = DOMAIN_SECTIONS.map(s => `## ${s}\n\n*Pending initial briefing data.*\n`).join('\n');
      const content = `---\n${fmYaml}\n---\n\n# Domain Briefing: ${dom.id}\n\n${body}`;
      fs.writeFileSync(briefingPath, content, 'utf-8');
    }
  }

  // Initialize Seed Agents (Always strictly isolated to business visibility)
  for (const ag of SEED_AGENTS) {
    const agFolder = path.join(agentsDir, ag.id);
    ensureDirectoryExists(agFolder);
    const briefingPath = path.join(agFolder, 'briefing.md');
    if (!fs.existsSync(briefingPath)) {
      const covObj = {};
      AGENT_SECTIONS.forEach(s => { covObj[s] = 0.0; });
      const fmObj = {
        type: 'agent_briefing',
        id: ag.id,
        priority: ag.priority,
        visibility: ag.visibility,
        coverage: covObj
      };
      const fmYaml = yaml.dump(fmObj).trim();
      const body = AGENT_SECTIONS.map(s => `## ${s}\n\n*All sections initialized empty.*\n`).join('\n');
      const content = `---\n${fmYaml}\n---\n\n# Agent Briefing: ${ag.id}\n\n${body}`;
      fs.writeFileSync(briefingPath, content, 'utf-8');
    }
  }

  // Principles, Assumptions, Failures top-level files (strictly non-personal seed)
  const principlesPath = path.join(coreDir, 'Principles.md');
  if (!fs.existsSync(principlesPath)) {
    fs.writeFileSync(principlesPath, `# Core Principles\n\n| Rule | Cases | Counter-Case | Domains |\n|---|---|---|---|\n`, 'utf-8');
  }

  const failuresPath = path.join(coreDir, 'Failures.md');
  if (!fs.existsSync(failuresPath)) {
    fs.writeFileSync(failuresPath, `# Core Failures\n\n| Incident | Cause | Check That Prevents It |\n|---|---|---|\n`, 'utf-8');
  }
}

function parseBriefing(filePath) {
  assertPathAllowed(filePath);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    console.warn(`[consumer_briefings] Warning: Missing frontmatter block in ${filePath}`);
    return null;
  }

  let parsedFm = null;
  try {
    parsedFm = yaml.load(fmMatch[1], { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    console.warn(`[consumer_briefings] Warning: Failed to parse YAML frontmatter in ${filePath}:`, err.message);
    return null;
  }

  if (!parsedFm || typeof parsedFm !== 'object') {
    console.warn(`[consumer_briefings] Warning: Invalid YAML frontmatter in ${filePath}`);
    return null;
  }

  const rawCoverage = parsedFm.coverage || {};
  const coverage = {};
  for (const [sec, val] of Object.entries(rawCoverage)) {
    coverage[sec] = parseFloat(val) || 0.0;
  }

  // H2 Fix: Missing or unknown visibility defaults strictly to 'personal'
  const rawVis = parsedFm.visibility ? String(parsedFm.visibility).toLowerCase() : 'personal';
  const visibility = ['personal', 'business'].includes(rawVis) ? rawVis : 'personal';

  return {
    id: parsedFm.id,
    type: parsedFm.type,
    priority: parseInt(parsedFm.priority ?? '50', 10),
    visibility,
    coverage,
    filePath,
    raw: content
  };
}

function listConsumerBriefings(coreDir, options = {}) {
  assertPathAllowed(coreDir);
  const briefings = [];

  const domainsDir = path.join(coreDir, 'Domains');
  if (fs.existsSync(domainsDir)) {
    const entries = fs.readdirSync(domainsDir);
    for (const ent of entries) {
      const p = path.join(domainsDir, ent, 'briefing.md');
      const parsed = parseBriefing(p);
      if (parsed) briefings.push(parsed);
    }
  }

  const agentsDir = path.join(coreDir, 'Agents');
  if (fs.existsSync(agentsDir)) {
    const entries = fs.readdirSync(agentsDir);
    for (const ent of entries) {
      const p = path.join(agentsDir, ent, 'briefing.md');
      const parsed = parseBriefing(p);
      if (parsed) briefings.push(parsed);
    }
  }

  if (options.forAgent) {
    return filterBriefingsForAgent(briefings);
  }

  return briefings;
}

function filterBriefingsForAgent(briefings) {
  if (!Array.isArray(briefings)) return [];
  return briefings.filter(b => b.visibility !== 'personal');
}

function updateSectionCoverage(briefingPath, section, newCoverage) {
  assertPathAllowed(briefingPath);
  if (!fs.existsSync(briefingPath)) return false;
  
  const content = fs.readFileSync(briefingPath, 'utf-8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!fmMatch) {
    console.warn(`[consumer_briefings] Cannot update coverage: malformed frontmatter in ${briefingPath}`);
    return false;
  }

  let data = null;
  try {
    data = yaml.load(fmMatch[1], { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    console.warn(`[consumer_briefings] Cannot update coverage: YAML error in ${briefingPath}:`, err.message);
    return false;
  }

  if (!data || typeof data !== 'object') return false;
  if (!data.coverage || typeof data.coverage !== 'object') {
    data.coverage = {};
  }

  // Robust value clamping [0.0, 1.0]
  const num = Number(newCoverage);
  const clamped = Number.isFinite(num) ? Math.max(0.0, Math.min(1.0, num)) : 0.0;
  data.coverage[section] = parseFloat(clamped.toFixed(2));

  // M1 Fix: Preserve formatting with CORE_SCHEMA to avoid quote insertion on dates
  const newYaml = yaml.dump(data, { lineWidth: -1, noRefs: true, schema: yaml.CORE_SCHEMA }).trim();
  const rest = fmMatch[2] || '';
  const newContent = `---\n${newYaml}\n---${rest}`;

  // M2: Atomic file write via dot-prefixed temporary file (ignored by Obsidian indexing/sync)
  const dir = path.dirname(briefingPath);
  const base = path.basename(briefingPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  let written = false;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, newContent, 'utf-8');
    try { fs.fsyncSync(fd); } catch (_) {}
    fs.closeSync(fd);
    fs.renameSync(tmpPath, briefingPath);
    written = true;
    return true;
  } catch (err) {
    console.warn(`[consumer_briefings] Atomic write failed for ${briefingPath}:`, err.message);
    return false;
  } finally {
    if (!written) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

module.exports = {
  DOMAIN_SECTIONS,
  AGENT_SECTIONS,
  SEED_DOMAINS,
  SEED_AGENTS,
  COVERAGE_THRESHOLD,
  initConsumerBriefings,
  parseBriefing,
  listConsumerBriefings,
  filterBriefingsForAgent,
  updateSectionCoverage
};
