'use strict';
// Model adapters. Every provider exposes the same small interface so the
// orchestrator never needs to know which vendor it is talking to:
//
//   respond(text)                 -> string        (a text turn, with tool calls if supported)
//   respondToAudio(buffer, mime)  -> { raw, parsed, transcript }
//   transcribe(buffer, mime)      -> string        (always Gemini Flash)
//   analyzeVideo(path, prompt)    -> string | null (Gemini only)
//   oneShot(prompt, opts)         -> string        (no history; used for the dossier rewrite)
//   supportsVideo, supportsTools

const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { AUDIO_TURN_PROMPT, transcriptTurnPrompt } = require('./prompts');
const { ANTHROPIC_PROFILE_AUTH } = require('./config');

// The lightweight model that turns audio into text for the non-Gemini "hybrid" path.
const TRANSCRIBE_MODEL = 'gemini-3.6-flash';

const MODELS = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', vendor: 'gemini', video: true, note: 'Fast. Analyzes the session video.' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', vendor: 'gemini', video: true, note: 'Deeper reasoning. Analyzes the session video.' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vendor: 'anthropic', video: false, note: 'Transcript-based. Can read your notes folder.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', vendor: 'anthropic', video: false, note: 'Most capable. Transcript-based. Can read your notes folder.' },
  { id: 'gpt-4o', label: 'GPT-4o', vendor: 'openai', video: false, note: 'Transcript-based. Can read your notes folder.' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', vendor: 'openai', video: false, note: 'Fast and inexpensive. Transcript-based.' }
];

const VENDOR_LABEL = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' };

function modelInfo(id) {
  return MODELS.find(m => m.id === id) || null;
}

// Which models can run with the keys the user has entered. Every non-Gemini
// model also needs a Gemini key, because Gemini Flash does the transcription.
function availableModels(keys) {
  return MODELS.map(m => {
    const missing = [];
    if (!keys.gemini) missing.push('Gemini');
    if (m.vendor !== 'gemini' && !keys[m.vendor]) missing.push(VENDOR_LABEL[m.vendor]);
    return { ...m, available: missing.length === 0, missing };
  });
}

// Pulls a JSON object out of model output that may be wrapped in prose or fences.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  return null;
}

function toolResultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------

class GeminiTranscriber {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey });
  }
  async transcribe(buffer, mime) {
    const res = await this.ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: [{ role: 'user', parts: [
        { inlineData: { data: buffer.toString('base64'), mimeType: mime } },
        { text: 'Transcribe this audio verbatim. Output ONLY the transcription, nothing else. If there is no speech, output an empty string.' }
      ] }]
    });
    return (res.text || '').trim();
  }
}

class GeminiProvider {
  constructor({ modelId, apiKey, systemPrompt, log }) {
    this.modelId = modelId;
    this.ai = new GoogleGenAI({ apiKey });
    this.systemPrompt = systemPrompt;
    this.history = [];
    this.transcriber = new GeminiTranscriber(apiKey);
    this.supportsVideo = true;
    this.supportsTools = false;
    this.log = log || (() => {});
  }

  async _generate(parts, { json = true, includeHistory = true } = {}) {
    const contents = includeHistory ? [...this.history, { role: 'user', parts }] : [{ role: 'user', parts }];
    const config = { systemInstruction: this.systemPrompt, temperature: 0.7 };
    if (json) config.responseMimeType = 'application/json';
    const res = await this.ai.models.generateContent({ model: this.modelId, contents, config });
    return (res.text || '').trim();
  }

  async respond(text) {
    const out = await this._generate([{ text }]);
    this.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: out }] });
    return out;
  }

  async respondToAudio(buffer, mime, note = '') {
    const parts = [{ inlineData: { data: buffer.toString('base64'), mimeType: mime } }, { text: AUDIO_TURN_PROMPT + note }];
    const out = await this._generate(parts);
    const parsed = extractJson(out);
    const transcript = parsed && typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
    // Keep the transcript in history rather than the audio itself, so requests
    // stay small no matter how long the session runs.
    this.history.push(
      { role: 'user', parts: [{ text: transcript ? `[The user said]: ${transcript}` : '[The user spoke; no transcript was produced]' }] },
      { role: 'model', parts: [{ text: out }] }
    );
    return { raw: out, parsed, transcript };
  }

  transcribe(buffer, mime) {
    return this.transcriber.transcribe(buffer, mime);
  }

  async analyzeVideo(filePath, prompt) {
    let file = await this.ai.files.upload({ file: filePath, config: { mimeType: 'video/webm' } });
    const deadline = Date.now() + 10 * 60 * 1000;
    while (file.state === 'PROCESSING') {
      if (Date.now() > deadline) throw new Error('Video processing timed out.');
      await new Promise(r => setTimeout(r, 2000));
      file = await this.ai.files.get({ name: file.name });
    }
    if (file.state === 'FAILED') throw new Error('Gemini could not process the video file.');
    const parts = [{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }, { text: prompt }];
    const out = await this._generate(parts);
    try { await this.ai.files.delete({ name: file.name }); } catch (e) { /* best effort */ }
    return out;
  }

  async oneShot(prompt) {
    const res = await this.ai.models.generateContent({ model: this.modelId, contents: prompt });
    return (res.text || '').trim();
  }
}

// ---------------------------------------------------------------------------

