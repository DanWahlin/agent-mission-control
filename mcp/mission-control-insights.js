#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SERVER_NAME = 'mission-control-insights';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const MAX_DAYS = 90;
const MAX_LIMIT = 500;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_PREVIEW_CHARS = 160;
const DEFAULT_CONTENT_CHARS = 8000;
const PROJECT_ROOT = path.resolve(process.env.CMC_PROJECT_ROOT || process.cwd());
const HOME = os.homedir();
const COPILOT_ROOT = path.join(HOME, '.copilot');
const SESSION_ROOT = path.join(COPILOT_ROOT, 'session-state');

const ROOTS = {
  project: PROJECT_ROOT,
  copilot: COPILOT_ROOT,
};

const TOOLS = [
  {
    name: 'health',
    description: 'Use only to verify the Mission Control Insights MCP server is reachable and which local roots are configured. Do not use for user-facing analytics unless diagnosing tool availability.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'list_prompt_samples',
    description: 'Use when the user asks to inspect, review, compare, or improve their recent Copilot prompts. Returns bounded recent user-message prompt previews from local Copilot CLI session history with opaque sample_id values. Prefer this before making prompt-quality recommendations. Default include_content=false gives previews; set include_content=true only when the user explicitly asks to inspect prompt wording or examples.',
    inputSchema: objectSchema({
      days: integerSchema('Local prompt history window in days, 1-90. Use 7 for “this week”; use 30 for broader prompt-pattern reviews.', 7, 1, MAX_DAYS),
      limit: integerSchema('Maximum prompt samples to return, 1-500. Use 20-50 for qualitative reviews; higher values only for pattern analysis.', 20, 1, MAX_LIMIT),
      include_content: booleanSchema('Include bounded prompt content instead of only previews. Keep false unless the user explicitly asks to review actual prompt wording/examples.', false),
      redact_secrets: booleanSchema('Redact obvious secret-looking strings from previews/content. Keep true unless the user explicitly asks for unredacted local inspection.', true),
    }),
  },
  {
    name: 'get_prompt_sample',
    description: 'Use after list_prompt_samples when a specific prompt sample needs closer inspection by sample_id. Returns bounded content for one local Copilot CLI prompt sample. Do not call first; first discover sample_id values with list_prompt_samples.',
    inputSchema: objectSchema({
      sample_id: {
        type: 'string',
        description: 'Opaque sample_id returned by list_prompt_samples. Never invent this value.',
      },
      days: integerSchema('Search window in days, 1-90. Use the same or larger window used for list_prompt_samples.', 30, 1, MAX_DAYS),
      max_chars: integerSchema('Maximum prompt characters to return, 1-20000. Use smaller values for summaries; larger only for explicit prompt inspection.', DEFAULT_CONTENT_CHARS, 1, 20000),
      redact_secrets: booleanSchema('Redact obvious secret-looking strings from content. Keep true unless the user explicitly requests unredacted local content.', true),
    }, ['sample_id']),
  },
  {
    name: 'summarize_prompt_patterns',
    description: 'Use when the user asks for prompt trends, recurring prompt habits, quality issues, or ways to improve prompting over a time window. Returns deterministic aggregate prompt-shape stats such as count, average length, attachments, and repeated openings. Use before list_prompt_samples when the user wants high-level prompt improvement guidance rather than individual examples.',
    inputSchema: objectSchema({
      days: integerSchema('Local prompt history window in days, 1-90. Use 7 for weekly pattern questions and 30 for broader habit analysis.', 7, 1, MAX_DAYS),
      limit: integerSchema('Maximum prompt samples to inspect, 1-500. Use 100 by default for stable pattern summaries.', 100, 1, MAX_LIMIT),
    }),
  },
  {
    name: 'list_copilot_skills',
    description: 'Use when the user asks about available skills, missing skills, skill coverage, skill usage improvements, or which skills should be reviewed. Lists skill definitions found in the project and ~/.copilot with ids that can be passed to read_skill_definition.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'read_skill_definition',
    description: 'Use after list_copilot_skills when the user asks to review, improve, debug, compare, or summarize a specific skill. Reads bounded skill definition content by skill id. Do not read every skill unless the user asks for broad skill audit; start with list_copilot_skills.',
    inputSchema: objectSchema({
      skill: {
        type: 'string',
        description: 'Skill id returned by list_copilot_skills, or a safe path under the project or ~/.copilot. Prefer ids over paths.',
      },
      max_chars: integerSchema('Maximum characters to return, 1-50000. Use the default for normal review; increase only for large skill audits.', DEFAULT_CONTENT_CHARS, 1, 50000),
    }, ['skill']),
  },
  {
    name: 'list_copilot_agents',
    description: 'Use when the user asks about available agents, missing agents, agent coverage, agent routing, or which agents should be reviewed or improved. Lists agent definitions found in the project and ~/.copilot with ids that can be passed to read_agent_definition.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'read_agent_definition',
    description: 'Use after list_copilot_agents when the user asks to review, improve, debug, compare, or summarize a specific agent. Reads bounded agent definition content by agent id. Do not read every agent unless the user asks for a broad agent audit; start with list_copilot_agents.',
    inputSchema: objectSchema({
      agent: {
        type: 'string',
        description: 'Agent id returned by list_copilot_agents, or a safe path under the project or ~/.copilot. Prefer ids over paths.',
      },
      max_chars: integerSchema('Maximum characters to return, 1-50000. Use the default for normal review; increase only for large agent audits.', DEFAULT_CONTENT_CHARS, 1, 50000),
    }, ['agent']),
  },
];

