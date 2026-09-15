'use strict';
// Where sessions live on disk and how they are written.
//
// Everything the app writes goes under one folder inside the notes folder, so
// it sits tidily inside an Obsidian vault and is easy to move later:
//
// <notes folder>/Madrone/
//   master_dossier.md                  the cumulative profile the model maintains
//   Sessions/2026-09-11_1422_session.md   one note per saved session
//   People/<Name>.md, Projects/<Name>.md, Topics/<Name>.md
//                                      one note per person, project or topic the
//                                      sessions mention; session notes link to them
//   Madrone Sessions.base              an Obsidian Bases table of all sessions
//   dossier_history/                   copies of the dossier before each rewrite
//   archives/2026/09/<id>_video.webm   recordings (unless the recordings folder was moved)
//   sync_state.json                    last-saved timestamp used for "catch me up"
//
// The session id (YYYY-MM-DD_HHMM, local time) appears in the note's frontmatter,
// in the note filename and in the recording filename, so notes and recordings can
// always be matched up again even if the folders are moved apart.

const fs = require('fs');
const path = require('path');

const APP_FOLDER = 'Madrone';
const ENTITY_KINDS = { people: 'People', projects: 'Projects', topics: 'Topics' };
const ENTITY_TYPE = { people: 'person', projects: 'project', topics: 'topic' };

function pad(n) { return String(n).padStart(2, '0'); }

