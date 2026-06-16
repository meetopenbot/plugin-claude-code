import { execSync } from 'node:child_process';
import { existsSync, readlinkSync, statSync } from 'node:fs';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  agentOutput,
  shouldHandleInvoke,
  uiWidget,
  type AgentInvokeEvent,
  type OpenBotState,
  type PluginFactory,
  type Storage,
} from '@meetopenbot/plugin-sdk';

export interface ClaudeCodeRuntimeOptions {
  /** Claude model alias or full id (e.g. `sonnet`, `claude-opus-4-5`). */
  model?: string;
  /** System prompt prepended to the SDK's default tools/system. */
  system?: string;
  /** Permission mode forwarded to the Claude Agent SDK. */
  permissionMode?: NonNullable<Options['permissionMode']>;
  /** Working directory for the SDK subprocess (falls back to channel cwd). */
  cwd?: string;
  /** Path to the Claude Code CLI executable (falls back to the SDK bundled binary). */
  executablePath?: string;
  /** Restrict the SDK's built-in tools (Read, Edit, Bash, ...). */
  allowedTools?: string[];
  /** Storage handle for persisting the resume session id across runs. */
  storage?: Storage;
}

interface PersistedClaudeState {
  claudeSessionId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readPersistedSessionId = (state: OpenBotState): string | undefined => {
  const source = state.threadDetails?.state ?? state.channelDetails?.state;
  const record = asRecord(source) as PersistedClaudeState;
  return typeof record.claudeSessionId === 'string' ? record.claudeSessionId : undefined;
};

const persistSessionId = async (
  state: OpenBotState,
  storage: Storage | undefined,
  sessionId: string,
): Promise<void> => {
  if (!storage) return;
  const patch = { claudeSessionId: sessionId };
  if (state.threadId) {
    await storage.patchThreadState({
      channelId: state.channelId,
      threadId: state.threadId,
      state: patch,
    });
    return;
  }
  await storage.patchChannelState({ channelId: state.channelId, state: patch });
};

const AUTH_ERROR_PATTERNS = [
  'api key',
  'apikey',
  'anthropic_api_key',
  'authentication',
  'unauthorized',
  '401',
  'not logged in',
  'login',
  'oauth',
];

const isAuthErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lower.includes(p));
};

const buildApiKeyWidget = (
  agentId: string,
  threadId: string | undefined,
  reason: string,
) =>
  uiWidget({
    agentId,
    threadId,
    widget: {
      kind: 'form',
      widgetId: `claude_code_api_key_request_${Date.now()}`,
      title: 'Anthropic API Key Required',
      description:
        `Claude Code could not authenticate (${reason}). ` +
        'Provide an Anthropic API key to continue. You can [get your API key from the Anthropic Console](https://console.anthropic.com/settings/keys). ' +
        'The key is stored as a workspace variable on your machine and never leaves your local runtime.',
      fields: [
        {
          id: 'apiKey',
          label: 'API Key',
          type: 'text',
          placeholder: 'sk-ant-...',
          required: true,
        },
      ],
      submitLabel: 'Save API Key',
      metadata: {
        type: 'api_key_request',
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        source: 'claude-code',
      },
    },
  });

