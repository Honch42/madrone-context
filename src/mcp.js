'use strict';
// MCP Client for connecting to the unified Context Router
// Instead of a bundled filesystem, we now connect to an external router
// which provides tools like `list_hypotheses` and `search_context`.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

let client = null;
let tools = [];
let starting = null;

const ALLOWED_TOOLS = new Set([
  'list_hypotheses', 'search_context', 'read_context', 'promote_hypothesis', 'reject_hypothesis'
]);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stop() {
  const c = client;
  client = null; tools = [];
  if (c) { try { await c.close(); } catch (e) { /* ignore */ } }
}

async function ensure(routerUrl = 'http://localhost:3001/sse', log = () => {}) {
  if (client) return true;
  if (starting) { try { await starting; } catch (e) { /* ignore */ } if (client) return true; }
  
  starting = (async () => {
    await stop();
    const transport = new SSEClientTransport(new URL(routerUrl));
    const c = new Client({ name: 'madrone-context', version: '2.0.0' }, { capabilities: { tools: {} } });
    
    await withTimeout(c.connect(transport), 8000, 'MCP Router connect');
    const res = await withTimeout(c.listTools(), 8000, 'MCP listTools');
    
    tools = (res.tools || []).filter(t => ALLOWED_TOOLS.has(t.name));
    client = c;
    log(`Context Router connected via ${routerUrl} (${tools.length} allowed tools)`);
    return true;
  })();
  
  try {
    return await starting;
  } catch (e) {
    log(`Context Router unavailable: ${e.message}`);
    client = null; tools = [];
    return false;
  } finally {
    starting = null;
  }
}

function listTools() {
  return tools;
}

async function callTool(name, args) {
  if (!client) throw new Error('Context Router tools are not available.');
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`Tool "${name}" is not permitted for Madrone Context.`);
  return withTimeout(client.callTool({ name, arguments: args || {} }), 15000, `MCP ${name}`);
}

function isConnected() { return !!client; }

module.exports = { ensure, stop, listTools, callTool, isConnected, ALLOWED_TOOLS };