function newSessionId(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function defaultMediaDir(workspace) {
  return path.join(workspace, APP_FOLDER, 'archives');
}

// Paths that do not depend on a particular session.
function layoutPaths(settings) {
  const workspace = settings.workspaceDir;
  const root = path.join(workspace, APP_FOLDER);
  return {
    workspace,
    root,
    sessionsDir: path.join(root, 'Sessions'),
    historyDir: path.join(root, 'dossier_history'),
    dossierPath: path.join(root, 'master_dossier.md'),
    syncStatePath: path.join(root, 'sync_state.json'),
    basePath: path.join(root, 'Madrone Sessions.base'),
    peopleDir: path.join(root, ENTITY_KINDS.people),
    projectsDir: path.join(root, ENTITY_KINDS.projects),
    topicsDir: path.join(root, ENTITY_KINDS.topics),
    mediaRoot: settings.mediaDir || defaultMediaDir(workspace)
  };
}

function sessionPaths(settings, sessionId, date = new Date()) {
  const p = layoutPaths(settings);
  const mediaDir = path.join(p.mediaRoot, String(date.getFullYear()), pad(date.getMonth() + 1));
  return {
    ...p,
    notePath: path.join(p.sessionsDir, `${sessionId}_session.md`),
    mediaDir,
    videoPath: path.join(mediaDir, `${sessionId}_video.webm`),
    audioPath: path.join(mediaDir, `${sessionId}_audio.webm`)
  };
}

function ensureDirs(p) {
  for (const dir of [p.workspace, p.root, p.sessionsDir, p.historyDir, p.peopleDir, p.projectsDir, p.topicsDir, p.mediaDir].filter(Boolean)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Earlier versions wrote straight into the notes folder. Move those files into
// the app folder once; only files this app created, and never over an existing one.
function migrateLayout(settings) {
  const p = layoutPaths(settings);
  const moves = [
    [path.join(p.workspace, 'master_dossier.md'), p.dossierPath],
    [path.join(p.workspace, 'sync_state.json'), p.syncStatePath],
    [path.join(p.workspace, 'sessions'), p.sessionsDir],
    [path.join(p.workspace, 'dossier_history'), p.historyDir]
  ];
  const moved = [];
  for (const [from, to] of moves) {
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(to);
    } catch (e) { /* leave it where it is */ }
  }
  return moved;
}

// The Obsidian vault containing a folder, if any (walks up looking for .obsidian).
function findVaultRoot(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(current, '.obsidian'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function obsidianUrl(filePath) {
  return `obsidian://open?path=${encodeURIComponent(filePath)}`;
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
  fs.mkdirSync(p.root, { recursive: true });
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

// ---------------------------------------------------------------------------
// Entity notes (people, projects, topics): the nodes of the Obsidian graph.

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\[\]#^|\\/:*?"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeName(name) {
  return sanitizeName(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function entityDir(p, kind) {
  return { people: p.peopleDir, projects: p.projectsDir, topics: p.topicsDir }[kind];
}

// Names of every entity note that exists, by kind.
function listEntities(p) {
  const out = { people: [], projects: [], topics: [] };
  for (const kind of Object.keys(out)) {
    try {
      out[kind] = fs.readdirSync(entityDir(p, kind)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    } catch (e) { out[kind] = []; }
  }
  return out;
}

// Finds an existing entity note whose name matches loosely (case, punctuation).
function findEntity(p, kind, name) {
  const target = normalizeName(name);
  if (!target) return null;
  for (const existing of listEntities(p)[kind]) {
    if (normalizeName(existing) === target) return existing;
  }
  return null;
}

function readEntitySummary(p, kind, name, maxChars = 1200) {
  try {
    const text = stripFrontmatter(fs.readFileSync(path.join(entityDir(p, kind), `${name}.md`), 'utf-8')).trim();
    return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
  } catch (e) { return ''; }
}

function sessionLink(sessionId) {
  const label = sessionId.replace('_', ' ').replace(/(\d\d)(\d\d)(-\d+)?$/, '$1:$2$3');
  return `[[${sessionId}_session|${label}]]`;
}

// Creates or appends to an entity note and returns the name the note uses.
function upsertEntityNote(p, kind, entity, sessionId) {
  const requested = sanitizeName(entity.name);
  if (!requested) return null;
  const existing = findEntity(p, kind, requested);
  const name = existing || requested;
  const dir = entityDir(p, kind);
  const file = path.join(dir, `${name}.md`);
  fs.mkdirSync(dir, { recursive: true });
  const note = String(entity.note || '').replace(/\s+/g, ' ').trim();
  const mention = `- ${sessionLink(sessionId)}${note ? `: ${note}` : ''}`;

  if (!fs.existsSync(file)) {
    const today = new Date();
    const lines = [
      '---',
      `type: ${ENTITY_TYPE[kind]}`,
      'aliases: []',
      `created: ${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
      'tags:',
      '  - madrone-entity',
      `  - madrone-${ENTITY_TYPE[kind]}`,
      '---',
      `# ${name}`,
      '',
      note || `_Mentioned in Madrone Context sessions._`,
      '',
      '## Mentions',
      mention,
      ''
    ];
    fs.writeFileSync(file, lines.join('\n'));
    return name;
  }

  let text = fs.readFileSync(file, 'utf-8');
  if (text.includes(`[[${sessionId}_session`)) return name; // already recorded for this session
  if (/^## Mentions\s*$/m.test(text)) {
    text = text.replace(/(^## Mentions\s*\n)([\s\S]*?)(?=\n## |\s*$)/m, (m, heading, body) => `${heading}${body.replace(/\s+$/, '')}\n${mention}\n`);
  } else {
    text = text.replace(/\s*$/, '') + `\n\n## Mentions\n${mention}\n`;
  }
  fs.writeFileSync(file, text);
  return name;
}

// ---------------------------------------------------------------------------
// The Obsidian Bases file: a table of sessions. Written once; never overwritten,
// so the user can customise it.

const BASE_FILE = `filters:
  and:
    - file.hasTag("madrone-session")
properties:
  date:
    displayName: Date
  duration:
    displayName: Length
  energy:
    displayName: Energy
  confidence:
    displayName: Confidence
  incongruence:
    displayName: Incongruence flagged
  projects:
    displayName: Projects
  people:
    displayName: People
  topics:
    displayName: Topics
  model:
    displayName: Model
views:
  - type: table
    name: All sessions
    order:
      - file.name
      - date
      - duration
      - energy
      - confidence
      - projects
      - people
    sort:
      - property: date
        direction: DESC
  - type: table
    name: Flagged incongruence
    filters:
      and:
        - incongruence == true
    order:
      - file.name
      - date
      - projects
      - topics
    sort:
      - property: date
        direction: DESC
  - type: table
    name: By project
    groupBy:
      property: projects
      direction: ASC
    order:
      - file.name
      - date
      - energy
      - confidence
`;

function ensureBaseFile(p) {
  if (fs.existsSync(p.basePath)) return false;
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.basePath, BASE_FILE);
  return true;
}

// ---------------------------------------------------------------------------
// Session notes

function yamlLinkList(key, names) {
  if (!names || names.length === 0) return `${key}: []`;
  return [`${key}:`, ...names.map(n => `  - "[[${n}]]"`)].join('\n');
}

function recordingReference(p, mediaPath) {
  if (!mediaPath) return null;
  const vault = findVaultRoot(p.workspace) || p.workspace;
  const rel = path.relative(vault, mediaPath);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return {
    display: inside ? rel.split(path.sep).join('/') : mediaPath,
    // Inside the vault, Obsidian resolves a bare filename wherever it lives and plays it inline.
    embed: inside ? `![[${path.basename(mediaPath)}]]` : `[Recording](file://${encodeURI(mediaPath)})`
  };
}

function buildSessionNote(session) {
  const {
    sessionId, startedAt, endedAt, model, persona, summary, insights, synergy,
    transcript = [], mediaPath, mediaKind, videoAnalysis, paths, deepDive,
    entities = { people: [], projects: [], topics: [] }, scores = {},
    sessionType = null, extraSections = []
  } = session;
  const started = new Date(startedAt);
  const durationSec = endedAt ? (new Date(endedAt) - started) / 1000 : 0;
  const rec = recordingReference(paths, mediaPath);

  const fm = [
    '---',
    `session_id: ${sessionId}`,
    `date: ${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`,
    `time: ${yamlString(`${pad(started.getHours())}:${pad(started.getMinutes())}`)}`,
    `duration: ${yamlString(formatClock(durationSec))}`,
    `duration_min: ${Math.round(durationSec / 60)}`,
    `model: ${model}`,
    `persona: ${persona}`,
    `type: ${sessionType || (deepDive ? 'deep-dive' : 'interview')}`,
    yamlLinkList('people', entities.people),
    yamlLinkList('projects', entities.projects),
    yamlLinkList('topics', entities.topics),
    `energy: ${scores.energy ? yamlString(scores.energy) : '""'}`,
    `confidence: ${Number.isFinite(scores.confidence) ? scores.confidence : '""'}`,
    `incongruence: ${typeof scores.incongruence === 'boolean' ? scores.incongruence : '""'}`,
    `recording: ${rec ? yamlString(rec.display) : 'none'}`,
    `recording_kind: ${mediaKind || 'none'}`,
    `video_analysis: ${videoAnalysis || 'unavailable'}`,
    'tags:',
    '  - madrone-session',
    '---',
    ''
  ].join('\n');

  const lines = [];
  lines.push(`# Session ${sessionId.replace('_', ' ').replace(/(\d\d)(\d\d)(-\d+)?$/, '$1:$2$3')}`);
  lines.push('');
  const linkLine = [];
  if (entities.people.length) linkLine.push(`**People:** ${entities.people.map(n => `[[${n}]]`).join(', ')}`);
  if (entities.projects.length) linkLine.push(`**Projects:** ${entities.projects.map(n => `[[${n}]]`).join(', ')}`);
  if (entities.topics.length) linkLine.push(`**Topics:** ${entities.topics.map(n => `[[${n}]]`).join(', ')}`);
  if (linkLine.length) { lines.push(linkLine.join('  ·  ')); lines.push(''); }
  for (const sec of extraSections) {
    lines.push(`## ${sec.title}`);
    lines.push(String(sec.markdown || '').trim());
    lines.push('');
  }
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
  if (rec) {
    lines.push('## Recording');
    lines.push(rec.embed);
    lines.push(`\`${rec.display}\` (session id \`${sessionId}\`)`);
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
  APP_FOLDER,
  newSessionId,
  defaultMediaDir,
  layoutPaths,
  sessionPaths,
  ensureDirs,
  migrateLayout,
  findVaultRoot,
  obsidianUrl,
  readDossier,
  backupDossier,
  writeDossier,
  buildSessionNote,
  writeSessionNote,
  deleteSessionMedia,
  formatClock,
  stripFrontmatter,
  sanitizeName,
  normalizeName,
  listEntities,
  findEntity,
  readEntitySummary,
  upsertEntityNote,
  ensureBaseFile
};
