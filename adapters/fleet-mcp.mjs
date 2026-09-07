// Zero-dependency MCP stdio adapter. Each engine session launches one copy.
// It contains no fleet policy: it lists the shared core catalogue and forwards
// calls to the one running MINIMAC server that owns the state.

import { createInterface } from 'node:readline';
import { toolsForRole } from '../core/agent-tools.mjs';

const role = process.env.MINIMAC_AGENT_ROLE ?? '';
const url = process.env.MINIMAC_SERVER_URL ?? '';
const token = process.env.MINIMAC_AGENT_TOKEN ?? '';
const tools = toolsForRole(role);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => void receive(line));

async function receive(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;

  try {
    const result = await handle(request.method, request.params ?? {});
    write({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: error?.message ?? String(error) },
    });
  }
}

async function handle(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'minimac', version: '0.1.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method !== 'tools/call') throw new Error(`method not found: ${method}`);

  const response = await fetch(`${url}/agent-tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
  });
  const body = await response.json();
  return {
    content: [{ type: 'text', text: body.ok ? JSON.stringify(body.result ?? {}) : body.error }],
    isError: !body.ok,
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
