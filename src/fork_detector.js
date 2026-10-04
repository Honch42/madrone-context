'use strict';

/**
 * Madrone Fork & Surprise Detector.
 * Deterministically analyzes recent passive telemetry (OpenRecall screen OCR,
 * Git commit/diff activity, and active document dwell) to generate evidence-bound
 * candidate question cards for the proactive context interviewer.
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const openrecall = require('./openrecall');

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

/**
 * Extracts recent git activity in workspace or current repo.
 */
function getGitActivity(workspaceDir) {
  try {
    const gitDir = workspaceDir || process.cwd();
    const logOut = execSync('git log -n 3 --format="%h %s (%cr)" 2>/dev/null', { cwd: gitDir, encoding: 'utf-8', timeout: 2000 }).trim();
    const statusOut = execSync('git status --short 2>/dev/null', { cwd: gitDir, encoding: 'utf-8', timeout: 2000 }).trim();
    
    if (!logOut && !statusOut) return null;

    const modifiedFiles = statusOut
      ? statusOut.split('\n').slice(0, 5).map(l => l.trim().split(/\s+/).pop()).filter(Boolean)
      : [];
    const recentCommits = logOut ? logOut.split('\n').filter(Boolean) : [];

    return {
      recentCommits,
      modifiedFiles,
      hasUncommitted: modifiedFiles.length > 0
    };
  } catch (e) {
    return null;
  }
}

/**
 * Analyzes OpenRecall entries to detect focused activity clusters.
 */
async function getOpenRecallSurprises(limit = 10) {
  try {
    const res = await openrecall.getOpenRecallEntriesSince(0, { limit: 40 });
    if (!res.ok || !res.entries || res.entries.length === 0) return [];

    // Group by window title / topic to find high-dwell or distinct contexts
    const clusters = new Map();
    for (const entry of res.entries) {
      const key = `${entry.app}::${(entry.title || 'Untitled').slice(0, 40)}`;
      if (!clusters.has(key)) {
        clusters.set(key, {
          app: entry.app,
          title: entry.title,
          snippets: [],
          firstTs: entry.timestamp,
          lastTs: entry.timestamp,
          count: 0
        });
      }
      const c = clusters.get(key);
      c.count++;
      c.lastTs = Math.max(c.lastTs, entry.timestamp);
      if (entry.text && entry.text.length > 20 && c.snippets.length < 3) {
        c.snippets.push(entry.text.replace(/\s+/g, ' ').trim().slice(0, 160));
      }
    }

    const cards = [];
    for (const [key, cluster] of clusters.entries()) {
      if (cards.length >= limit) break;
      const snippet = cluster.snippets[0] || '';
      if (!cluster.title || cluster.title.length < 4) continue;

      const cardId = `telemetry-recall-${shortHash(key)}`;
      const cleanTitle = cluster.title.replace(/[\[\]]/g, '').trim();

      cards.push({
        id: cardId,
        kind: 'divergence',
        badge: 'SCREEN ACTIVITY',
        slot: 'surprise',
        priority: 95,
        observed: {
          app: cluster.app,
          title: cleanTitle,
          snippet: snippet,
          dwellCount: cluster.count
        },
        hypothesis: `Recent focused work in ${cluster.app} regarding "${cleanTitle}" represents an active decision fork or priority shift.`,
        question: `Recent telemetry shows you focused on "${cleanTitle}" in ${cluster.app}. What was the key realization or unexpected friction that drove this focus?`,
        context: `OpenRecall evidence: ${cluster.app} - ${cleanTitle} (OCR excerpt: "${snippet.slice(0, 100)}...")`,
        is_freeform: false
      });
    }

    return cards;
  } catch (e) {
    return [];
  }
}

/**
 * Detects surprises and returns evidence cards to prepend to the interview deck.
 */
async function detectSurprises({ workspaceDir, limit = 5 } = {}) {
  const cards = [];

  // 1. Check Git anomalies (uncommitted changes or recent commits)
  const git = getGitActivity(workspaceDir);
  if (git) {
    if (git.hasUncommitted && git.modifiedFiles.length > 0) {
      const fileList = git.modifiedFiles.slice(0, 3).join(', ');
      cards.push({
        id: `git-divergence-${shortHash(fileList)}`,
        kind: 'divergence',
        badge: 'CODEBASE FORK',
        slot: 'surprise',
        priority: 98,
        observed: {
          type: 'uncommitted_diff',
          files: git.modifiedFiles
        },
        hypothesis: `Active uncommitted changes across ${fileList} indicate a tactical pivot or architecture refactor in progress.`,
        question: `You currently have active changes in ${fileList}. What unexpected constraint or realization prompted this refactor?`,
        context: `Git working tree changes: ${fileList}`,
        is_freeform: false
      });
    } else if (git.recentCommits.length > 0) {
      const topCommit = git.recentCommits[0];
      cards.push({
        id: `git-commit-${shortHash(topCommit)}`,
        kind: 'divergence',
        badge: 'RECENT COMMIT',
        slot: 'surprise',
        priority: 92,
        observed: {
          type: 'recent_commit',
          commit: topCommit
        },
        hypothesis: `Recent commit "${topCommit}" represents a completed decision step that informs future architecture.`,
        question: `You recently committed "${topCommit}". What trade-off was the hardest to accept in that change?`,
        context: `Git commit log: ${topCommit}`,
        is_freeform: false
      });
    }
  }

  // 2. Check OpenRecall screen OCR activity
  const recallCards = await getOpenRecallSurprises(limit);
  cards.push(...recallCards);

  return cards.slice(0, limit);
}

