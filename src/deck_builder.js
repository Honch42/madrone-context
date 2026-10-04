'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const storage = require('./storage');
const config = require('./config');
const frontmatter = require('./frontmatter');
const { verifyHostIdentity, assertPathAllowed, isPathAllowed } = require('./scope_guard');
const { listConsumerBriefings, COVERAGE_THRESHOLD, initConsumerBriefings } = require('./consumer_briefings');

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

function getDismissedCardIds(workspaceDir) {
  const dismissedFile = path.join(workspaceDir, '_Inbox', 'Dismissed_Feedback.jsonl');
  const dismissed = new Set();
  if (fs.existsSync(dismissedFile)) {
    try {
      const lines = fs.readFileSync(dismissedFile, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry.card_id === 'string') {
            dismissed.add(entry.card_id);
          }
        } catch (err) {
          console.warn(`[deck_builder] Malformed line ${i + 1} in ${dismissedFile}:`, err.message);
        }
      }
    } catch (e) {
      console.warn(`[deck_builder] Error reading dismissed file:`, e.message);
    }
  }
  return dismissed;
}

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

function extractFrontmatterSummary(content) {
  const fm = extractFrontmatter(content);
  return (fm.summary || '').slice(0, 200);
}

const SLOT_FAMILY_MAP = {
  'Facts': 'completion',
  'People': 'completion',
  'Constraints and non-negotiables': 'boundary',
  'Principles': 'case',
  'Assumptions': 'assumption_probe',
  'Open decisions': 'tradeoff',
  'Autonomy policy': 'boundary',
  'Objective': 'tradeoff',
  'Exemplars': 'critique'
};

/**
 * Scans allowlisted docs for assumption probes.
 */
