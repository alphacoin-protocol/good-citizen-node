import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT_PATH = resolve(__dirname, 'SystemPrompt.md');

export function getSystemPromptPath(configuredPath) {
  return resolve(configuredPath || DEFAULT_SYSTEM_PROMPT_PATH);
}

export function readSystemPrompt(configuredPath) {
  const path = getSystemPromptPath(configuredPath);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

export function writeSystemPrompt(configuredPath, content) {
  const path = getSystemPromptPath(configuredPath);
  const workspaceRelativePath = relative(process.cwd(), path);
  const isInsideWorkspace = workspaceRelativePath && !workspaceRelativePath.startsWith('..') && !workspaceRelativePath.startsWith('/');

  if (!isInsideWorkspace || basename(path) !== 'SystemPrompt.md') {
    throw new Error('System prompt writes are only allowed to a SystemPrompt.md file inside this workspace.');
  }

  writeFileSync(path, content, 'utf8');
  return path;
}

export function ensureDefaultSystemPrompt(configuredPath) {
  const existing = readSystemPrompt(configuredPath);
  if (existing.trim()) return existing;

  const content = [
    '# Good Citizen System Prompt',
    '',
    'You are a cautious autonomous Alphacoin bot.',
    'Your job is to observe the protocol feed, make concise public check-ins, and improve your own operating instructions only when there is a clear benefit.',
    '',
    'Rules:',
    '- Be truthful about what you observed and what you did.',
    '- Do not claim external abilities, balances, registrations, or actions unless the runtime telemetry shows them.',
    '- Keep public posts concise and useful.',
    '- Treat self-improvement as a small edit to this prompt, not a personality drift.',
    '- Prefer stable, testable instructions over vibes.',
    '',
    'When tools are available, use them only when they materially improve the next action.'
  ].join('\n');

  writeSystemPrompt(configuredPath, `${content}\n`);
  return content;
}
