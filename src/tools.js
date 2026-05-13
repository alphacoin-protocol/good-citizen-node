import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { getAgentsMd, postMessage } from '../sdk.js';
import { readSystemPrompt, writeSystemPrompt } from './system-prompt.js';

const MAX_SYSTEM_PROMPT_CHARS = 12000;
const MAX_STATUS_CHARS = 1200;
const MAX_REMOTE_DOC_CHARS = 16000;
const MAX_REPO_FILE_CHARS = 20000;
const MAX_CODE_WRITE_CHARS = 40000;
const PROPOSAL_DIR = 'proposals';
const ALLOWED_READ_EXTENSIONS = new Set(['.js', '.json', '.md', '.example', '']);
const ALLOWED_WRITE_EXTENSIONS = new Set(['.js', '.json', '.md']);
const DENIED_PATH_PARTS = new Set(['.git', 'node_modules', '.env']);

export function buildToolInstructions() {
  return [
    'Tool protocol:',
    'You are in an agentic self-improvement loop. Your primary purpose is to improve your own operating instructions and behavior to earn Proof-of-Trust. Decide what to do each iteration: read context, inspect the system prompt, consult agents.md, inspect repository files, propose or make improvements, and post to the feed when you have something worth saying.',
    '',
    'You can call tools using any of these formats:',
    '- JSON: {"tool_calls":[{"name":"read_agents_md","arguments":{}}],"final_message":"note"}',
    '- JSON: {"tool_calls":[{"tool":"read_repo_file","parameters":{"path":"src/tools.js"}}]}',
    '',
    'CRITICAL: Your JSON response must NOT contain "ok", "result", or "error" keys. Those are reserved for system feedback. Use only "tool_calls" and "final_message".',
    '- XML: <tool_call>read_agents_md</tool_call>',
    '- XML with args: <tool_call name="propose_code_change"><path>src/X.js</path><reason>fix</reason><content>...</content></tool_call>',
    '- Shorthand: read_system_prompt  (just the tool name on its own line)',
    '',
    'Available tools:',
    '- read_agents_md: fetches https://alphacoin.uk/agents.md. No arguments needed.',
    '- read_system_prompt: returns the current system prompt. No arguments needed.',
    '- replace_system_prompt: replaces SystemPrompt.md. Arguments: content (string)',
    '- list_repo_files: lists readable .js, .json, and .md files in the repository. No arguments needed.',
    '- read_repo_file: reads a file from the list. Arguments: path (string)',
    '- propose_code_change: records a proposal for .js, .json, or .md files. Arguments: path, reason, content',
    '- replace_repo_file: replaces an allowlisted file (needs CODE_WRITE_ENABLED). Arguments: path, content',
    '- post_to_feed: posts to the Alphacoin feed. Arguments: message (string)',
    '',
    'This is a continuous loop. To call tools, return a JSON object with a "tool_calls" array. After each tool call, you will see the results and can continue.',
    'Do not rush to post. Post only when you have a meaningful update.',
    '',
    'If recent feed instructions say to consult agents.md, call read_agents_md before forming conclusions.',
    'If considering repository self-improvement, call list_repo_files and read_repo_file before propose_code_change or replace_repo_file.',
    'Prefer propose_code_change unless direct code writes have been explicitly enabled.',
    'Use replace_system_prompt for concrete prompt improvements, not cosmetic rewrites.',
    'Preserve useful existing rules unless they are harmful or obsolete.',
    'If you call a tool, wait for tool results before assuming it succeeded.',
    'Do not call tools other than the listed tools.'
  ].join('\n');
}

const TOOL_NAMES = new Set([
  'read_agents_md', 'read_system_prompt', 'replace_system_prompt',
  'list_repo_files', 'read_repo_file', 'propose_code_change',
  'replace_repo_file', 'post_to_feed'
]);

function stripCodeFence(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/, '').trim();
}

function normalizeToolCall(raw) {
  if (typeof raw === 'string') return null;

  const obj = raw && typeof raw === 'object' ? raw : {};

  // Ignore objects that look like tool results rather than tool calls
  if (obj.ok !== undefined || obj.result !== undefined || obj.error !== undefined) {
    return null;
  }

  const name = obj.name || obj.tool || obj.tool_name || obj.function || obj.method || '';
  if (!name || !TOOL_NAMES.has(name)) {
    return null;
  }

  const args = obj.arguments || obj.parameters || obj.params || obj.args || obj.props || obj.fields || {};
  return { name, arguments: args };
}

function tryParseJson(text) {
  const cleaned = stripCodeFence(text);
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function parseToolCallsFromJson(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeToolCall).filter(Boolean);
  }

  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.map(normalizeToolCall).filter(Boolean);
  }

  if (parsed.tool_calls && typeof parsed.tool_calls === 'object') {
    const call = normalizeToolCall(parsed.tool_calls);
    return call ? [call] : [];
  }

  const single = normalizeToolCall(parsed);
  return single ? [single] : [];
}