function scanAssumptionProbes(workspace, allowlist = []) {
  const probes = [];
  const candidateDocs = [
    path.join(workspace, 'PRD_ONE_PAGER.md'),
    path.join(workspace, 'PRD.md'),
    path.join(workspace, 'PRD_v2.md'),
    path.join(workspace, 'PRD_MOBILE_EXTENSION.md')
  ];

  for (const docPath of candidateDocs) {
    if (!fs.existsSync(docPath)) continue;
    if (!isPathAllowed(docPath, allowlist)) continue;

    try {
      const text = fs.readFileSync(docPath, 'utf-8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (/assume|assumes|assumption|premise|depends on/i.test(line) && line.trim().length > 25 && line.trim().length < 200) {
          const quote = line.trim().replace(/^[-*#>\s]+/, '');
          probes.push({
            quote,
            docPath
          });
          if (probes.length >= 5) break;
        }
      }
    } catch (e) {}
    if (probes.length >= 5) break;
  }
  return probes;
}

/**
 * Builds demand-driven deck for Madrone Mobile sessions.
 */
function buildDeck(ctxSettings, options = {}) {
  // Step 1: Verify Host Identity (Throws on work machine)
  verifyHostIdentity(options.hostIdentity);

  let workspace = '';
  let settings = {};
  if (typeof ctxSettings === 'string') {
    workspace = ctxSettings;
    settings = { workspaceDir: workspace };
  } else if (ctxSettings && ctxSettings.workspaceDir) {
    workspace = ctxSettings.workspaceDir;
    settings = ctxSettings;
  } else {
    settings = (ctxSettings && typeof ctxSettings === 'object') ? ctxSettings : config.getSettings();
    workspace = settings.workspaceDir || (typeof storage.defaultWorkspace === 'function' ? storage.defaultWorkspace() : '');
  }

  // Ensure workspace is allowed
  assertPathAllowed(workspace, options.extraAllowlist || []);

  const coreDir = path.join(workspace, 'Core');
  if (fs.existsSync(coreDir)) {
    initConsumerBriefings(coreDir);
  }

  const dismissed = getDismissedCardIds(workspace);
  const selectedDomain = options.domain || options.topic || null;

  // Validate domain format if provided
  if (selectedDomain) {
    if (!/^[a-z0-9-]+$/.test(selectedDomain)) {
      const err = new Error(`Invalid domain parameter format: '${selectedDomain}'`);
      err.code = 'INVALID_DOMAIN_PARAMETER';
      throw err;
    }
  }

  // Step 2: Check planned deck if no explicit topic override
  if (!selectedDomain) {
    const planPath = path.join(workspace, '_Inbox', 'deck_plan.json');
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
        const planAgeMs = plan.planned_at ? Date.now() - new Date(plan.planned_at).getTime() : 0;
        const isFresh = planAgeMs < (24 * 60 * 60 * 1000);
        if (isFresh && plan && Array.isArray(plan.deck) && plan.deck.length > 0) {
          const filtered = plan.deck.filter(c => !dismissed.has(c.id));
          if (filtered.length >= 4) return filtered.slice(0, 8);
        }
      } catch (e) {}
    }
  }

  // Step 3: Demand-Driven Generation from Consumer Briefings
  const candidateCards = [];
  const briefings = fs.existsSync(coreDir) ? listConsumerBriefings(coreDir) : [];

  // M3: Validate domain existence against known active briefings
  if (selectedDomain) {
    const exists = briefings.length > 0 && briefings.some(b => b.id === selectedDomain);
    if (!exists) {
      const err = new Error(`Requested domain '${selectedDomain}' not found in active briefings.`);
      err.code = 'UNKNOWN_DOMAIN';
      throw err;
    }
  }

  // Load section recency to penalize recently asked slots (host-local state to prevent Obsidian Sync conflicts)
  const hostStateDir = process.env.MADRONE_STATE_DIR || path.join(os.homedir(), '.gemini', 'state', 'madrone');
  const hostRecencyFile = path.join(hostStateDir, 'deck_recency.json');
  const workspaceRecencyFile = path.join(workspace, '_Inbox', 'deck_recency.json');
  const recencyFile = fs.existsSync(hostRecencyFile) ? hostRecencyFile : workspaceRecencyFile;
  let recencyMap = {};
  if (fs.existsSync(recencyFile)) {
    try {
      recencyMap = JSON.parse(fs.readFileSync(recencyFile, 'utf-8'));
    } catch (_) {}
  }

  // Filter or prioritize briefings
  let rankedBriefings = [...briefings];
  if (selectedDomain) {
    rankedBriefings.sort((a, b) => {
      const aMatch = a.id === selectedDomain ? 1 : 0;
      const bMatch = b.id === selectedDomain ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  // Generate cards from coverage gaps
  for (const briefing of rankedBriefings) {
    const consumerTag = `${briefing.type === 'agent_briefing' ? 'agent' : 'domain'}:${briefing.id}`;
    const cov = briefing.coverage || {};
    const priority = briefing.priority || 50;

    for (const [section, score] of Object.entries(cov)) {
      if (score < COVERAGE_THRESHOLD) {
        const family = SLOT_FAMILY_MAP[section] || 'tradeoff';
        const cardId = `gap-${briefing.id}-${section.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${shortHash(section)}`;
        if (dismissed.has(cardId)) continue;

        let question = '';
        let artifact = null;

        if (family === 'completion') {
          question = `For ${briefing.id} (${section}): What are the core verified facts or key people that are missing?`;
        } else if (family === 'boundary') {
          question = `For ${briefing.id} (${section}): What are the hard boundaries, off-limits items, or non-negotiable constraints?`;
        } else if (family === 'case' || family === 'tradeoff') {
          question = `For ${briefing.id} (${section}): What are the active open decisions or decision principles you operate by here?`;
        } else if (family === 'assumption_probe') {
          question = `For ${briefing.id} (${section}): What key untested assumptions does this domain rely upon?`;
        } else if (family === 'critique') {
          artifact = `_Inbox/Critique_Artifacts/${briefing.id}_draft.md`;
          question = `Critique: What Madrone currently understands about ${briefing.id} is minimal. What is fundamentally wrong or missing in this area?`;
        }

        // Recency penalty: if asked within last 2 hours, reduce rank score
        const slotKey = `${consumerTag}:${section}`;
        const lastAsked = recencyMap[slotKey] || 0;
        const hoursAgo = (Date.now() - lastAsked) / (3600 * 1000);
        let recencyPenalty = 0;
        if (hoursAgo < 2.0) {
          recencyPenalty = Math.round(50 * (1.0 - hoursAgo / 2.0));
        }

        candidateCards.push({
          id: cardId,
          consumer: consumerTag,
          slot: section,
          family,
          badge: `${briefing.id.toUpperCase()} • ${section.toUpperCase()}`,
          question,
          budget_seconds: 120,
          max_followups: 1,
          artifact,
          grounding: 'briefing_gap',
          rankScore: Math.max(0, (1.0 - score) * priority - recencyPenalty),
          domainId: briefing.id
        });
      }
    }
  }

  // Pre-drive critique cards for low-coverage domains (at least 1-2)
  for (const briefing of rankedBriefings) {
    if (briefing.type === 'agent_briefing') continue;
    const factsScore = briefing.coverage ? (briefing.coverage['Facts'] || 0) : 0;
    if (factsScore < COVERAGE_THRESHOLD) {
      const critiqueId = `critique-${briefing.id}-${shortHash(briefing.id)}`;
      if (!dismissed.has(critiqueId) && !candidateCards.some(c => c.id === critiqueId)) {
        candidateCards.push({
          id: critiqueId,
          consumer: `domain:${briefing.id}`,
          slot: 'Facts',
          family: 'critique',
          badge: `${briefing.id.toUpperCase()} • CRITIQUE`,
          question: `Read Madrone's current belief about ${briefing.id}: what is inaccurate, outdated, or off-limits?`,
          budget_seconds: 120,
          max_followups: 1,
          artifact: `_Inbox/Critique_Artifacts/${briefing.id}_summary.md`,
          grounding: 'briefing_gap',
          rankScore: (1.0 - factsScore) * (briefing.priority || 50) + 10,
          domainId: briefing.id
        });
      }
    }
  }

  // Assumption Probes from allowlisted vault docs (cap 2)
  const docProbes = scanAssumptionProbes(workspace, options.extraAllowlist || []);
  let assumptionProbeCards = [];
  for (const probe of docProbes) {
    const pId = `probe-${shortHash(probe.quote)}`;
    if (dismissed.has(pId)) continue;
    assumptionProbeCards.push({
      id: pId,
      consumer: selectedDomain ? `domain:${selectedDomain}` : 'domain:madrone-context',
      slot: 'Assumptions',
      family: 'assumption_probe',
      badge: 'ASSUMPTION PROBE',
      question: `This document states: "${probe.quote}". Is this assumption still true? What evidence would change it?`,
      budget_seconds: 120,
      max_followups: 1,
      artifact: null,
      grounding: 'source_quote',
      docPath: probe.docPath,
      quote: probe.quote,
      rankScore: 100,
      domainId: selectedDomain || 'madrone-context'
    });
    if (assumptionProbeCards.length >= 2) break;
  }

  // Read Agent_Hypotheses from _Inbox
  const hDir = path.join(workspace, '_Inbox', 'Agent_Hypotheses');
  if (fs.existsSync(hDir)) {
    try {
      const files = fs.readdirSync(hDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(hDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = extractFrontmatter(content);
        const cardId = fm.id || `hyp-${file.replace(/\.md$/, '')}`;
        if (dismissed.has(cardId)) continue;
        candidateCards.push({
          id: cardId,
          consumer: 'domain:madrone-context',
          slot: 'Open decisions',
          family: 'tradeoff',
          badge: fm.badge || 'HYPOTHESIS',
          question: fm.question || (fm.summary ? `Background agents noted: "${fm.summary}". Does this represent an active project, decision, or priority?` : `Background agents noted: "${file.replace(/\.md$/, '')}". What is your stance?`),
          budget_seconds: 120,
          max_followups: 1,
          artifact: null,
          grounding: 'source_quote',
          rankScore: 200,
          domainId: 'madrone-context'
        });
      }
    } catch (e) {}
  }

  // Sort candidates by rankScore descending
  candidateCards.sort((a, b) => b.rankScore - a.rankScore);

  // If a specific domain was selected, prioritize domain cards first, then probes, then others as fallback
  let selectedPool = [];
  if (selectedDomain) {
    const matching = candidateCards.filter(c => c.domainId === selectedDomain);
    const nonMatching = candidateCards.filter(c => c.domainId !== selectedDomain);
    selectedPool = [...matching, ...assumptionProbeCards, ...nonMatching];
  } else {
    selectedPool = [...assumptionProbeCards, ...candidateCards];
  }

  // Deck Assembly Constraints (Sprint under 16 minutes)
  const brainDumpCard = {
    id: 'unprompted-brain-dump',
    is_freeform: true,
    badge: 'OPEN MIC',
    question: 'What is top of mind or unprompted context you want to download?',
    budget_seconds: 120,
    domain: selectedDomain || null,
    consumer: selectedDomain ? `domain:${selectedDomain}` : 'domain:personal',
    slot: 'Open decisions',
    family: 'open_mic',
    grounding: 'source_quote',
    max_followups: 0
  };

  const warmupCard = {
    id: 'warmup-readiness',
    badge: 'WARM-UP',
    question: 'How is your energy and cognitive focus right now?',
    budget_seconds: 60,
    consumer: selectedDomain ? `domain:${selectedDomain}` : 'domain:personal',
    slot: 'Facts',
    family: 'case',
    grounding: 'source_quote',
    max_followups: 0
  };

  const finalDeck = [brainDumpCard, warmupCard];
  const slotCount = {
    [`${warmupCard.consumer}:${warmupCard.slot}`]: 1
  };
  let totalBudget = brainDumpCard.budget_seconds + warmupCard.budget_seconds;
  const maxDeckSize = 8;
  const maxBudgetSeconds = 960; // 16 minutes

  for (const card of selectedPool) {
    if (finalDeck.length >= maxDeckSize) break;
    if (totalBudget + card.budget_seconds > maxBudgetSeconds) break;

    // Constraint: at most 2 per slot
    const slotKey = `${card.consumer}:${card.slot}`;
    if ((slotCount[slotKey] || 0) >= 2) continue;

    // Constraint: no two consecutive cards of the same family
    if (finalDeck.length > 0 && finalDeck[finalDeck.length - 1].family === card.family) {
      continue;
    }

    finalDeck.push(card);
    slotCount[slotKey] = (slotCount[slotKey] || 0) + 1;
    totalBudget += card.budget_seconds;
  }

  // Fallback 1: Fill up if family alternation constraint was too strict
  if (finalDeck.length < maxDeckSize) {
    for (const card of selectedPool) {
      if (finalDeck.length >= maxDeckSize) break;
      if (finalDeck.some(c => c.id === card.id)) continue;
      if (totalBudget + card.budget_seconds > maxBudgetSeconds) break;
      finalDeck.push(card);
      totalBudget += card.budget_seconds;
    }
  }

  // Record recency for generated deck
  if (options.recordRecency !== false && finalDeck.length > 2) {
    try {
      const now = Date.now();
      for (const card of finalDeck) {
        if (card && card.consumer && card.slot) {
          recencyMap[`${card.consumer}:${card.slot}`] = now;
        }
      }
      fs.mkdirSync(path.dirname(recencyFile), { recursive: true });
      fs.writeFileSync(recencyFile, JSON.stringify(recencyMap, null, 2), 'utf-8');
    } catch (_) {}
  }

  return finalDeck;
}

const FOLLOW_UP_TEMPLATES = {
  steelman_loser: (chosen, alternatives = 'leasing') =>
    `You're choosing to ${chosen}. What is the single strongest honest condition under which you'd choose ${alternatives} instead?`,
  pillar_weight: (pillars = []) =>
    pillars.length > 0
      ? `You mentioned ${pillars.join(', ')}. Which one of those is doing the most work in your decision?`
      : 'Which factor is doing most of the work in that decision?',
  stance_clarify: () =>
    'Is that decided, leaning, or still open?'
};

function countQuestions(prompt) {
  if (!prompt || typeof prompt !== 'string') return 0;
  const sentences = prompt.split(/(?<=[.?!])\s+/).filter(Boolean);
  let q = 0;
  for (const s of sentences) {
    if (/\?\s*$/.test(s)) q++;
    else if (/^(what|which|when|where|who|why|how|do|does|did|is|are|will|would|should|can|could)\b/i.test(s.trim())) q++;
  }
  const conjoined = prompt.match(/\b(and|or|also)\s+(what|which|when|where|who|why|how)\b/gi) || [];
  q += conjoined.length;
  return q;
}

function validateCard(card) {
  const errors = [];
  const q = countQuestions(card.question || card.prompt);
  if (q > 1) {
    errors.push({
      rule: 'ONE_QUESTION_PER_CARD',
      detail: `Detected ${q} questions in prompt. Cards must be atomic during transit.`,
      question: card.question
    });
  }
  return errors;
}

module.exports = {
  buildDeck,
  getDismissedCardIds,
  extractFrontmatterSummary,
  shortHash,
  countQuestions,
  validateCard,
  FOLLOW_UP_TEMPLATES,
  scanAssumptionProbes
};
