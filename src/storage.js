'use strict';
// Where sessions live on disk and how they are written.
//
// <workspace>/
//   master_dossier.md                        the cumulative profile the model maintains
//   sessions/2026-09-11_1422_session.md      one note per saved session
//   dossier_history/master_dossier_<id>.md   copy of the dossier before each rewrite
//   archives/2026/09/2026-09-11_1422_video.webm   (or elsewhere if mediaDir is changed)
//
// The session id (YYYY-MM-DD_HHMM, local time) appears in the note's frontmatter,
// in the note filename and in the recording filename, so notes and recordings can
// always be matched up again even if the folders are moved apart.

const fs = require('fs');
const path = require('path');

function pad(n) { return String(n).padStart(2, '0'); }

function newSessionId(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function sessionPaths(settings, sessionId, date = new Date()) {
  const workspace = settings.workspaceDir;
  const mediaRoot = settings.mediaDir || path.join(workspace, 'archives');
  const mediaDir = path.join(mediaRoot, String(date.getFullYear()), pad(date.getMonth() + 1));
  return {
    workspace,
    sessionsDir: path.join(workspace, 'sessions'),
    historyDir: path.join(workspace, 'dossier_history'),
    dossierPath: path.join(workspace, 'master_dossier.md'),
    notePath: path.join(workspace, 'sessions', `${sessionId}_session.md`),
    mediaDir,
    videoPath: path.join(mediaDir, `${sessionId}_video.webm`),
    audioPath: path.join(mediaDir, `${sessionId}_audio.webm`)
  };
}

function ensureDirs(p) {
  for (const dir of [p.workspace, p.sessionsDir, p.historyDir, p.mediaDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readDossier(p) {
  try { return fs.readFileSync(p.dossierPath, 'utf-8'); } catch (e) { return ''; }
}

// Copies the current dossier aside before it is overwritten, so nothing the
// model drops during a rewrite is ever lost for good.
function backupDossier(p, sessionId) {
  if (!fs.existsSync(p.dossierPath)) return null;
  fs.mkdirSync(p.historyDir, { recursive: true });
  const dest = path.join(p.historyDir, `master_dossier_${sessionId}.md`);
  fs.copyFileSync(p.dossierPath, dest);
  return dest;
}

function writeDossier(p, text) {
  fs.mkdirSync(p.workspace, { recursive: true });
  fs.writeFileSync(p.dossierPath, text);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// Strips a leading YAML frontmatter block from model output; we write our own.
function stripFrontmatter(md) {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(md || '');
  return m ? md.slice(m[0].length) : (md || '');
}

function yamlString(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function relativeMediaPath(p, mediaPath) {
  if (!mediaPath) return null;
  const rel = path.relative(p.workspace, mediaPath);
  return rel.startsWith('..') ? mediaPath : rel.split(path.sep).join('/');
}

function buildSessionNote(session) {
  const {
    sessionId, startedAt, endedAt, model, persona, summary, insights, synergy,
    transcript = [], mediaPath, mediaKind, videoAnalysis, paths, deepDive
  } = session;
  const started = new Date(startedAt);
  const durationSec = endedAt ? (new Date(endedAt) - started) / 1000 : 0;
  const media = relativeMediaPath(paths, mediaPath);

  const fm = [
    '---',
    `session_id: ${sessionId}`,
    `date: ${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`,
    `time: ${yamlString(`${pad(started.getHours())}:${pad(started.getMinutes())}`)}`,
    `duration: ${yamlString(formatClock(durationSec))}`,
    `model: ${model}`,
    `persona: ${persona}`,
    `recording: ${media ? yamlString(media) : 'none'}`,
    `recording_kind: ${mediaKind || 'none'}`,
    `video_analysis: ${videoAnalysis || 'unavailable'}`,
    `type: ${deepDive ? 'deep-dive' : 'interview'}`,
    'tags:',
    '  - madrone-session',
    '---',
    ''
  ].join('\n');

  const lines = [];
  lines.push(`# Session ${sessionId.replace('_', ' ').replace(/(\d\d)(\d\d)$/, '$1:$2')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(stripFrontmatter(summary || 'No summary was generated.').trim());
  lines.push('');
  lines.push('## Insights');
  lines.push(stripFrontmatter(insights || 'No insights were generated.').trim());
  lines.push('');
  lines.push('## Behavioral alignment');
  if (videoAnalysis === 'done') {
    lines.push(stripFrontmatter(synergy || 'No discrepancies were detected.').trim());
  } else if (videoAnalysis === 'failed') {
    lines.push('Video analysis failed for this session. The recording is archived and can be analyzed later.');
  } else {
    lines.push('Not analyzed. This model does not analyze video; the recording is archived for later analysis.');
  }
  lines.push('');
  lines.push('## Transcript');
  if (transcript.length === 0) {
    lines.push('_No transcript was captured._');
  } else {
    for (const t of transcript) {
      const who = t.role === 'ai' ? 'AI' : 'You';
      lines.push(`- **${formatClock(t.at)} ${who}:** ${String(t.text || '').replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push('');
  if (media) {
    lines.push('## Recording');
    lines.push(`\`${media}\` (session id \`${sessionId}\`)`);
    lines.push('');
  }
  return fm + lines.join('\n');
}

function writeSessionNote(session) {
  const p = session.paths;
  fs.mkdirSync(p.sessionsDir, { recursive: true });
  fs.writeFileSync(p.notePath, buildSessionNote(session));
  return p.notePath;
}

function deleteSessionMedia(session) {
  const removed = [];
  for (const f of [session.paths.videoPath, session.paths.audioPath]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(f); } } catch (e) { /* ignore */ }
  }
  return removed;
}

module.exports = {
  newSessionId,
  sessionPaths,
  ensureDirs,
  readDossier,
  backupDossier,
  writeDossier,
  buildSessionNote,
  writeSessionNote,
  deleteSessionMedia,
  formatClock,
  stripFrontmatter
};