const toolCallWidgetId = (toolUseId: string) => `claude_code_tool_${toolUseId}`;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…` : s);

const MAX_STDERR_CHARS = 4000;
const MAX_ERROR_CHARS = 12_000;

interface ClaudeLaunchContext {
  executablePath?: string;
  workingDir?: string;
}

interface SystemErrorLike {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

const asSystemError = (value: unknown): SystemErrorLike | undefined =>
  value && typeof value === 'object' ? (value as SystemErrorLike) : undefined;

const spawnFailureHint = (code: string | undefined, executablePath?: string): string | undefined => {
  switch (code) {
    case 'EACCES':
      return executablePath
        ? `Permission denied executing "${executablePath}". Check chmod +x and macOS quarantine (xattr -d com.apple.quarantine "${executablePath}").`
        : 'Permission denied executing the Claude Code binary.';
    case 'EPERM':
      return 'Operation not permitted when launching Claude Code. Common under sandboxed runtimes or restricted security policies.';
    case 'ENOENT':
      return executablePath
        ? `No such file at "${executablePath}", or a required runtime/interpreter is missing.`
        : 'Claude Code executable or required runtime not found.';
    case 'ENOTDIR':
    case 'ELOOP':
      return 'Invalid executable path — a path component is not a directory or is a symlink loop.';
    default:
      return undefined;
  }
};

const describePathAccess = (label: string, path: string): string | undefined => {
  try {
    if (!existsSync(path)) return `${label}: missing (${path})`;
    const st = statSync(path);
    const lines = [
      `${label}: ${path}`,
      `exists: yes`,
      `type: ${st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'}`,
    ];
    if (st.isFile()) {
      lines.push(`size: ${st.size} bytes`);
      lines.push(`mode: ${(st.mode & 0o777).toString(8)}`);
      lines.push(`executable bit: ${(st.mode & 0o111) !== 0 ? 'yes' : 'no'}`);
    }
    try {
      const target = readlinkSync(path);
      lines.push(`symlink target: ${target}`);
      lines.push(`target exists: ${existsSync(target) ? 'yes' : 'no'}`);
    } catch {
      // not a symlink
    }
    return lines.join('\n');
  } catch (inspectError) {
    return `${label}: could not inspect (${path}): ${inspectError instanceof Error ? inspectError.message : String(inspectError)
      }`;
  }
};

const launchFailureHintsFromInspection = (
  executableDetails: string | undefined,
  workingDirDetails: string | undefined,
  executablePath?: string,
): string[] => {
  const hints: string[] = [];
  if (workingDirDetails?.includes('missing')) {
    hints.push('Working directory does not exist. Create it or remove the cwd override from config.');
  }
  if (executableDetails?.includes('executable bit: no')) {
    const hint = spawnFailureHint('EACCES', executablePath);
    if (hint) hints.push(hint);
  }
  if (executableDetails?.includes('target exists: no')) {
    hints.push('Executable symlink target is missing. Reinstall Claude Code or point executablePath at a valid binary.');
  }
  if (executableDetails?.includes('missing')) {
    const hint = spawnFailureHint('ENOENT', executablePath);
    if (hint) hints.push(hint);
  }
  if (hints.length === 0) {
    hints.push(
      'The Claude Code process could not be started. Verify executablePath, working directory permissions, and that OpenBot can spawn child processes in this environment.',
    );
  }
  return hints;
};

const formatClaudeCodeError = (
  error: unknown,
  context: ClaudeLaunchContext,
  stderrChunks: string[],
): string => {
  const err = error instanceof Error ? error : new Error(String(error));
  const parts: string[] = [err.message];

  const causeLines: string[] = [];
  let current: unknown = err.cause;
  while (current) {
    if (current instanceof Error) {
      causeLines.push(current.message);
      const sys = asSystemError(current);
      if (sys?.code) causeLines.push(`  code: ${sys.code}`);
      if (sys?.errno !== undefined) causeLines.push(`  errno: ${sys.errno}`);
      if (sys?.syscall) causeLines.push(`  syscall: ${sys.syscall}`);
      if (sys?.path) causeLines.push(`  path: ${sys.path}`);
      current = current.cause;
    } else {
      causeLines.push(String(current));
      break;
    }
  }
  if (causeLines.length > 0) parts.push(`Cause:\n${causeLines.join('\n')}`);

  const sys = asSystemError(err.cause) ?? asSystemError(err);
  const hint = spawnFailureHint(sys?.code, context.executablePath);
  if (hint) parts.push(hint);

  const isLaunchFailure =
    err.message.includes('failed to launch') ||
    err.message.includes('not found') ||
    err.message.includes('Failed to spawn') ||
    err.message.includes('exited with code') ||
    err.message.includes('terminated by signal');

  if (isLaunchFailure) {
    const executableDetails = context.executablePath
      ? describePathAccess('Executable', context.executablePath)
      : 'Executable: using SDK bundled binary (no executablePath override).';
    const workingDirDetails = context.workingDir
      ? describePathAccess('Working directory', context.workingDir)
      : undefined;
    parts.push(`Launch diagnostics:\n${executableDetails}`);
    if (workingDirDetails) parts.push(workingDirDetails);
    if (err.message.includes('failed to launch')) {
      for (const launchHint of launchFailureHintsFromInspection(
        executableDetails,
        workingDirDetails,
        context.executablePath,
      )) {
        parts.push(launchHint);
      }
    }
  }

  const stderr = stderrChunks.join('').trim();
  if (stderr) parts.push(`Process stderr:\n${truncate(stderr, MAX_STDERR_CHARS)}`);

  return truncate(parts.join('\n\n'), MAX_ERROR_CHARS);
};

