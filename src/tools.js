import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { getAgentsMd } from '../sdk.js';
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
    'Because tools are enabled, first decide whether the loaded SystemPrompt.md can be improved for trust, truthfulness, protocol usefulness, or Alphacoin earning through Proof-of-Trust.',
    'If the prompt can be improved, return a replace_system_prompt tool call before your final public message.',
    'If no prompt edit is needed, return a final status message as plain text or as final_message JSON.',
    'You may return exactly one JSON object.',
    'Do not wrap JSON in Markdown.',
    'JSON shape:',
    '{"tool_calls":[{"name":"tool_name","arguments":{}}],"final_message":"optional message to post"}',
    '',
    'Available tools:',
    '- read_agents_md: fetches https://alphacoin.uk/agents.md. Arguments: {}',
    '- read_system_prompt: returns the current system prompt. Arguments: {}',
    '- replace_system_prompt: replaces the configured SystemPrompt.md file. Arguments: {"content":"full new prompt"}',
    '- list_repo_files: lists readable repository files. Arguments: {}',
    '- read_repo_file: reads an allowlisted repository file. Arguments: {"path":"relative/path"}',
    '- propose_code_change: records a proposed repository change under proposals/. Arguments: {"path":"relative/path","reason":"why","content":"full proposed file content"}',
    '- replace_repo_file: replaces an allowlisted repository file only if GOOD_CITIZEN_CODE_WRITE_ENABLED=true. Arguments: {"path":"relative/path","content":"full new file content"}',
    '- remember_status_message: saves the message you want posted. Arguments: {"message":"message text"}',
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

export function parseToolResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) {
    return {
      toolCalls: [],
      finalMessage: trimmed
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      toolCalls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
      finalMessage: typeof parsed.final_message === 'string' ? parsed.final_message.trim() : ''
    };
  } catch {
    return {
      toolCalls: [],
      finalMessage: trimmed
    };
  }
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
    const content = String(args.content || '');
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
      const path = assertReadableRepoPath(args.path);
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
      const targetPath = String(args.path || '');
      const reason = String(args.reason || '').trim();
      const content = String(args.content || '');
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
      const path = assertWritableRepoPath(args.path);
      const content = String(args.content || '');
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

  if (name === 'remember_status_message') {
    const message = String(args.message || '').replace(/\s+/g, ' ').trim();
    if (!message) {
      return {
        name,
        ok: false,
        error: 'message is required'
      };
    }

    if (message.length > MAX_STATUS_CHARS) {
      return {
        name,
        ok: false,
        error: `message exceeds ${MAX_STATUS_CHARS} characters`
      };
    }

    context.statusMessage = message;
    return {
      name,
      ok: true,
      result: 'Saved status message for this tick.'
    };
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
  const resolved = resolve(process.cwd(), String(path || ''));
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
