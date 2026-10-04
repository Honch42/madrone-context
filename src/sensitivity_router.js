'use strict';

const fs = require('fs');
const path = require('path');

const HEALTH_TERMS = /\b(foundayo|endeo|dose|dosage|titrat(e|ing|ion)|prescri(be|ption)|refill|pharmac(y|ist)|side\s+effect|symptom|diagnos(is|ed)?|medication|medicine|nausea|therap(y|ist)|psychiatr(y|ist)|anxiety|depress(ion)?|blood\s+pressure|insulin|sleep\s+med|adhd|ssri)\b/i;

/**
 * Classifies text or extraction objects for sensitive routing.
 * Returns:
 * {
 *   isSensitive: boolean,
 *   level: 'strategy' | 'restricted' | 'private',
 *   categories: string[],
 *   redactedText: string,
 *   redactedSpans: Array<{ match: string, index: number }>
 * }
 */
function classifySensitivity(text, entities = []) {
  if (!text || typeof text !== 'string') {
    return { isSensitive: false, level: 'strategy', categories: [], redactedText: '', redactedSpans: [] };
  }

  const matches = [];
  let m;
  const regex = new RegExp(HEALTH_TERMS.source, 'gi');
  while ((m = regex.exec(text)) !== null) {
    matches.push({ match: m[0], index: m.index });
  }

  // Also check entities for medication/health types
  const hasHealthEntity = entities.some(e => {
    const t = String(e.type || e.kind || '').toLowerCase();
    const name = String(e.name || e.mention || '').toLowerCase();
    return t === 'medication' || t === 'condition' || HEALTH_TERMS.test(name);
  });

  const isSensitive = matches.length > 0 || hasHealthEntity;
  if (!isSensitive) {
    return {
      isSensitive: false,
      level: 'strategy',
      categories: [],
      redactedText: text,
      redactedSpans: []
    };
  }

  // Determine if it's completely health-related or a mixed turn
  const totalLength = text.trim().length;
  const isPureHealth = totalLength < 300 || matches.length >= 3;

  // Generate redacted string for public / strategy views
  let redacted = text;
  let counter = 1;
  redacted = redacted.replace(regex, (match) => {
    return `[REDACTED:health:va_${String(counter++).padStart(4, '0')}]`;
  });

  return {
    isSensitive: true,
    level: isPureHealth ? 'private' : 'restricted',
    categories: ['health', 'medication'],
    redactedText: redacted,
    redactedSpans: matches
  };
}

/**
 * Resolves the private isolated directory for health and personal sensitive data.
 */
function getPrivateDir(workspaceDir) {
  const p = path.join(workspaceDir, '_Private', 'Health');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
  return p;
}

module.exports = {
  HEALTH_TERMS,
  classifySensitivity,
  getPrivateDir
};