const formatResultError = (message: SDKMessage): string => {
  if (message.type !== 'result' || message.subtype === 'success') return '';
  const record = asRecord(message);
  const parts: string[] = [`subtype: ${message.subtype}`];
  const result = record.result;
  if (typeof result === 'string' && result) parts.push(`result: ${result}`);
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    parts.push(`errors:\n${errors.map((entry) => `- ${String(entry)}`).join('\n')}`);
  }
  return parts.join('\n');
};

const formatJsonForWidget = (value: unknown, maxLen: number): string => {
  try {
    return truncate(JSON.stringify(value, null, 2), maxLen);
  } catch {
    return truncate(String(value), maxLen);
  }
};

const formatToolInputBody = (input: unknown, maxLen = 8000): string =>
  `Input:\n${formatJsonForWidget(input, maxLen)}`;

const formatToolResultBody = (input: unknown, output: string): string => {
  const inputSection = formatJsonForWidget(input, 4000);
  const parts = [`Input:\n${inputSection}`, `Output:\n${output}`];
  return parts.join('\n\n');
};

const formatToolResultPayload = (
  content: unknown,
  isError?: boolean,
): { body: string; state?: 'error' } => {
  let body: string;
  if (typeof content === 'string') {
    body = truncate(content, 12_000);
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: unknown }).text;
        if (typeof t === 'string' && t.length > 0) textParts.push(t);
      }
    }
    body =
      textParts.length > 0
        ? truncate(textParts.join('\n'), 12_000)
        : formatJsonForWidget(content, 12_000);
  } else {
    body = formatJsonForWidget(content, 12_000);
  }
  return isError ? { body, state: 'error' } : { body };
};

type ParsedToolUse = { toolUseId: string; title: string; input: unknown };

const parseToolUseBlock = (block: unknown): ParsedToolUse | null => {
  if (!block || typeof block !== 'object' || !('type' in block)) return null;
  const type = (block as { type: string }).type;
  if (type === 'tool_use') {
    const b = block as { id?: unknown; name?: unknown; input?: unknown };
    if (typeof b.id !== 'string' || typeof b.name !== 'string') return null;
    return { toolUseId: b.id, title: b.name, input: b.input };
  }
  if (type === 'mcp_tool_use') {
    const b = block as { id?: unknown; name?: unknown; server_name?: unknown; input?: unknown };
    if (typeof b.id !== 'string' || typeof b.name !== 'string') return null;
    const title =
      typeof b.server_name === 'string' ? `${b.server_name}: ${b.name}` : b.name;
    return { toolUseId: b.id, title, input: b.input };
  }
  if (type === 'server_tool_use') {
    const b = block as { id?: unknown; name?: unknown; input?: unknown };
    if (typeof b.id !== 'string' || typeof b.name !== 'string') return null;
    return { toolUseId: b.id, title: b.name, input: b.input };
  }
  return null;
};

type ParsedToolResult = { toolUseId: string; content: unknown; isError?: boolean };

const parseToolResultBlock = (block: unknown): ParsedToolResult | null => {
  if (!block || typeof block !== 'object' || !('type' in block)) return null;
  const type = (block as { type: string }).type;
  if (type === 'tool_result' || type === 'mcp_tool_result') {
    const b = block as { tool_use_id?: unknown; content?: unknown; is_error?: boolean };
    if (typeof b.tool_use_id !== 'string') return null;
    return { toolUseId: b.tool_use_id, content: b.content, isError: b.is_error };
  }
  return null;
};

