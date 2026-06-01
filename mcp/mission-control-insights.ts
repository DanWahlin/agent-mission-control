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
const DEFAULT_BULK_FILE_CHARS = 2500;
const DEFAULT_BULK_TOTAL_CHARS = 180000;
const MAX_BULK_DEFINITIONS = 200;
const MAX_BULK_FILES_PER_DEFINITION = 8;
const MAX_DEFINITION_SCAN_DEPTH = 10;
const OVERLAP_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'for', 'from', 'in', 'into', 'my', 'of', 'on', 'or', 'the', 'to', 'use', 'when', 'with',
]);
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
    description: 'Use only when the user asks which Copilot skills exist or needs ids for a specific skill. Lists skill definitions found in the project and ~/.copilot with ids that can be passed to read_skill_definition. Do not use for prompts like "Review my Copilot skills"; use analyze_copilot_skills instead.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'read_skill_definition',
    description: 'Use after list_copilot_skills when the user asks to review, improve, debug, compare, or summarize one named skill. Reads bounded skill definition content by skill id. Do not use for broad review prompts or call repeatedly for every skill; use analyze_copilot_skills instead.',
    inputSchema: objectSchema({
      skill: {
        type: 'string',
        description: 'Skill id returned by list_copilot_skills, or a safe path under the project or ~/.copilot. Prefer ids over paths.',
      },
      max_chars: integerSchema('Maximum characters to return, 1-120000. Use 4000-8000 for normal review; increase only when the user asks for deeper inspection of one skill.', DEFAULT_CONTENT_CHARS, 1, 120000),
    }, ['skill']),
  },
  {
    name: 'analyze_copilot_skills',
    description: 'Use first for broad Copilot skill review prompts, including "Review my Copilot skills", "audit my skills", "improve my skills", "find duplicate skills", "compare my skills", or "check skill coverage". Bulk-loads bounded skill definition content from the project and ~/.copilot so the model can analyze coverage, duplication, routing, and quality without reading skills one by one.',
    inputSchema: bulkDefinitionSchema('skills'),
  },
  {
    name: 'list_copilot_agents',
    description: 'Use only when the user asks which Copilot agents exist or needs ids for a specific agent. Lists agent definitions found in the project and ~/.copilot with ids that can be passed to read_agent_definition. Do not use for prompts like "Review my Copilot agents"; use analyze_copilot_agents instead.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'read_agent_definition',
    description: 'Use after list_copilot_agents when the user asks to review, improve, debug, compare, or summarize one named agent. Reads bounded agent definition content by agent id. Do not use for broad review prompts or call repeatedly for every agent; use analyze_copilot_agents instead.',
    inputSchema: objectSchema({
      agent: {
        type: 'string',
        description: 'Agent id returned by list_copilot_agents, or a safe path under the project or ~/.copilot. Prefer ids over paths.',
      },
      max_chars: integerSchema('Maximum characters to return, 1-120000. Use 4000-8000 for normal review; increase only when the user asks for deeper inspection of one agent.', DEFAULT_CONTENT_CHARS, 1, 120000),
    }, ['agent']),
  },
  {
    name: 'analyze_copilot_agents',
    description: 'Use first for broad Copilot agent review prompts, including "Review my Copilot agents", "audit my agents", "improve my agents", "find duplicate agents", "compare my agents", or "check agent coverage". Bulk-loads bounded agent definition content from the project and ~/.copilot so the model can analyze coverage, duplication, routing, and quality without reading agents one by one.',
    inputSchema: bulkDefinitionSchema('agents'),
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

function bulkDefinitionSchema(kind) {
  const singular = kind === 'skills' ? 'skill' : 'agent';
  return objectSchema({
    max_definitions: integerSchema(`Maximum ${kind} to include, 1-${MAX_BULK_DEFINITIONS}. Lower this for quick reviews; raise it for exhaustive local audits.`, 100, 1, MAX_BULK_DEFINITIONS),
    max_file_chars: integerSchema(`Maximum characters to include per ${singular} file, 500-12000.`, DEFAULT_BULK_FILE_CHARS, 500, 12000),
    max_total_chars: integerSchema(`Maximum total definition content characters to return across all ${kind}, 1000-200000.`, DEFAULT_BULK_TOTAL_CHARS, 1000, 200000),
    max_files_per_definition: integerSchema(`Maximum files to include per ${singular} directory, 1-${MAX_BULK_FILES_PER_DEFINITION}.`, MAX_BULK_FILES_PER_DEFINITION, 1, MAX_BULK_FILES_PER_DEFINITION),
  });
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
    case 'analyze_copilot_skills':
      return textResult(analyzeDefinitions('skills', args));
    case 'list_copilot_agents':
      return textResult({ agents: listDefinitions('agents') });
    case 'read_agent_definition':
      return textResult({ agent: readDefinition('agents', args.agent, args.max_chars) });
    case 'analyze_copilot_agents':
      return textResult(analyzeDefinitions('agents', args));
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
    collectDefinitions(root, root.path, kind, 0, entries);
  }
  return entries.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

function readDefinition(kind, idOrPath, maxCharsArg) {
  const id = String(idOrPath || '').trim();
  if (!id) throw new Error(`${kind === 'skills' ? 'skill' : 'agent'} is required.`);
  const maxChars = requiredInt(maxCharsArg, DEFAULT_CONTENT_CHARS, 1, 120000, 'max_chars');
  const entries = listDefinitions(kind);
  const match = entries.find((entry) => entry.id === id || entry.name === id || entry.relative_path === id)
    || resolveDefinitionPath(kind, id);
  if (!match) throw new Error(`No ${kind.slice(0, -1)} definition found for: ${id}`);
  const absolute = match.absolute_path || safeResolveAllowed(id);
  if (!absolute) throw new Error(`Path is outside allowed roots: ${id}`);
  const contents = readDefinitionFiles(absolute, {
    maxFileChars: maxChars,
    maxTotalChars: maxChars,
    maxFiles: Number.MAX_SAFE_INTEGER,
  }, kind);
  return {
    id: match.id || path.basename(absolute),
    name: match.name || path.basename(absolute),
    root: match.root || rootLabelForPath(absolute),
    files: contents.files,
  };
}

function analyzeDefinitions(kind, args) {
  const maxDefinitions = requiredInt(args.max_definitions, 100, 1, MAX_BULK_DEFINITIONS, 'max_definitions');
  const maxFileChars = requiredInt(args.max_file_chars, DEFAULT_BULK_FILE_CHARS, 500, 12000, 'max_file_chars');
  const maxTotalChars = requiredInt(args.max_total_chars, DEFAULT_BULK_TOTAL_CHARS, 1000, 200000, 'max_total_chars');
  const maxFiles = requiredInt(args.max_files_per_definition, MAX_BULK_FILES_PER_DEFINITION, 1, MAX_BULK_FILES_PER_DEFINITION, 'max_files_per_definition');
  const entries = listDefinitions(kind);
  let remainingTotal = maxTotalChars;
  const definitions = [];
  for (const entry of entries.slice(0, maxDefinitions)) {
    if (remainingTotal <= 0) break;
    const contents = readDefinitionFiles(entry.absolute_path, {
      maxFileChars,
      maxTotalChars: remainingTotal,
      maxFiles,
    }, kind);
    remainingTotal -= contents.included_chars;
    definitions.push({
      id: entry.id,
      name: entry.name,
      root: entry.root,
      relative_path: entry.relative_path,
      kind: entry.kind,
      file_count: entry.file_count,
      primary_files: entry.primary_files,
      content_chars: contents.included_chars,
      truncated: contents.truncated,
      files: contents.files,
    });
  }

  const duplicateIdGroups = duplicateDefinitionIds(entries);

  const review = buildDefinitionReview(kind, entries, definitions, duplicateIdGroups, maxDefinitions);
  return {
    kind,
    artifact_review: compactDefinitionReview(review),
    summary: {
      discovered_definitions: entries.length,
      included_definitions: definitions.length,
      skipped_definitions: Math.max(0, entries.length - definitions.length),
      skip_reason: definitions.length < entries.length ? 'content caps limited definitions sent to model context; review metrics still analyze all discovered definitions' : null,
      max_definitions: maxDefinitions,
      max_file_chars: maxFileChars,
      max_total_chars: maxTotalChars,
      total_content_chars: maxTotalChars - remainingTotal,
      truncated: definitions.length < entries.length || definitions.some((definition) => definition.truncated),
      roots: summarizeDefinitionRoots(entries),
      duplicate_id_groups: duplicateIdGroups,
    },
    review,
    definitions,
  };
}

function compactDefinitionReview(review) {
  return {
    inventory: review.inventory,
    duplicate_groups: review.duplicate_groups,
    definitions: review.definitions.map(({ id, root, definition_ref, summary, source_chars, description_chars, completeness_score, issues }) => ({
      id,
      root,
      definition_ref,
      summary: truncate(summary, 96),
      enabled: true,
      source_chars,
      description_chars,
      completeness_score,
      issues,
    })),
    context_cost: review.context_cost.slice(0, 5).map(({ id, root, source_chars }) => ({ id, root, source_chars })),
    description_lengths: review.description_lengths.slice(0, 5).map(({ id, root, description_chars }) => ({ id, root, description_chars })),
    completeness: review.completeness.map(({ id, root, definition_ref, completeness_score, issues }) => ({
      id,
      root,
      definition_ref,
      completeness_score,
      issues,
    })).filter((item) => item.issues.length > 0),
    overlap_pairs: review.overlap_pairs.slice(0, 2),
    actions: review.actions.slice(0, 3),
  };
}

function buildDefinitionReview(kind, entries, definitions, duplicateIdGroups, maxDefinitions) {
  const metrics = entries.map((entry) => definitionMetricFromEntry(entry, kind));
  const discoveredFootprint = entries.map((entry) => ({
    id: entry.id,
    root: entry.root,
    file_count: entry.file_count,
    source_chars: definitionSourceChars(entry.absolute_path, kind),
  })).sort((a, b) => b.source_chars - a.source_chars);
  const overlapPairs = definitionOverlapPairs(metrics);
  const actions = prioritizedDefinitionActions(kind, metrics, duplicateIdGroups, overlapPairs);
  return {
    inventory: {
      discovered_definitions: entries.length,
      analyzed_definitions: metrics.length,
      skipped_definitions: 0,
      model_context_definitions: definitions.length,
      model_context_skipped: Math.max(0, entries.length - definitions.length),
      max_definitions: maxDefinitions,
      duplicate_id_groups: duplicateIdGroups.length,
      roots: summarizeDefinitionRoots(entries),
    },
    duplicate_groups: duplicateIdGroups.map((group) => ({
      id: group.id,
      count: group.count,
      roots: Array.from(new Set(group.locations.map((location) => location.root))).sort(),
    })),
    metrics,
    definitions: metrics
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, root, definition_ref, summary, source_chars, description_chars, completeness_score, issues }) => ({
        id,
        root,
        definition_ref,
        summary,
        enabled: true,
        source_chars,
        description_chars,
        completeness_score,
        issues,
      })),
    context_cost: discoveredFootprint.slice(0, 12),
    description_lengths: metrics
      .slice()
      .sort((a, b) => b.description_chars - a.description_chars)
      .slice(0, 12)
      .map(({ id, root, title_chars, description_chars, source_chars }) => ({ id, root, title_chars, description_chars, source_chars })),
    completeness: metrics
      .slice()
      .sort((a, b) => a.completeness_score - b.completeness_score || b.source_chars - a.source_chars)
      .slice(0, 16)
      .map(({ id, root, definition_ref, completeness_score, checks, issues }) => ({ id, root, definition_ref, completeness_score, checks, issues })),
    overlap_pairs: overlapPairs,
    actions,
  };
}

