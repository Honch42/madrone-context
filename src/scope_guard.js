'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function getHostIdentity() {
  const allowEnvOverrides = process.env.MADRONE_ALLOW_ENV_OVERRIDES === '1';
  if (allowEnvOverrides && process.env.MADRONE_HOST_ROLE) {
    const raw = process.env.MADRONE_HOST_ROLE.trim();
    const match = raw.match(/^\s*role\s*[:=]\s*([a-zA-Z0-9_-]+)/i) || raw.match(/^([a-zA-Z0-9_-]+)$/);
    if (match) {
      return `role=${match[1].toLowerCase()}`;
    }
  }
  const hostIdentityPath = path.join(os.homedir(), '.gemini', 'host_identity');
  if (!fs.existsSync(hostIdentityPath)) {
    return 'role=unknown'; // Fail closed: missing identity file is unknown
  }
  try {
    const content = fs.readFileSync(hostIdentityPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*role\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
      if (match) {
        return `role=${match[1].toLowerCase()}`;
      }
    }
    return 'role=unknown';
  } catch (err) {
    return 'role=unknown';
  }
}

function verifyHostIdentity(identityString = null) {
  const identity = identityString ?? getHostIdentity();
  const match = String(identity || '').match(/^\s*role\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  const role = match ? match[1].toLowerCase() : null;

  if (role !== 'personal' && role !== 'headless') {
    const error = new Error('Access denied: deck generation is locked on non-personal host identity to prevent IP conflicts.');
    error.code = 'WORK_HOST_IDENTITY_LOCKED';
    throw error;
  }
  return true;
}

const ALLOWED_VAULT_PREFIXES = [
  path.join(os.homedir(), 'Documents', 'Obsidian', 'Personal'),
  path.join(os.homedir(), 'Documents', 'Obsidian', 'Madrone_Collective'),
  path.join(os.homedir(), 'Documents', 'Obsidian', 'Madrone_IV'),
  path.join(os.homedir(), 'Documents', 'Anti-gravity', 'Personal Context'),
  path.join(os.homedir(), 'Documents', 'MadroneContext')
];

function resolveRealPath(target) {
  if (!target || typeof target !== 'string') return null;
  try {
    let curr = path.resolve(target);
    const segments = [];
    while (curr) {
      let stats = null;
      try {
        stats = fs.lstatSync(curr);
      } catch (e) {
        stats = null;
      }
      if (stats) {
        try {
          const real = fs.realpathSync(curr);
          return segments.length ? path.join(real, ...segments) : real;
        } catch (_) {
          return null; // Fail closed if realpath throws
        }
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      segments.unshift(path.basename(curr));
      curr = parent;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isPathAllowed(targetPath, extraAllowlist = []) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const realTarget = resolveRealPath(targetPath);
  if (!realTarget) return false; // Fail closed on unresolvable paths or symlink errors

  // Explicit ban on Synergy Pet Group and work domains (evaluating both logical and symlink real paths)
  const lowerResolved = resolved.toLowerCase();
  const lowerReal = realTarget.toLowerCase();
  if (
    lowerResolved.includes('synergy_pet_group') || lowerResolved.includes('cv.vet') ||
    lowerReal.includes('synergy_pet_group') || lowerReal.includes('cv.vet')
  ) {
    return false;
  }

  const allowEnvOverrides = process.env.MADRONE_ALLOW_ENV_OVERRIDES === '1';
  const envExtra = (allowEnvOverrides && process.env.MADRONE_EXTRA_VAULT_PATHS)
    ? process.env.MADRONE_EXTRA_VAULT_PATHS.split(path.delimiter).map(p => p.trim()).filter(Boolean).map(p => path.resolve(p))
    : [];

  const allPrefixes = [
    ...ALLOWED_VAULT_PREFIXES,
    ...envExtra,
    ...extraAllowlist.map(p => path.resolve(p))
  ];

  // B1: Strict Real-to-Real containment! Logical path alone does NOT satisfy allowlist.
  return allPrefixes.some(prefix => {
    const realPrefix = resolveRealPath(prefix);
    if (!realPrefix) return false;
    return realTarget === realPrefix || realTarget.startsWith(realPrefix + path.sep);
  });
}

function assertPathAllowed(targetPath, extraAllowlist = []) {
  if (!isPathAllowed(targetPath, extraAllowlist)) {
    const error = new Error('Access denied: specified path is outside the personal vault allowlist.');
    error.code = 'VAULT_ALLOWLIST_VIOLATION';
    throw error;
  }
  return true;
}

module.exports = {
  getHostIdentity,
  verifyHostIdentity,
  isPathAllowed,
  assertPathAllowed,
  ALLOWED_VAULT_PREFIXES,
  resolveRealPath
};
