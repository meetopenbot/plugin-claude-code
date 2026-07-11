import { defaultAuthMode, isCloudMode } from './cloud-mode.js';
import { claudeCodeRuntime, type ClaudeAuthMode } from './runtime.js';
import { CLAUDE_CODE_SYSTEM_PROMPT } from './system-prompt.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  definePlugin,
  type PluginContext,
} from '@meetopenbot/plugin-sdk';

const resolveAuthMode = (config: Record<string, unknown>): ClaudeAuthMode => {
  if (config.authMode === 'byok' || config.authMode === 'credits') {
    return config.authMode;
  }
  return defaultAuthMode();
};

const claudeCodePlugin = {
  id: 'claude-code',
  name: 'Claude Code',
  description:
    'Anthropic Claude Code agent. Uses the Claude Agent SDK to read code, edit files, and run shell commands inside the channel\'s workspace.',
  configSchema: {
    type: 'object' as const,
    properties: {
      ...(isCloudMode()
        ? {
            authMode: {
              type: 'string' as const,
              description:
                'Credits — use your workspace credit balance via OpenBot. BYOK — bring your own Anthropic API key.',
              enum: ['credits', 'byok'],
              default: 'credits',
            },
          }
        : {}),
      model: {
        type: 'string' as const,
        description: 'Claude model alias or full id (e.g. sonnet, opus, claude-opus-4-5).',
        default: 'sonnet',
      },
      permissionMode: {
        type: 'string' as const,
        description:
          'How the SDK handles tool permission prompts: default | acceptEdits | bypassPermissions | plan | dontAsk | auto.',
        default: 'bypassPermissions',
        enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
      },
      executablePath: {
        type: 'string' as const,
        description:
          'Path to the Claude Code CLI executable. When unset, the plugin attempts to find it in your PATH, falling back to the SDK bundled binary.',
      },
    },
  },
  factory: ({ agentDetails, config, storage }: PluginContext) => {
    const model = typeof config.model === 'string' && config.model ? config.model : 'sonnet';
    const permissionMode = (
      typeof config.permissionMode === 'string' && config.permissionMode
        ? config.permissionMode
        : 'bypassPermissions'
    ) as NonNullable<Options['permissionMode']>;
    const executablePath =
      typeof config.executablePath === 'string' && config.executablePath
        ? config.executablePath
        : undefined;

    return claudeCodeRuntime({
      model,
      permissionMode,
      executablePath,
      authMode: resolveAuthMode(config),
      system: agentDetails.instructions || CLAUDE_CODE_SYSTEM_PROMPT,
      storage,
    });
  },
};

export default definePlugin(claudeCodePlugin);