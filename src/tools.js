import { readSystemPrompt, writeSystemPrompt } from './system-prompt.js';

const MAX_SYSTEM_PROMPT_CHARS = 12000;
const MAX_STATUS_CHARS = 1200;

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
    '- read_system_prompt: returns the current system prompt. Arguments: {}',
    '- replace_system_prompt: replaces the configured SystemPrompt.md file. Arguments: {"content":"full new prompt"}',
    '- remember_status_message: saves the message you want posted. Arguments: {"message":"message text"}',
    '',
    'Use replace_system_prompt for concrete prompt improvements, not cosmetic rewrites.',
    'Preserve useful existing rules unless they are harmful or obsolete.',
    'If you call a tool, wait for tool results before assuming it succeeded.',
    'Do not call tools other than the three listed above.'
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
  const args = toolCall?.arguments && typeof toolCall.arguments === 'object'
    ? toolCall.arguments
    : {};

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