const findClaudeExecutable = (): string | undefined => {
  try {
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    const path = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path && existsSync(path)) {
      return path;
    }
  } catch {
    // ignore errors (e.g. command not found)
  }
  return undefined;
};

/**
 * OpenBot plugin that drives an agent backed by `@anthropic-ai/claude-agent-sdk`.
 */
export const claudeCodeRuntime =
  (options: ClaudeCodeRuntimeOptions = {}): PluginFactory =>
    (builder) => {
      const {
        model = 'sonnet',
        system,
        permissionMode = 'default',
        cwd,
        executablePath: executablePathOverride,
        allowedTools,
        storage,
      } = options;

      const executablePath = executablePathOverride || findClaudeExecutable();

      builder.on('agent:invoke', async function* (event, context) {
        if (!shouldHandleInvoke(event as AgentInvokeEvent, context.state.agentId)) {
          return;
        }

        const userContent =
          typeof event.data?.content === 'string' ? event.data.content : '';
        if (!userContent) return;

        const threadId = event.meta?.threadId || context.state.threadId;

        const resumeId = readPersistedSessionId(context.state);
        const workingDir = cwd ?? context.state.channelDetails?.cwd;

        const stderrChunks: string[] = [];
        const launchContext: ClaudeLaunchContext = {
          executablePath,
          workingDir,
        };
        const sdkOptions: Options = {
          model,
          permissionMode,
          stderr: (data) => {
            stderrChunks.push(data);
          },
          ...(system ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: system } } : {}),
          ...(resumeId ? { resume: resumeId } : {}),
          ...(workingDir ? { cwd: workingDir } : {}),
          ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
          ...(allowedTools ? { allowedTools } : {}),
        };

        try {
          let lastSessionId: string | undefined = resumeId;
          let authWidgetYielded = false;
          const emittedToolCallIds = new Set<string>();
          const emittedToolResultIds = new Set<string>();
          const toolTitleByUseId = new Map<string, { title: string; input: unknown }>();

          for await (const message of query({ prompt: userContent, options: sdkOptions })) {
            if ('session_id' in message && typeof message.session_id === 'string') {
              lastSessionId = message.session_id;
            }

            if (
              !authWidgetYielded &&
              message.type === 'assistant' &&
              (message.error === 'authentication_failed' ||
                message.error === 'oauth_org_not_allowed')
            ) {
              authWidgetYielded = true;
              yield buildApiKeyWidget(context.state.agentId, threadId, message.error);

              yield agentOutput({
                agentId: context.state.agentId,
                threadId,
                content: 'Claude needs an API key to continue. Please provide ANTHROPIC_API_KEY as a variable from the workspace settings or inside the widget above.',
              });
              return;
            }

            if (message.type === 'assistant') {
              const content = message.message?.content;
              if (Array.isArray(content)) {
                const textParts: string[] = [];
                for (const block of content) {
                  const tool = parseToolUseBlock(block);
                  if (tool) {
                    if (textParts.length > 0) {
                      const joined = textParts.join('\n');
                      textParts.length = 0;
                      if (joined.length > 0) {
                        yield agentOutput({
                          agentId: context.state.agentId,
                          threadId,
                          content: joined,
                        });
                      }
                    }
                    if (!emittedToolCallIds.has(tool.toolUseId)) {
                      emittedToolCallIds.add(tool.toolUseId);
                      toolTitleByUseId.set(tool.toolUseId, { title: tool.title, input: tool.input });
                      yield uiWidget({
                        agentId: context.state.agentId,
                        threadId,
                        widget: {
                          kind: 'message',
                          widgetId: toolCallWidgetId(tool.toolUseId),
                          title: toolTitleByUseId.get(tool.toolUseId)?.title ?? '',
                          body: formatToolInputBody(tool.input),
                          display: 'collapsed',
                          variant: 'basic',
                          metadata: {
                            type: 'claude_tool',
                            phase: 'call',
                            toolName: tool.title,
                            toolUseId: tool.toolUseId,
                            source: 'claude-code',
                          },
                        },
                      });
                    }
                    continue;
                  }
                  if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
                    const t = (block as { text?: unknown }).text;
                    if (typeof t === 'string' && t.length > 0) textParts.push(t);
                  }
                }
                if (textParts.length > 0) {
                  const joined = textParts.join('\n');
                  if (joined.length > 0) {
                    yield agentOutput({
                      agentId: context.state.agentId,
                      threadId,
                      content: joined,
                    });
                  }
                }
              }
            }

            if (message.type === 'user') {
              const param = message.message;
              if (param.role === 'user' && Array.isArray(param.content)) {
                for (const block of param.content) {
                  const res = parseToolResultBlock(block);
                  if (!res || emittedToolResultIds.has(res.toolUseId)) continue;
                  emittedToolResultIds.add(res.toolUseId);
                  const { body, state } = formatToolResultPayload(res.content, res.isError);
                  yield uiWidget({
                    agentId: context.state.agentId,
                    threadId,
                    widget: {
                      kind: 'message',
                      widgetId: toolCallWidgetId(res.toolUseId),
                      title: toolTitleByUseId.get(res.toolUseId)?.title ?? '',
                      body: formatToolResultBody(
                        toolTitleByUseId.get(res.toolUseId)?.input,
                        body,
                      ),
                      display: 'collapsed',
                      variant: 'basic',
                      ...(state ? { state } : {}),
                      metadata: {
                        type: 'claude_tool',
                        phase: 'result',
                        toolUseId: res.toolUseId,
                        source: 'claude-code',
                      },
                    },
                  });
                }
              }
            }

            if (message.type === 'result' && message.subtype !== 'success') {
              const subtype = (message as { subtype: string }).subtype;
              const resultText =
                'result' in message && typeof (message as { result?: unknown }).result === 'string'
                  ? (message as { result: string }).result
                  : '';
              if (!authWidgetYielded && (isAuthErrorMessage(subtype) || isAuthErrorMessage(resultText))) {
                authWidgetYielded = true;
                yield buildApiKeyWidget(context.state.agentId, threadId, subtype);
                return;
              }
              const details = formatResultError(message);
              yield agentOutput({
                agentId: context.state.agentId,
                threadId,
                content: details
                  ? `[claude-code] run ended with error:\n${details}`
                  : `[claude-code] run ended with error: ${subtype}`,
              });
            }
          }

          if (lastSessionId && lastSessionId !== resumeId) {
            await persistSessionId(context.state, storage, lastSessionId);
          }
        } catch (error) {
          const errorMessage = formatClaudeCodeError(error, launchContext, stderrChunks);
          if (isAuthErrorMessage(errorMessage)) {
            yield buildApiKeyWidget(context.state.agentId, threadId, errorMessage);
            return;
          }
          yield agentOutput({
            agentId: context.state.agentId,
            threadId,
            content: `[claude-code] error:\n${errorMessage}`,
          });
        }
      });

      builder.on('client:ui:widget:response', async function* (event, context) {
        const { metadata, values, widgetId } = event.data ?? {};
        if (!metadata || metadata.type !== 'api_key_request') return;
        if (metadata.source !== 'claude-code') return;
        const apiKey = values?.apiKey;
        if (typeof apiKey !== 'string' || !apiKey) return;

        const envVar = typeof metadata.envVar === 'string' ? metadata.envVar : 'ANTHROPIC_API_KEY';

        if (!storage) {
          yield agentOutput({
            agentId: context.state.agentId,
            content: '[claude-code] no storage available; cannot persist API key.',
          });
          return;
        }

        try {
          await storage.createVariable({ key: envVar, value: apiKey, secret: true });
          process.env[envVar] = apiKey;

          yield uiWidget({
            agentId: context.state.agentId,
            widget: {
              widgetId: widgetId ?? `claude_code_api_key_saved_${Date.now()}`,
              kind: 'message',
              title: 'API Key Saved',
              body: `Saved ${envVar} as a workspace variable. You can now continue the conversation.`,
              state: 'submitted'
            },
          });

          yield agentOutput({
            agentId: context.state.agentId,
            content:
              'Saved Anthropic API key to workspace variables. Re-send your last message to retry.',
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          yield agentOutput({
            agentId: context.state.agentId,
            content: `[claude-code] failed to save API key: ${errorMessage}`,
          });
        }
      });
    };