function definitionMetricFromEntry(entry, kind) {
  const files = fs.statSync(entry.absolute_path).isDirectory()
    ? definitionFilesInDirectory(entry.absolute_path, kind)
    : [entry.absolute_path];
  const contents = files.map((file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (_err) {
      return '';
    }
  });
  const content = contents.join('\n\n');
  const title = extractDefinitionTitle(entry, content);
  const description = extractDefinitionDescription(content);
  const sourceChars = contents.reduce((sum, text) => sum + text.length, 0);
  return definitionMetricFromParts({
    id: entry.id,
    root: entry.root,
    definition_ref: entry.relative_path,
    name: entry.name,
    definition_ref: entry.relative_path,
    file_count: entry.file_count,
    title,
    description,
    content,
    sourceChars,
    includedChars: 0,
    truncated: false,
  });
}

function definitionMetric(definition) {
  const content = definition.files.map((file) => file.content || '').join('\n\n');
  const title = extractDefinitionTitle(definition, content);
  const description = extractDefinitionDescription(content);
  const sourceChars = definition.files.reduce((sum, file) => sum + Number(file.char_count || 0), 0);
  return definitionMetricFromParts({
    id: definition.id,
    root: definition.root,
    name: definition.name,
    definition_ref: definition.relative_path || definition.id,
    file_count: definition.file_count,
    title,
    description,
    content,
    sourceChars,
    includedChars: definition.content_chars,
    truncated: Boolean(definition.truncated),
  });
}