class AnthropicProvider {
  constructor({ modelId, apiKey, geminiKey, systemPrompt, tools, log }) {
    this.modelId = modelId;
    // With no key the SDK resolves the user's `ant auth login` profile itself.
    this.client = apiKey === ANTHROPIC_PROFILE_AUTH ? new Anthropic() : new Anthropic({ apiKey });
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.history = [];
    this.transcriber = new GeminiTranscriber(geminiKey);
    this.supportsVideo = false;
    this.supportsTools = true;
    this.log = log || (() => {});
  }

  _toolDefs() {
    const list = this.tools ? this.tools.list() : [];
    if (!list.length) return undefined;
    return list.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }

  async _run() {
    for (let round = 0; round < 8; round++) {
      const payload = { model: this.modelId, max_tokens: 4096, system: this.systemPrompt, messages: this.history };
      const toolDefs = this._toolDefs();
      if (toolDefs) payload.tools = toolDefs;
      const msg = await this.client.messages.create(payload);
      this.history.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'tool_use') {
        const results = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          this.log(`Claude tool call: ${block.name}`);
          try {
            const result = await this.tools.call(block.name, block.input);
            results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultText(result) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
          }
        }
        this.history.push({ role: 'user', content: results });
        continue;
      }
      return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }
    return '';
  }

  async respond(text) {
    this.history.push({ role: 'user', content: text });
    return this._run();
  }

  async respondToAudio(buffer, mime, note = '') {
    const transcript = await this.transcriber.transcribe(buffer, mime);
    const out = await this.respond(transcriptTurnPrompt(transcript || '(no speech detected)') + note);
    const parsed = extractJson(out);
    if (parsed) parsed.transcript = transcript;
    return { raw: out, parsed, transcript };
  }

  transcribe(buffer, mime) {
    return this.transcriber.transcribe(buffer, mime);
  }

  async analyzeVideo() { return null; }

  async oneShot(prompt, { maxTokens = 16000 } = {}) {
    const stream = this.client.messages.stream({ model: this.modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    const msg = await stream.finalMessage();
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
}

// ---------------------------------------------------------------------------

class OpenAIProvider {
  constructor({ modelId, apiKey, geminiKey, systemPrompt, tools, log }) {
    this.modelId = modelId;
    this.client = new OpenAI({ apiKey });
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.history = [];
    this.transcriber = new GeminiTranscriber(geminiKey);
    this.supportsVideo = false;
    this.supportsTools = true;
    this.log = log || (() => {});
  }

  _toolDefs() {
    const list = this.tools ? this.tools.list() : [];
    if (!list.length) return undefined;
    return list.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }

  async _run({ json = true } = {}) {
    for (let round = 0; round < 8; round++) {
      const payload = { model: this.modelId, messages: [{ role: 'system', content: this.systemPrompt }, ...this.history] };
      const toolDefs = this._toolDefs();
      if (toolDefs) payload.tools = toolDefs;
      if (json) payload.response_format = { type: 'json_object' };
      const res = await this.client.chat.completions.create(payload);
      const choice = res.choices[0].message;
      if (choice.tool_calls && choice.tool_calls.length) {
        this.history.push({ role: 'assistant', content: choice.content || null, tool_calls: choice.tool_calls });
        for (const tc of choice.tool_calls) {
          this.log(`${this.modelId} tool call: ${tc.function.name}`);
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* ignore */ }
          let content;
          try { content = toolResultText(await this.tools.call(tc.function.name, args)); } catch (e) { content = `Error: ${e.message}`; }
          this.history.push({ role: 'tool', tool_call_id: tc.id, content });
        }
        continue;
      }
      const text = (choice.content || '').trim();
      this.history.push({ role: 'assistant', content: text });
      return text;
    }
    return '';
  }

  async respond(text) {
    this.history.push({ role: 'user', content: text });
    return this._run();
  }

  async respondToAudio(buffer, mime, note = '') {
    const transcript = await this.transcriber.transcribe(buffer, mime);
    const out = await this.respond(transcriptTurnPrompt(transcript || '(no speech detected)') + note);
    const parsed = extractJson(out);
    if (parsed) parsed.transcript = transcript;
    return { raw: out, parsed, transcript };
  }

  transcribe(buffer, mime) {
    return this.transcriber.transcribe(buffer, mime);
  }

  async analyzeVideo() { return null; }

  async oneShot(prompt) {
    const res = await this.client.chat.completions.create({ model: this.modelId, messages: [{ role: 'user', content: prompt }] });
    return (res.choices[0].message.content || '').trim();
  }
}

// ---------------------------------------------------------------------------

function createProvider({ modelId, keys, systemPrompt, tools, log }) {
  const info = modelInfo(modelId);
  if (!info) throw new Error(`Unknown model "${modelId}".`);
  if (!keys.gemini) throw new Error('A Gemini API key is required. Add one in Settings.');
  if (info.vendor === 'gemini') return new GeminiProvider({ modelId, apiKey: keys.gemini, systemPrompt, log });
  if (info.vendor === 'anthropic') {
    if (!keys.anthropic) throw new Error('Claude models need an Anthropic API key or an Anthropic CLI sign-in. Add one in Settings.');
    return new AnthropicProvider({ modelId, apiKey: keys.anthropic, geminiKey: keys.gemini, systemPrompt, tools, log });
  }
  if (!keys.openai) throw new Error('An OpenAI API key is required for GPT models. Add one in Settings.');
  return new OpenAIProvider({ modelId, apiKey: keys.openai, geminiKey: keys.gemini, systemPrompt, tools, log });
}

module.exports = { MODELS, TRANSCRIBE_MODEL, modelInfo, availableModels, extractJson, createProvider, toolResultText };