function getOpenRecallSurprisesSync(limit = 10) {
  try {
    const dbPath = openrecall.findDatabase();
    if (!dbPath) return [];
    const { execFileSync } = require('child_process');
    const SEP = '\u001f';
    const sql = `SELECT id, app, title, substr(replace(text, char(10), ' '), 1, 300), timestamp FROM entries WHERE text IS NOT NULL AND length(text) > 0 ORDER BY timestamp DESC LIMIT 40;`;
    const out = execFileSync('sqlite3', ['-readonly', '-separator', SEP, dbPath, sql], { encoding: 'utf-8', timeout: 1500 });
    const lines = out.trim() ? out.trim().split('\n') : [];
    
    const clusters = new Map();
    for (const line of lines) {
      const [id, app, win, text, ts] = line.split(SEP);
      if (!app || !win) continue;
      const key = `${app}::${win.slice(0, 40)}`;
      if (!clusters.has(key)) {
        clusters.set(key, { app, title: win, snippets: [], count: 0 });
      }
      const c = clusters.get(key);
      c.count++;
      if (text && text.length > 20 && c.snippets.length < 2) {
        c.snippets.push(text.replace(/\s+/g, ' ').trim().slice(0, 160));
      }
    }

    const cards = [];
    for (const [key, cluster] of clusters.entries()) {
      if (cards.length >= limit) break;
      const cleanTitle = cluster.title.replace(/[\[\]]/g, '').trim();
      if (cleanTitle.length < 4) continue;
      const snippet = cluster.snippets[0] || '';
      cards.push({
        id: `telemetry-recall-${shortHash(key)}`,
        kind: 'divergence',
        badge: 'SCREEN ACTIVITY',
        slot: 'surprise',
        priority: 95,
        observed: {
          app: cluster.app,
          title: cleanTitle,
          snippet
        },
        hypothesis: `Recent focused work in ${cluster.app} regarding "${cleanTitle}" represents an active decision fork.`,
        question: `Recent telemetry shows you focused on "${cleanTitle}" in ${cluster.app}. What was the key realization or unexpected friction that drove this focus?`,
        context: `OpenRecall evidence: ${cluster.app} - ${cleanTitle} (OCR excerpt: "${snippet.slice(0, 100)}...")`,
        is_freeform: false
      });
    }
    return cards;
  } catch (e) {
    return [];
  }
}

function detectSurprisesSync({ workspaceDir, limit = 5 } = {}) {
  const cards = [];
  const git = getGitActivity(workspaceDir);
  if (git) {
    if (git.hasUncommitted && git.modifiedFiles.length > 0) {
      const fileList = git.modifiedFiles.slice(0, 3).join(', ');
      cards.push({
        id: `git-divergence-${shortHash(fileList)}`,
        kind: 'divergence',
        badge: 'CODEBASE FORK',
        slot: 'surprise',
        priority: 98,
        observed: {
          type: 'uncommitted_diff',
          files: git.modifiedFiles
        },
        hypothesis: `Active uncommitted changes across ${fileList} indicate a tactical pivot or architecture refactor in progress.`,
        question: `You currently have active changes in ${fileList}. What unexpected constraint or realization prompted this refactor?`,
        context: `Git working tree changes: ${fileList}`,
        is_freeform: false
      });
    } else if (git.recentCommits.length > 0) {
      const topCommit = git.recentCommits[0];
      cards.push({
        id: `git-commit-${shortHash(topCommit)}`,
        kind: 'divergence',
        badge: 'RECENT COMMIT',
        slot: 'surprise',
        priority: 92,
        observed: {
          type: 'recent_commit',
          commit: topCommit
        },
        hypothesis: `Recent commit "${topCommit}" represents a completed decision step that informs future architecture.`,
        question: `You recently committed "${topCommit}". What trade-off was the hardest to accept in that change?`,
        context: `Git commit log: ${topCommit}`,
        is_freeform: false
      });
    }
  }

  const recallCards = getOpenRecallSurprisesSync(limit);
  cards.push(...recallCards);
  return cards.slice(0, limit);
}

module.exports = {
  detectSurprises,
  detectSurprisesSync,
  getGitActivity,
  getOpenRecallSurprises,
  getOpenRecallSurprisesSync
};
