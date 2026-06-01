import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'mcp', 'mission-control-insights.ts');

test('Mission Control Insights MCP server exposes prompt and skill tools', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'cmc-mcp-'));
  const home = path.join(temp, 'home');
  const project = path.join(temp, 'project');
  try {
    mkdirSync(path.join(home, '.copilot', 'session-state', 'session-123'), { recursive: true });
    mkdirSync(path.join(home, '.copilot', 'skills', 'coder'), { recursive: true });
    mkdirSync(path.join(home, '.copilot', 'skills', 'phaser', 'scenes'), { recursive: true });
    mkdirSync(path.join(home, '.copilot', 'installed-plugins', 'azure-skills', 'azure', 'skills', 'azure-deploy'), { recursive: true });
    mkdirSync(path.join(home, '.copilot', 'agents', 'reviewer'), { recursive: true });
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
    writeFileSync(
      path.join(home, '.copilot', 'skills', 'phaser', 'SKILL.md'),
      '# Phaser\n\nUse for Phaser games.\n',
    );
    writeFileSync(
      path.join(home, '.copilot', 'skills', 'phaser', 'scenes', 'SKILL.md'),
      '# Phaser Scenes\n\nUse for Phaser scene architecture.\n',
    );
    writeFileSync(
      path.join(home, '.copilot', 'installed-plugins', 'azure-skills', 'azure', 'skills', 'azure-deploy', 'SKILL.md'),
      '# Azure Deploy\n\nUse for Azure deployment guidance.\n',
    );
    writeFileSync(
      path.join(home, '.copilot', 'agents', 'reviewer', 'agent.yaml'),
      'name: reviewer\ndescription: Reviews code for correctness.\n',
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
      assert.ok(list.tools.some((tool) => tool.name === 'analyze_copilot_skills'));
      assert.ok(list.tools.some((tool) => tool.name === 'analyze_copilot_agents'));
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
      assert.ok(skillsPayload.skills.some((skill) => skill.relative_path === 'phaser/scenes'));
      assert.ok(skillsPayload.skills.some((skill) => skill.id === 'azure-deploy'));

      const skillResult = await client.request('tools/call', {
        name: 'read_skill_definition',
        arguments: { skill: 'coder' },
      });
      const skillPayload = JSON.parse(skillResult.content[0].text);
      assert.match(skillPayload.skill.files[0].content, /Writes maintainable code/);

      const skillsAnalysisResult = await client.request('tools/call', {
        name: 'analyze_copilot_skills',
        arguments: { max_total_chars: 1000 },
      });
      const skillsAnalysisPayload = JSON.parse(skillsAnalysisResult.content[0].text);
      assert.equal(skillsAnalysisPayload.kind, 'skills');
      assert.equal(skillsAnalysisPayload.summary.discovered_definitions, 4);
      assert.equal(skillsAnalysisPayload.summary.included_definitions, 4);
      assert.ok(skillsAnalysisPayload.definitions.some((skill) => (
        skill.files.some((file) => /Writes maintainable code/.test(file.content))
      )));

      const cappedSkillsAnalysisResult = await client.request('tools/call', {
        name: 'analyze_copilot_skills',
        arguments: { max_definitions: 1, max_total_chars: 1000 },
      });
      const cappedSkillsAnalysisPayload = JSON.parse(cappedSkillsAnalysisResult.content[0].text);
      const nestedCompleteness = cappedSkillsAnalysisPayload.artifact_review.completeness
        .find((item) => item.definition_ref === 'phaser/scenes');
      assert.ok(nestedCompleteness);
      assert.equal(nestedCompleteness.id, 'scenes');

      const agentsAnalysisResult = await client.request('tools/call', {
        name: 'analyze_copilot_agents',
        arguments: { max_total_chars: 1000 },
      });
      const agentsAnalysisPayload = JSON.parse(agentsAnalysisResult.content[0].text);
      assert.equal(agentsAnalysisPayload.kind, 'agents');
      assert.equal(agentsAnalysisPayload.summary.discovered_definitions, 1);
      assert.equal(agentsAnalysisPayload.summary.included_definitions, 1);
      assert.match(agentsAnalysisPayload.definitions[0].files[0].content, /Reviews code for correctness/);
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
