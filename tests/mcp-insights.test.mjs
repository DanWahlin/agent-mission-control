import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'mcp', 'mission-control-insights.js');

test('Mission Control Insights MCP server exposes prompt and skill tools', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'cmc-mcp-'));
  const home = path.join(temp, 'home');
  const project = path.join(temp, 'project');
  try {
    mkdirSync(path.join(home, '.copilot', 'session-state', 'session-123'), { recursive: true });
    mkdirSync(path.join(home, '.copilot', 'skills', 'coder'), { recursive: true });
    mkdirSync(project, { recursive: true });

    writeFileSync(
      path.join(home, '.copilot', 'session-state', 'session-123', 'events.jsonl'),
      [
        JSON.stringify({
          id: 'evt-1',
          type: 'user.message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'Please refactor this code. SECRET_TOKEN=super-secret-value',
            attachments: [{}],
          },
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      path.join(home, '.copilot', 'skills', 'coder', 'skill.yaml'),
      'name: coder\ndescription: Writes maintainable code.\n',
    );

    const client = await startServer({ HOME: home, CMC_PROJECT_ROOT: project });
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      });
      assert.equal(init.protocolVersion, '2024-11-05');
      assert.deepEqual(init.capabilities, { tools: {} });

      const list = await client.request('tools/list', {});
      assert.ok(list.tools.some((tool) => tool.name === 'list_prompt_samples'));
      assert.ok(list.tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));

      const promptResult = await client.request('tools/call', {
        name: 'list_prompt_samples',
        arguments: { days: 7, limit: 5 },
      });
      const promptPayload = JSON.parse(promptResult.content[0].text);
      assert.equal(promptPayload.schemaVersion, 1);
      assert.equal(promptPayload.samples.length, 1);
      assert.match(promptPayload.samples[0].preview, /\[REDACTED_SECRET_ASSIGNMENT\]/);
      assert.equal(promptPayload.samples[0].attachment_count, 1);

      const skillsResult = await client.request('tools/call', {
        name: 'list_copilot_skills',
        arguments: {},
      });
      const skillsPayload = JSON.parse(skillsResult.content[0].text);
      assert.ok(skillsPayload.skills.some((skill) => skill.id === 'coder'));

      const skillResult = await client.request('tools/call', {
        name: 'read_skill_definition',
        arguments: { skill: 'coder' },
      });
      const skillPayload = JSON.parse(skillResult.content[0].text);
      assert.match(skillPayload.skill.files[0].content, /Writes maintainable code/);
    } finally {
      client.stop();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function startServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const resolver = pending.get(response.id);
      if (!resolver) continue;
      pending.delete(response.id);
      if (response.error) resolver.reject(new Error(response.error.message));
      else resolver.resolve(response.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  return Promise.resolve({
    request(method, params) {
      const id = nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(payload) + '\n');
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  });
}