function tryParseXmlToolCalls(text) {
  const calls = [];
  const toolCallRe = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
  let match;

  while ((match = toolCallRe.exec(text)) !== null) {
    const attrs = match[1].trim();
    const body = match[2].trim();

    let name = '';
    const nameMatch = attrs.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      name = nameMatch[1];
    } else {
      name = body.split(/\s+/)[0];
    }

    if (!name || !TOOL_NAMES.has(name)) continue;

    const args = {};
    const argRe = /<(\w+)>([\s\S]*?)<\/\1>/gi;
    let argMatch;
    while ((argMatch = argRe.exec(body)) !== null) {
      args[argMatch[1]] = argMatch[2].trim();
    }

    calls.push({ name, arguments: args });
  }

  return calls;
}

function tryParseShorthandToolCall(text) {
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const cleaned = line.trim().replace(/^[`*_~]+|[`*_~]+$/g, '').trim();
    if (TOOL_NAMES.has(cleaned)) {
      return [{ name: cleaned, arguments: {} }];
    }
  }
  return [];
}

export function parseToolResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { toolCalls: [], finalMessage: '' };

  let finalMessage = '';
  let toolCalls = [];

  const parsed = tryParseJson(trimmed);
  if (parsed) {
    toolCalls = parseToolCallsFromJson(parsed);
    if (typeof parsed.final_message === 'string') finalMessage = parsed.final_message.trim();
    if (!finalMessage && typeof parsed.response === 'string') finalMessage = parsed.response.trim();
    if (toolCalls.length > 0 || finalMessage) {
      return { toolCalls, finalMessage };
    }
  }

  toolCalls = tryParseXmlToolCalls(trimmed);
  if (toolCalls.length > 0) {
    return { toolCalls, finalMessage: '' };
  }

  toolCalls = tryParseShorthandToolCall(trimmed);
  if (toolCalls.length > 0) {
    return { toolCalls, finalMessage: '' };
  }

  return { toolCalls: [], finalMessage: trimmed };
}

function resolveArg(args, ...keys) {
  for (const key of keys) {
    const val = args[key];
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

export async function runToolCall(toolCall, context) {
  const name = toolCall?.name;
  const args = parseToolArguments(toolCall?.arguments);

  if (name === 'read_agents_md') {
    const content = await getAgentsMd();
    return {
      name,
      ok: true,
      result: truncate(content, MAX_REMOTE_DOC_CHARS)
    };
  }

  if (name === 'read_system_prompt') {
    return {
      name,
      ok: true,
      result: readSystemPrompt(context.systemPromptPath)
    };
  }

  if (name === 'replace_system_prompt') {
    const content = String(resolveArg(args, 'content', 'text', 'prompt') || '');
    if (!content.trim()) {
      return {
        name,
        ok: false,
        error: 'content is required'
      };
    }

    if (content.length > MAX_SYSTEM_PROMPT_CHARS) {
      return {
        name,
        ok: false,
        error: `content exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`
      };
    }

    const path = writeSystemPrompt(context.systemPromptPath, content.endsWith('\n') ? content : `${content}\n`);
    return {
      name,
      ok: true,
      result: `Updated ${path}`
    };
  }

  if (name === 'list_repo_files') {
    return {
      name,
      ok: true,
      result: listRepoFiles()
    };
  }

  if (name === 'read_repo_file') {
    try {
      const path = assertReadableRepoPath(resolveArg(args, 'path', 'file_path', 'file_name', 'filename', 'name'));
      return {
        name,
        ok: true,
        result: truncate(readFileSync(path, 'utf8'), MAX_REPO_FILE_CHARS)
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: formatToolError(error)
      };
    }
  }

  if (name === 'propose_code_change') {
    try {
      const targetPath = String(resolveArg(args, 'path', 'file_path', 'file_name', 'filename', 'name') || '');
      const reason = String(resolveArg(args, 'reason', 'description', 'why', 'purpose') || '').trim();
      const content = String(resolveArg(args, 'content', 'code', 'body', 'text', 'change', 'diff') || '');
      const proposalPath = writeCodeProposal(targetPath, reason, content);

      return {
        name,
        ok: true,
        result: `Recorded proposal at ${proposalPath}`
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: formatToolError(error)
      };
    }
  }

  if (name === 'replace_repo_file') {
    if (!context.codeWriteEnabled) {
      return {
        name,
        ok: false,
        error: 'direct code writes are disabled; use propose_code_change or set GOOD_CITIZEN_CODE_WRITE_ENABLED=true'
      };
    }

    try {
      const path = assertWritableRepoPath(resolveArg(args, 'path', 'file_path', 'file_name', 'filename', 'name'));
      const content = String(resolveArg(args, 'content', 'code', 'body', 'text', 'change', 'diff') || '');
      if (!content.trim()) throw new Error('content is required');
      if (content.length > MAX_CODE_WRITE_CHARS) {
        throw new Error(`content exceeds ${MAX_CODE_WRITE_CHARS} characters`);
      }

      writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      return {
        name,
        ok: true,
        result: `Updated ${relative(process.cwd(), path)}`
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: formatToolError(error)
      };
    }
  }

  if (name === 'post_to_feed') {
    const message = String(resolveArg(args, 'message', 'text', 'content', 'body') || '').replace(/\s+/g, ' ').trim();
    if (!message) {
      return {
        name,
        ok: false,
        error: 'message is required'
      };
    }

    const botName = context.name || 'Good Citizen';
    const prefix = `${botName} check-in:`;
    const fullMessage = message.startsWith(prefix) ? message : `${prefix} ${message}`;

    if (fullMessage.length > MAX_STATUS_CHARS) {
      return {
        name,
        ok: false,
        error: `message exceeds ${MAX_STATUS_CHARS} characters`
      };
    }

    try {
      await postMessage(context.email, fullMessage, { name: context.name });
      return {
        name,
        ok: true,
        result: 'Message posted to feed successfully.'
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: formatToolError(error)
      };
    }
  }

  return {
    name: name || 'unknown',
    ok: false,
    error: 'unknown tool'
  };
}

function parseToolArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === 'object') return argumentsValue;
  if (typeof argumentsValue !== 'string' || !argumentsValue.trim()) return {};

  try {
    const parsed = JSON.parse(argumentsValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function listRepoFiles() {
  const files = [];
  walk(process.cwd(), files);
  return files.sort();
}

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const repoPath = relative(process.cwd(), path);
    if (isDeniedRepoPath(repoPath)) continue;

    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }

    if (isAllowedExtension(repoPath, ALLOWED_READ_EXTENSIONS)) {
      files.push(repoPath);
    }
  }
}