function definitionMetricFromParts(parts) {
  const checks = {
    use_cases: /\b(when to use|use for|triggers?|activates?|trigger phrases?)\b/i.test(parts.content),
    anti_triggers: /\b(do not use|don't use|when not|anti[- ]?trigger|anti[- ]?pattern|stay in lane)\b/i.test(parts.content),
    validation: /\b(validat|test|check|verify|success criteria|acceptance criteria)\b/i.test(parts.content),
    safety: /\b(privacy|safe|secret|credential|permission|sensitive|do not submit|do not store)\b/i.test(parts.content),
    prerequisites: /\b(prereq|requirement|setup|before you start|tool availability)\b/i.test(parts.content),
  };
  const issues = [];
  if (parts.sourceChars > 12000) issues.push('large definition');
  if (parts.title.length > 70) issues.push('long title');
  if (parts.description.length > 500) issues.push('long description');
  if (parts.description.length > 0 && parts.description.length < 40) issues.push('thin description');
  if (!parts.description.length) issues.push('missing description');
  if (!checks.anti_triggers) issues.push('missing anti-triggers');
  if (!checks.validation) issues.push('missing validation');
  const completenessScore = Object.values(checks).filter(Boolean).length;
  return {
    id: parts.id,
    root: parts.root,
    definition_ref: parts.definition_ref || parts.id,
    summary: definitionSummary(parts.description, parts.content),
    title_chars: parts.title.length,
    description_chars: parts.description.length,
    source_chars: parts.sourceChars,
    included_chars: parts.includedChars,
    file_count: parts.file_count,
    truncated: parts.truncated,
    completeness_score: completenessScore,
    checks,
    issues,
    overlap_tokens: definitionTokens(`${parts.title} ${parts.description}`),
  };
}

function definitionSummary(description, content) {
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim();
  if (cleanDescription) return cleanDescription;
  const firstUsefulLine = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line && !line.startsWith('---') && !/^[A-Za-z0-9_-]+:\s*/.test(line));
  return firstUsefulLine || 'No summary available.';
}

