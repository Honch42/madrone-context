'use strict';

const jsyaml = require('js-yaml');

/**
 * Normalizes Date objects to YYYY-MM-DD string format to prevent timestamp/TZ ballooning.
 */
function normalizeDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj instanceof Date) {
    return obj.toISOString().slice(0, 10);
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeDates);
  }
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Date) {
      res[k] = v.toISOString().slice(0, 10);
    } else if (v && typeof v === 'object') {
      res[k] = normalizeDates(v);
    } else {
      res[k] = v;
    }
  }
  return res;
}

/**
 * Strips undefined values to prevent js-yaml throw.
 */
function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      res[k] = typeof v === 'object' && v !== null ? stripUndefined(v) : v;
    }
  }
  return res;
}

/**
 * Parses frontmatter and body from markdown content.
 * Strips UTF-8 BOM, requires valid fence delimiters, and fails safely.
 * @param {string} content
 * @returns {{ meta: Record<string, any>, body: string }}
 */
function parse(content) {
  if (!content || typeof content !== 'string') {
    return { meta: {}, body: '' };
  }

  // Strip leading UTF-8 BOM if present
  const clean = content.replace(/^\uFEFF/, '');

  // Match standard frontmatter: ^---(?:\r?\n(yaml))?\r?\n---\s*(\r?\n|$)(body)
  const match = clean.match(/^---(?:\r?\n([\s\S]*?))?\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: clean };
  }

  const rawYaml = match[1] || '';
  const body = match[2] || '';

  // Empty frontmatter: --- \n ---
  if (!rawYaml.trim()) {
    return { meta: {}, body };
  }

  try {
    const parsed = jsyaml.load(rawYaml, {
      schema: jsyaml.DEFAULT_SCHEMA
    });

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        meta: normalizeDates(parsed),
        body
      };
    }
    return { meta: {}, body };
  } catch (e) {
    console.warn('[frontmatter] YAML parse error:', e.message);
    return { meta: {}, body: clean };
  }
}

/**
 * Serializes metadata object and body into markdown with YAML frontmatter.
 * Ensures clean YYYY-MM-DD dates, handles undefined, and avoids YAML bloat.
 * @param {Record<string, any>} meta
 * @param {string} [body]
 * @returns {string}
 */
function serialize(meta, body = '') {
  const safeMeta = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const cleanedMeta = stripUndefined(normalizeDates(safeMeta));

  let yamlStr = '';
  try {
    yamlStr = jsyaml.dump(cleanedMeta, {
      schema: jsyaml.DEFAULT_SCHEMA,
      lineWidth: -1,
      noRefs: true,
      skipInvalid: true,
      quotingType: '"'
    });
  } catch (e) {
    console.error('[frontmatter] Serialization error:', e.message);
    yamlStr = '';
  }

  const cleanBody = (body || '').replace(/^\r?\n+/, '');
  if (!yamlStr.trim()) {
    return cleanBody;
  }
  return `---\n${yamlStr}---\n\n${cleanBody}`;
}

module.exports = {
  parse,
  serialize,
  normalizeDates,
  stripUndefined
};