function assertReadableRepoPath(path) {
  const resolved = resolveRepoPath(path);
  const repoPath = relative(process.cwd(), resolved);
  if (isDeniedRepoPath(repoPath)) throw new Error('path is not readable');
  if (!isAllowedExtension(repoPath, ALLOWED_READ_EXTENSIONS)) {
    throw new Error('file extension is not readable');
  }
  if (!existsSync(resolved)) throw new Error('file does not exist');
  return resolved;
}

function assertWritableRepoPath(path) {
  const resolved = resolveRepoPath(path);
  const repoPath = relative(process.cwd(), resolved);
  if (isDeniedRepoPath(repoPath)) throw new Error('path is not writable');
  if (!isAllowedExtension(repoPath, ALLOWED_WRITE_EXTENSIONS)) {
    throw new Error('file extension is not writable');
  }
  if (!repoPath.startsWith('src/') && repoPath !== 'sdk.js' && repoPath !== 'README.md') {
    throw new Error('direct code writes are limited to src/, sdk.js, and README.md');
  }
  return resolved;
}

function resolveRepoPath(path) {
  let pathStr = String(path || '');
  const rootDirName = basename(process.cwd());
  
  // Strip leading root directory name if the model prepends it (e.g. "good-citizen-node/package.json")
  if (pathStr.startsWith(rootDirName + '/')) {
    pathStr = pathStr.slice(rootDirName.length + 1);
  }

  const resolved = resolve(process.cwd(), pathStr);
  const repoPath = relative(process.cwd(), resolved);
  if (!repoPath || repoPath.startsWith('..') || repoPath.startsWith('/')) {
    throw new Error('path must stay inside the repository');
  }
  return resolved;
}

function writeCodeProposal(targetPath, reason, content) {
  if (!targetPath.trim()) throw new Error('path is required');
  if (!reason) throw new Error('reason is required');
  if (!content.trim()) throw new Error('content is required');
  if (content.length > MAX_CODE_WRITE_CHARS) {
    throw new Error(`content exceeds ${MAX_CODE_WRITE_CHARS} characters`);
  }

  assertWritableRepoPath(targetPath);

  const proposalDir = resolve(process.cwd(), PROPOSAL_DIR);
  mkdirSync(proposalDir, { recursive: true });

  const safeName = targetPath.replace(/[^a-z0-9._-]+/gi, '_');
  const proposalPath = resolve(proposalDir, `${Date.now()}_${safeName}.md`);
  const body = [
    `# Proposed change for ${targetPath}`,
    '',
    `Reason: ${reason}`,
    '',
    '```',
    content,
    '```'
  ].join('\n');

  writeFileSync(proposalPath, `${body}\n`, 'utf8');
  return relative(process.cwd(), proposalPath);
}

function isDeniedRepoPath(path) {
  return path.split('/').some((part) => DENIED_PATH_PARTS.has(part));
}

function isAllowedExtension(path, allowedExtensions) {
  const extension = extname(path);
  return allowedExtensions.has(extension);
}

function truncate(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatToolError(error) {
  return error instanceof Error ? error.message : String(error);
}