function extractDefinitionTitle(definition, content) {
  return extractYamlScalar(content, 'name')
    || (content.match(/^#\s+(.+)$/m) || [])[1]
    || definition.name
    || definition.id;
}

function extractDefinitionDescription(content) {
  return extractYamlScalar(content, 'description')
    || (content.match(/^description:\s*>\s*\n((?:\s+.+\n?)+)/mi) || [])[1]?.replace(/\s+/g, ' ').trim()
    || '';
}

function extractYamlScalar(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function definitionSourceChars(absolute, kind) {
  try {
    const files = fs.statSync(absolute).isDirectory()
      ? definitionFilesInDirectory(absolute, kind)
      : [absolute];
    return files.reduce((sum, file) => sum + fs.readFileSync(file, 'utf8').length, 0);
  } catch (_err) {
    return 0;
  }
}

function definitionTokens(text) {
  return Array.from(new Set(String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && !OVERLAP_STOPWORDS.has(token))));
}

function definitionOverlapPairs(metrics) {
  const pairs = [];
  for (let i = 0; i < metrics.length; i += 1) {
    for (let j = i + 1; j < metrics.length; j += 1) {
      if (metrics[i].id === metrics[j].id) continue;
      const left = metrics[i].overlap_tokens;
      const right = metrics[j].overlap_tokens;
      if (left.length < 3 || right.length < 3) continue;
      const rightSet = new Set(right);
      const shared = left.filter((token) => rightSet.has(token));
      if (shared.length < 3) continue;
      const union = new Set([...left, ...right]).size || 1;
      const score = shared.length / union;
      if (score < 0.4) continue;
      pairs.push({
        left_id: metrics[i].id,
        right_id: metrics[j].id,
        score: Number(score.toFixed(2)),
        shared_tokens: shared.slice(0, 8),
      });
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, 10);
}

function prioritizedDefinitionActions(kind, metrics, duplicateIdGroups, overlapPairs) {
  const label = kind === 'agents' ? 'agents' : 'skills';
  const actions = [];
  const large = metrics.filter((metric) => metric.source_chars > 12000).sort((a, b) => b.source_chars - a.source_chars);
  if (large.length) actions.push({
    title: `Trim ${large.length} oversized ${label}`,
    body: `${large.slice(0, 3).map((metric) => metric.id).join(', ')} have the largest context footprint. Move rarely used procedural detail into narrower follow-up steps.`,
    severity: 'warning',
    metric: 'definition_size',
  });
  const missingAnti = metrics.filter((metric) => !metric.checks.anti_triggers);
  if (missingAnti.length) actions.push({
    title: `Add anti-triggers to ${missingAnti.length} ${label}`,
    body: `${missingAnti.slice(0, 3).map((metric) => metric.id).join(', ')} need clearer "do not use for" boundaries to reduce over-routing.`,
    severity: 'warning',
    metric: 'anti_triggers',
  });
  const missingValidation = metrics.filter((metric) => !metric.checks.validation);
  if (missingValidation.length) actions.push({
    title: `Add validation guidance to ${missingValidation.length} ${label}`,
    body: `${missingValidation.slice(0, 3).map((metric) => metric.id).join(', ')} should say how to confirm the work is complete.`,
    severity: 'info',
    metric: 'validation',
  });
  if (duplicateIdGroups.length) actions.push({
    title: `Resolve ${duplicateIdGroups.length} duplicate IDs`,
    body: 'Duplicate IDs can make targeted reads ambiguous and weaken routing. Rename or consolidate duplicates.',
    severity: 'warning',
    metric: 'duplicates',
  });
  if (overlapPairs.length) actions.push({
    title: `Review ${overlapPairs.length} overlap candidates`,
    body: `${overlapPairs[0].left_id} and ${overlapPairs[0].right_id} share routing language. Merge, split, or add anti-triggers if they compete.`,
    severity: 'info',
    metric: 'overlap',
  });
  return actions.slice(0, 6);
}

function readDefinitionFiles(absolute, limits, kind = 'definitions') {
  const allFiles = fs.statSync(absolute).isDirectory()
    ? definitionFilesInDirectory(absolute, kind)
    : [absolute];
  const files = allFiles.slice(0, limits.maxFiles);
  let remaining = limits.maxTotalChars;
  const contents = [];
  let skippedFiles = allFiles.length - files.length;
  for (const file of files) {
    if (remaining <= 0) {
      skippedFiles += 1;
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    const allowedChars = Math.min(limits.maxFileChars, remaining);
    const truncated = truncate(content, allowedChars);
    remaining -= truncated.length;
    contents.push({
      relative_path: relativeToKnownRoot(file),
      char_count: content.length,
      content: truncated,
      truncated: truncated.length < content.length,
    });
  }
  return {
    files: contents,
    included_chars: contents.reduce((sum, file) => sum + file.content.length, 0),
    truncated: skippedFiles > 0 || contents.some((file) => file.truncated),
  };
}

function summarizeDefinitionRoots(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.root, (counts.get(entry.root) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([root, count]) => ({ root, count }));
}

function duplicateDefinitionIds(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.id) || [];
    group.push(entry);
    groups.set(entry.id, group);
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([id, group]) => ({
      id,
      count: group.length,
      locations: group.map((entry) => ({
        root: entry.root,
        relative_path: entry.relative_path,
      })),
    }));
}

function collectDefinitions(root, dir, kind, depth, entries) {
  if (depth > MAX_DEFINITION_SCAN_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkipDefinitionEntry(entry)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (definitionFilesInDirectory(absolute, kind).length) {
        entries.push(definitionDirectory(root, absolute, kind));
      }
      collectDefinitions(root, absolute, kind, depth + 1, entries);
    } else if (depth === 0 && isDefinitionFile(entry.name)) {
      entries.push(definitionFile(root, absolute, entry.name));
    }
  }
}

function shouldSkipDefinitionEntry(entry) {
  if (entry.name.startsWith('.')) return true;
  return ['node_modules', 'target', 'dist', 'build', 'coverage', '__pycache__'].includes(entry.name);
}

function definitionDirectory(root, absolute, kind) {
  const relativePath = path.relative(root.path, absolute);
  const name = path.basename(absolute);
  return {
    id: name,
    name,
    root: root.label,
    relative_path: relativePath,
    absolute_path: absolute,
    kind: 'directory',
    file_count: countFiles(absolute),
    primary_files: definitionFilesInDirectory(absolute, kind).map((file) => path.basename(file)),
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
    ? ['skills', 'installed-plugins', 'marketplace-cache']
    : ['agents', 'installed-plugins', 'marketplace-cache'];
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

function definitionFilesInDirectory(dir, kind = 'definitions') {
  const primary = kind === 'agents'
    ? ['AGENT.md', 'agent.yaml', 'agent.yml', 'AGENTS.md']
    : kind === 'skills'
      ? ['SKILL.md', 'skill.yaml', 'skill.yml']
      : ['SKILL.md', 'AGENT.md', 'skill.yaml', 'skill.yml', 'agent.yaml', 'agent.yml', 'AGENTS.md'];
  const supporting = [
    'patterns.md',
    'anti-patterns.md',
    'decisions.md',
    'sharp-edges.md',
    'validations.yaml',
    'collaboration.yaml',
  ];
  const files = [];
  for (const name of primary) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  if (files.length) {
    for (const name of supporting) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
    }
    return files;
  }
  if (kind === 'skills' || kind === 'agents') return [];
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
