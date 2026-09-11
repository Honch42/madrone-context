'use strict';
// A read-only Model Context Protocol client attached to the user's workspace.
// Claude and GPT can call these tools mid-interview to look up a note the user
// mentions. The filesystem server ships with the app as a normal dependency and
// is started with the same Node runtime the app is running on, so it works in a
// packaged build with no internet connection and no npx on the PATH.

const path = require('path');


let client = null;
let currentDir = null;
let tools = [];
let starting = null;

// Only tools that read. Anything that writes, edits or moves is filtered out.
const READ_ONLY = new Set([
  'read_file', 'read_text_file', 'read_multiple_files', 'list_directory',
  'list_directory_with_sizes', 'directory_tree', 'search_files', 'get_file_info',
  'list_allowed_directories'
]);

function serverEntry() {
  // In a packaged app the file lives inside app.asar; a child process cannot run
  // from there, so electron-builder unpacks it and we point at the unpacked copy.
  return require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stop() {
  const c = client;
  client = null; tools = []; currentDir = null;
  if (c) { try { await c.close(); } catch (e) { /* ignore */ } }
}

// Starts (or restarts, if the folder changed) the filesystem server. Never throws:
// the interview must work even when the MCP server cannot start.
async function ensure(workspaceDir, log = () => {}) {
  if (client && currentDir === workspaceDir) return true;
  if (starting) { try { await starting; } catch (e) { /* ignore */ } if (client && currentDir === workspaceDir) return true; }
  starting = (async () => {
    await stop();
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry(), workspaceDir],
      env,
      stderr: 'ignore'
    });
    const c = new Client({ name: 'madrone-context', version: '1.0.0' }, { capabilities: { tools: {} } });
    await withTimeout(c.connect(transport), 8000, 'MCP connect');
    const res = await withTimeout(c.listTools(), 8000, 'MCP listTools');
    tools = (res.tools || []).filter(t => READ_ONLY.has(t.name));
    client = c;
    currentDir = workspaceDir;
    log(`MCP filesystem server attached to ${workspaceDir} (${tools.length} read-only tools)`);
    return true;
  })();
  try {
    return await starting;
  } catch (e) {
    log(`MCP unavailable: ${e.message}`);
    client = null; tools = []; currentDir = null;
    return false;
  } finally {
    starting = null;
  }
}

function listTools() {
  return tools;
}

async function callTool(name, args) {
  if (!client) throw new Error('File tools are not available.');
  if (!READ_ONLY.has(name)) throw new Error(`Tool "${name}" is not permitted.`);
  return withTimeout(client.callTool({ name, arguments: args || {} }), 15000, `MCP ${name}`);
}

function isConnected() { return !!client; }

module.exports = { ensure, stop, listTools, callTool, isConnected, READ_ONLY, serverEntry };
