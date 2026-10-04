'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

const DEFAULT_LEXICON_PATH = path.join(__dirname, '..', 'config', 'lexicon.yaml');

class Lexicon {
  constructor(configPath = DEFAULT_LEXICON_PATH) {
    this.terms = [];
    this.hash = '00000000';
    this.byAlias = new Map();
    this.byCanonical = new Map();
    this.load(configPath);
  }

  load(configPath) {
    let doc = null;
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        doc = yaml.load(raw);
      } catch (e) {
        console.warn('[lexicon] Failed to parse lexicon yaml, using defaults:', e.message);
      }
    }

    if (!doc || !Array.isArray(doc.terms)) {
      doc = {
        version: 1,
        terms: [
          { canonical: 'Foundayo', kind: 'medication', sensitivity: 'health', aliases: ['found ayo', 'fondayo', 'endeo'], boost: 3 },
          { canonical: 'Pax', kind: 'person', aliases: ['packs', 'pacs', 'pat'], boost: 2 },
          { canonical: 'barndominium', kind: 'asset_type', aliases: ['barn dominium', 'barn-dominium', 'barnamiento'], boost: 2 },
          { canonical: 'Ventana', kind: 'place', aliases: ['ventanna', 'ben tana'], boost: 2 },
          { canonical: 'Knights Ferry', kind: 'place', aliases: ['nights ferry', "knight's ferry"], boost: 2 },
          { canonical: 'Moab', kind: 'place', aliases: ['mo ab', 'moe ab'], boost: 2 },
          { canonical: 'SPG', kind: 'org', aliases: ['s p g', 's.p.g.', 'espy gee'], boost: 3 },
          { canonical: 'Washoe', kind: 'place', aliases: ['washo', 'wash oh'], boost: 2 }
        ]
      };
    }

    this.terms = doc.terms;
    this.hash = crypto.createHash('sha1').update(JSON.stringify(doc)).digest('hex').slice(0, 8);
    this._buildIndex();
  }

  _buildIndex() {
    this.byAlias.clear();
    this.byCanonical.clear();

    for (const term of this.terms) {
      this.byCanonical.set(term.canonical.toLowerCase(), term);
      const allAliases = [term.canonical, ...(term.aliases || [])];
      for (const a of allAliases) {
        this.byAlias.set(a.toLowerCase().trim(), term);
      }
    }
  }

  /**
   * Generates provider-specific hints.
   */
  toProviderHints(provider = 'google') {
    const p = String(provider).toLowerCase();
    if (p.includes('deepgram')) {
      return { keywords: this.terms.map(t => `${t.canonical}:${t.boost || 2}`) };
    }
    if (p.includes('google') || p.includes('gemini')) {
      return {
        speechContexts: [{
          phrases: this.terms.flatMap(t => [t.canonical, ...(t.aliases || [])]),
          boost: 15
        }]
      };
    }
    // Whisper / default: initial_prompt format
    return {
      initial_prompt: `Glossary: ${this.terms.map(t => t.canonical).join(', ')}. Context: real estate, tax domicile, startup ventures, and family logistics.`
    };
  }

  /**
   * Post-corrects transcript text by replacing recognized aliases with canonical terms.
   * Returns { text, applied: [{ from, to, pos }] }
   */
  postCorrect(text) {
    if (!text || typeof text !== 'string') return { text: '', applied: [], lexicon_hash: this.hash };

    let result = text;
    const applied = [];

    // Sort aliases by descending length so multi-word aliases match before substrings
    const sortedAliases = Array.from(this.byAlias.entries()).sort((a, b) => b[0].length - a[0].length);

    for (const [aliasLower, term] of sortedAliases) {
      if (aliasLower === term.canonical.toLowerCase()) continue; // Skip identical

      // Word boundary regex
      const escaped = aliasLower.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');

      let match;
      while ((match = regex.exec(result)) !== null) {
        const originalWord = match[0];
        applied.push({
          from: originalWord,
          to: term.canonical,
          index: match.index
        });
      }

      result = result.replace(regex, term.canonical);
    }

    return {
      text: result,
      applied,
      lexicon_hash: this.hash
    };
  }

  /**
   * Checks if a term or phrase is flagged as sensitive (e.g. health/medication).
   */
  getSensitivity(word) {
    if (!word) return null;
    const term = this.byAlias.get(word.toLowerCase().trim());
    return term ? term.sensitivity || null : null;
  }
}

let defaultInstance = null;
function getLexicon(configPath) {
  if (!defaultInstance || configPath) {
    defaultInstance = new Lexicon(configPath);
  }
  return defaultInstance;
}

module.exports = {
  Lexicon,
  getLexicon
};
