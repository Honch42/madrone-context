const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let mcpClient = null;

async function initMCP(workspaceDir) {
    if (mcpClient) return mcpClient;
    
    const transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", workspaceDir]
    });
    
    mcpClient = new Client({
        name: "madrone-orchestrator",
        version: "1.0.0"
    }, {
        capabilities: { tools: {} }
    });
    
    await mcpClient.connect(transport);
    console.log("MCP FileSystem Server Connected to: " + workspaceDir);
    return mcpClient;
}

async function getMCPTools() {
    if (!mcpClient) return [];
    const res = await mcpClient.listTools();
    return res.tools || [];
}

async function callMCPTool(name, args) {
    if (!mcpClient) throw new Error("MCP Client not initialized");
    const result = await mcpClient.callTool({ name, arguments: args });
    return result;
}

function formatToolsForGemini(tools) {
    if (tools.length === 0) return undefined;
    return [{ functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
    }))}];
}

function formatToolsForAnthropic(tools) {
    if (tools.length === 0) return undefined;
    return tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
    }));
}

function formatToolsForOpenAI(tools) {
    if (tools.length === 0) return undefined;
    return tools.map(t => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema
        }
    }));
}

module.exports = {
    initMCP,
    getMCPTools,
    callMCPTool,
    formatToolsForGemini,
    formatToolsForAnthropic,
    formatToolsForOpenAI
};