function objectSchema(properties, required) {
  return {
    type: 'object',
    properties,
    required: required || [],
    additionalProperties: false,
  };
}

function integerSchema(description, defaultValue, minimum, maximum) {
  return { type: 'integer', description, default: defaultValue, minimum, maximum };
}

function booleanSchema(description, defaultValue) {
  return { type: 'boolean', description, default: defaultValue };
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, ...payload }, null, 2) }],
  };
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, error: message }, null, 2) }],
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (request.method === 'tools/list') {
    return { tools: TOOLS };
  }
  if (request.method === 'tools/call') {
    const name = request.params && request.params.name;
    const args = (request.params && request.params.arguments) || {};
    try {
      return await callTool(name, args);
    } catch (err) {
      return errorResult(err && err.message ? err.message : String(err || 'Tool failed'));
    }
  }
  throw Object.assign(new Error(`Unknown method: ${request.method}`), { code: -32601 });
}

async function callTool(name, args) {
  switch (name) {
    case 'health':
      return textResult({
        ok: true,
        server: SERVER_NAME,
        project_root: displayRoot(PROJECT_ROOT),
        copilot_root_exists: fs.existsSync(COPILOT_ROOT),
        session_root_exists: fs.existsSync(SESSION_ROOT),
      });
    case 'list_prompt_samples':
      return textResult({ samples: await listPromptSamples(args) });
    case 'get_prompt_sample':
      return textResult({ sample: await getPromptSample(args) });
    case 'summarize_prompt_patterns':
      return textResult(await summarizePromptPatterns(args));
    case 'list_copilot_skills':
      return textResult({ skills: listDefinitions('skills') });
    case 'read_skill_definition':
      return textResult({ skill: readDefinition('skills', args.skill, args.max_chars) });
    case 'list_copilot_agents':
      return textResult({ agents: listDefinitions('agents') });
    case 'read_agent_definition':
      return textResult({ agent: readDefinition('agents', args.agent, args.max_chars) });
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

async function listPromptSamples(args) {
  const days = requiredInt(args.days, 7, 1, MAX_DAYS, 'days');
  const limit = requiredInt(args.limit, 20, 1, MAX_LIMIT, 'limit');
  const includeContent = Boolean(args.include_content);
  const redact = args.redact_secrets !== false;
  const samples = await collectPromptSamples({ days, limit, includeContent, redact });
  return samples.slice(0, limit);
}

async function getPromptSample(args) {
  const sampleId = String(args.sample_id || '').trim();
  if (!sampleId) throw new Error('sample_id is required.');
  const days = requiredInt(args.days, 30, 1, MAX_DAYS, 'days');
  const maxChars = requiredInt(args.max_chars, DEFAULT_CONTENT_CHARS, 1, 20000, 'max_chars');
  const redact = args.redact_secrets !== false;
  const samples = await collectPromptSamples({
    days,
    limit: MAX_LIMIT,
    includeContent: true,
    redact,
    maxChars,
  });
  const sample = samples.find((item) => item.sample_id === sampleId);
  if (!sample) throw new Error(`Prompt sample not found in the last ${days} day(s): ${sampleId}`);
  return sample;
}

async function summarizePromptPatterns(args) {
  const days = requiredInt(args.days, 7, 1, MAX_DAYS, 'days');
  const limit = requiredInt(args.limit, 100, 1, MAX_LIMIT, 'limit');
  const samples = await collectPromptSamples({
    days,
    limit,
    includeContent: true,
    redact: true,
    maxChars: 2000,
  });
  const lengths = samples.map((sample) => sample.char_count);
  const totalChars = lengths.reduce((sum, value) => sum + value, 0);
  const openings = new Map();
  for (const sample of samples) {
    const content = String(sample.content || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 6)
      .join(' ');
    if (content.length >= 12) {
      openings.set(content, (openings.get(content) || 0) + 1);
    }
  }
  const commonOpenings = Array.from(openings.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([opening, count]) => ({ opening, count }));
  return {
    prompt_count: samples.length,
    days,
    average_chars: samples.length ? Math.round(totalChars / samples.length) : 0,
    max_chars: lengths.length ? Math.max(...lengths) : 0,
    prompts_with_attachments: samples.filter((sample) => sample.attachment_count > 0).length,
    common_openings: commonOpenings,
  };
}

async function collectPromptSamples(options) {
  if (!fs.existsSync(SESSION_ROOT)) return [];
  const sinceMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const dirs = fs.readdirSync(SESSION_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const eventsPath = path.join(SESSION_ROOT, entry.name, 'events.jsonl');
      try {
        const stat = fs.statSync(eventsPath);
        return { sessionId: entry.name, eventsPath, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const samples = [];
  for (const entry of dirs) {
    await scanPromptFile(entry, sinceMs, options, samples);
  }
  samples.sort((a, b) => b.occurred_at_ms - a.occurred_at_ms);
  return samples.slice(0, options.limit);
}

async function scanPromptFile(entry, sinceMs, options, samples) {
  const start = Math.max(0, entry.size - MAX_SCAN_BYTES);
  const stream = fs.createReadStream(entry.eventsPath, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    if (event.type !== 'user.message') continue;
    const occurredAtMs = Date.parse(event.timestamp || '');
    if (!Number.isFinite(occurredAtMs) || occurredAtMs < sinceMs) continue;
    const rawContent = promptContent(event);
    if (!rawContent) continue;
    const content = options.redact ? redactSecrets(rawContent) : rawContent;
    const maxChars = options.maxChars || DEFAULT_CONTENT_CHARS;
    const sample = {
      sample_id: promptSampleId(entry.sessionId, event, rawContent),
      occurred_at: new Date(occurredAtMs).toISOString(),
      occurred_at_ms: occurredAtMs,
      session_ref: entry.sessionId.slice(0, 8),
      char_count: rawContent.length,
      attachment_count: Array.isArray(event.data && event.data.attachments)
        ? event.data.attachments.length
        : 0,
      preview: truncate(content, DEFAULT_PREVIEW_CHARS),
      tail_window_limited: entry.size > MAX_SCAN_BYTES,
    };
    if (options.includeContent) sample.content = truncate(content, maxChars);
    samples.push(sample);
  }
}

function promptContent(event) {
  const data = event.data || {};
  const value = typeof data.content === 'string'
    ? data.content
    : typeof data.transformedContent === 'string'
      ? data.transformedContent
      : '';
  return value.trim();
}

function promptSampleId(sessionId, event, content) {
  return hash(`${sessionId}:${event.id || ''}:${event.timestamp || ''}:${content.slice(0, 128)}`);
}

function listDefinitions(kind) {
  const entries = [];
  for (const root of definitionRoots(kind)) {
    if (!fs.existsSync(root.path)) continue;
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(root.path, entry.name);
      if (entry.isDirectory()) {
        entries.push(definitionDirectory(root, absolute, entry.name));
      } else if (isDefinitionFile(entry.name)) {
        entries.push(definitionFile(root, absolute, entry.name));
      }
    }
  }
  return entries.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

function readDefinition(kind, idOrPath, maxCharsArg) {
  const id = String(idOrPath || '').trim();
  if (!id) throw new Error(`${kind === 'skills' ? 'skill' : 'agent'} is required.`);
  const maxChars = requiredInt(maxCharsArg, DEFAULT_CONTENT_CHARS, 1, 50000, 'max_chars');
  const entries = listDefinitions(kind);
  const match = entries.find((entry) => entry.id === id || entry.name === id || entry.relative_path === id)
    || resolveDefinitionPath(kind, id);
  if (!match) throw new Error(`No ${kind.slice(0, -1)} definition found for: ${id}`);
  const absolute = match.absolute_path || safeResolveAllowed(id);
  if (!absolute) throw new Error(`Path is outside allowed roots: ${id}`);
  const files = fs.statSync(absolute).isDirectory()
    ? definitionFilesInDirectory(absolute)
    : [absolute];
  let remaining = maxChars;
  const contents = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const content = fs.readFileSync(file, 'utf8');
    const truncated = truncate(content, remaining);
    remaining -= truncated.length;
    contents.push({
      relative_path: relativeToKnownRoot(file),
      char_count: content.length,
      content: truncated,
      truncated: truncated.length < content.length,
    });
  }
  return {
    id: match.id || path.basename(absolute),
    name: match.name || path.basename(absolute),
    root: match.root || rootLabelForPath(absolute),
    files: contents,
  };
}

function definitionDirectory(root, absolute, name) {
  return {
    id: name,
    name,
    root: root.label,
    relative_path: path.relative(root.path, absolute),
    absolute_path: absolute,
    kind: 'directory',
    file_count: countFiles(absolute),
    primary_files: definitionFilesInDirectory(absolute).map((file) => path.basename(file)),
  };
}

function definitionFile(root, absolute, name) {
  const id = name.replace(/\.(md|ya?ml|json)$/i, '');
  return {
    id,
    name: id,
    root: root.label,
    relative_path: path.relative(root.path, absolute),
    absolute_path: absolute,
    kind: 'file',
    file_count: 1,
    primary_files: [name],
  };
}

function definitionRoots(kind) {
  const projectCandidates = kind === 'skills'
    ? ['.copilot/skills', '.github/copilot/skills']
    : ['.copilot/agents', '.github/copilot/agents', '.github/agents'];
  const userCandidates = kind === 'skills'
    ? ['skills']
    : ['agents'];
  return [
    ...projectCandidates.map((segment) => ({
      label: `project:${segment}`,
      path: path.join(PROJECT_ROOT, segment),
    })),
    ...userCandidates.map((segment) => ({
      label: `~/.copilot/${segment}`,
      path: path.join(COPILOT_ROOT, segment),
    })),
  ];
}

function resolveDefinitionPath(kind, idOrPath) {
  const resolved = safeResolveAllowed(idOrPath);
  if (!resolved) return null;
  const stat = fs.existsSync(resolved) && fs.statSync(resolved);
  if (!stat) return null;
  if (stat.isDirectory() || isDefinitionFile(path.basename(resolved))) {
    return {
      id: path.basename(resolved).replace(/\.(md|ya?ml|json)$/i, ''),
      name: path.basename(resolved).replace(/\.(md|ya?ml|json)$/i, ''),
      root: rootLabelForPath(resolved),
      absolute_path: resolved,
      kind: stat.isDirectory() ? 'directory' : 'file',
    };
  }
  return null;
}

function safeResolveAllowed(inputPath) {
  const candidate = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(PROJECT_ROOT, inputPath);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (_err) {
    return null;
  }
  const allowed = [PROJECT_ROOT, COPILOT_ROOT]
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  return allowed.some((root) => real === root || real.startsWith(root + path.sep)) ? real : null;
}

function definitionFilesInDirectory(dir) {
  const preferred = [
    'skill.yaml',
    'skill.yml',
    'agent.yaml',
    'agent.yml',
    'README.md',
    'AGENTS.md',
    'patterns.md',
    'anti-patterns.md',
    'decisions.md',
    'sharp-edges.md',
    'validations.yaml',
    'collaboration.yaml',
  ];
  const files = [];
  for (const name of preferred) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  if (files.length) return files;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isDefinitionFile(entry.name))
    .slice(0, 8)
    .map((entry) => path.join(dir, entry.name));
}

function isDefinitionFile(name) {
  return /\.(md|ya?ml|json)$/i.test(name);
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch (_err) {
    return 0;
  }
}

function relativeToKnownRoot(file) {
  for (const [label, root] of Object.entries(ROOTS)) {
    const relative = path.relative(root, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${label}:${relative}`;
    }
  }
  return path.basename(file);
}

function rootLabelForPath(file) {
  const resolved = fs.realpathSync(file);
  for (const [label, root] of Object.entries(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    const realRoot = fs.realpathSync(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) return label;
  }
  return 'unknown';
}

function displayRoot(value) {
  if (value.startsWith(HOME)) return `~${value.slice(HOME.length)}`;
  return value;
}

function requiredInt(value, defaultValue, min, max, name) {
  const raw = value == null ? defaultValue : Number(value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return raw;
}

function truncate(value, maxChars) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*[:=]\s*\S+/gi, '[REDACTED_SECRET_ASSIGNMENT]');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (_err) {
    writeMessage(jsonRpcError(null, -32700, 'Parse error'));
    return;
  }
  if (request.id == null) return;
  try {
    const result = await handleRequest(request);
    writeMessage({ jsonrpc: '2.0', id: request.id, result });
  } catch (err) {
    writeMessage(jsonRpcError(request.id, err.code || -32603, err.message || 'Internal error'));
  }
});

process.on('uncaughtException', (err) => {
  console.error(`[${SERVER_NAME}]`, err && err.stack ? err.stack : err);
});
