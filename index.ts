import { claudeCodeRuntime } from './runtime.js';
import { CLAUDE_CODE_SYSTEM_PROMPT } from './system-prompt.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  definePlugin,
  type PluginContext,
} from '@meetopenbot/plugin-sdk';

const claudeCodePlugin = {
  id: 'claude-code',
  name: 'Claude Code',
  description:
    'Anthropic Claude Code agent. Uses the Claude Agent SDK to read code, edit files, and run shell commands inside the channel\'s workspace.',
  configSchema: {
    type: 'object' as const,
    properties: {
      model: {
        type: 'string' as const,
        description: 'Claude model alias or full id (e.g. sonnet, opus, claude-opus-4-5).',
        default: 'sonnet',
      },
      permissionMode: {
        type: 'string' as const,
        description:
          'How the SDK handles tool permission prompts: default | acceptEdits | bypassPermissions | plan | dontAsk | auto.',
        default: 'default',
        enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
      },
    },
  },
  factory: ({ agentDetails, config, storage }: PluginContext) => {
    const model = typeof config.model === 'string' && config.model ? config.model : 'sonnet';
    const permissionMode = (
      typeof config.permissionMode === 'string' && config.permissionMode
        ? config.permissionMode
        : 'default'
    ) as NonNullable<Options['permissionMode']>;

    return claudeCodeRuntime({
      model,
      permissionMode,
      system: agentDetails.instructions || CLAUDE_CODE_SYSTEM_PROMPT,
      storage,
    });
  },
};

export default definePlugin(claudeCodePlugin);