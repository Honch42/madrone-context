const fs = require('fs');
const path = require('path');
const os = require('os');
const { createProvider } = require('./providers.js');
const { getOpenRecallEntriesSince } = require('./openrecall.js');

const STATE_FILE = path.join(os.homedir(), '.madrone_distiller_state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { last_distilled_ts: 0, last_run_iso: null };
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[distiller] Failed to save state:', e.message);
  }
}

async function distillIfNeeded(keys, settings = {}) {
  const now = Date.now();
  const state = readState();

  // Throttle: don't run more than once every 60 minutes unless forced
  if (state.last_run_iso) {
    const elapsedMinutes = (now - new Date(state.last_run_iso).getTime()) / (1000 * 60);
    if (elapsedMinutes < 60) {
      console.log(`[distiller] Throttled: last run was ${Math.round(elapsedMinutes)} minutes ago.`);
      return;
    }
  }

  // Fetch entries since high-water mark (or past 4 hours if first run)
  const fallbackSince = Math.floor((now - 4 * 60 * 60 * 1000) / 1000);
  const sinceTs = state.last_distilled_ts > 0 ? state.last_distilled_ts : fallbackSince;

  const result = await getOpenRecallEntriesSince(sinceTs, {
    customDbPath: settings.openrecallDbPath,
    limit: 40
  });

  if (!result.ok) {
    console.log('[distiller]', result.notice);
    return;
  }

  if (!result.entries || result.entries.length < 3) {
    console.log('[distiller] Not enough new screen captures to distill.');
    state.last_run_iso = new Date(now).toISOString();
    writeState(state);
    return;
  }

  const lines = result.entries.map(e => {
    const time = new Date(e.timestamp * 1000).toLocaleTimeString();
    return `[${time}] ${e.app} (${e.title}): ${e.text.substring(0, 160)}`;
  });

  const prompt = `
Your job is to read recent screen OCR activity logs from John's computer and generate a structured context hypothesis about his current focus, blockers, or strategic tasks.

Recent screen captures:
${lines.join('\n')}

Output ONLY valid Markdown with:
# Title (Short descriptive title of what he was doing)
**Observation:** What key applications, documents, or tasks were on screen.
**Hypothesis & Next Steps:** What goal is being pursued and what context should be verified in his next review session.
`;

  try {
    const modelId = settings.distillerModel || "gemini-2.5-flash";
    const provider = createProvider({
      modelId,
      keys,
      systemPrompt: "You are the OpenRecall Distiller agent. Be concise, concrete, and insightful."
    });

    const hypothesisText = await provider.oneShot(prompt);
    const isoTimestamp = new Date(now).toISOString();
    const newestTs = Math.max(...result.entries.map(e => e.timestamp));

    const frontmatter = `---
schema: core.project/v1
status: hypothesis
confidence: 0.8
sources: [openrecall:${isoTimestamp}]
created_by: openrecall-distiller
verified_by: 
verified_at: 
---

`;

    const finalContent = frontmatter + hypothesisText;
    const vaultPath = (settings.workspaceDir && fs.existsSync(settings.workspaceDir))
      ? settings.workspaceDir
      : path.join(os.homedir(), "Documents", "Personal_Context_Vault");

    const targetDir = path.join(vaultPath, "_Inbox", "Agent_Hypotheses");
    fs.mkdirSync(targetDir, { recursive: true });

    const filename = `openrecall_hypothesis_${Date.now()}.md`;
    const targetPath = path.join(targetDir, filename);

    fs.writeFileSync(targetPath, finalContent, "utf-8");
    console.log(`[distiller] Hypothesis written to ${targetPath}`);

    // Update state high-water mark
    state.last_distilled_ts = newestTs;
    state.last_run_iso = isoTimestamp;
    writeState(state);
  } catch (e) {
    console.error('[distiller] Distillation failed:', e.message);
  }
}

module.exports = { distillIfNeeded };
