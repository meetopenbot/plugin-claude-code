const REGISTRY_URL =
  'https://raw.githubusercontent.com/meetopenbot/openbot-registry/main/registry.json';

const ANTHROPIC_PROVIDER = 'anthropic';

type RegistryModel = { id: string; label: string; description: string };

type Registry = {
  providers?: Record<string, { label: string; models: RegistryModel[] }>;
};

export type ModelConfigField = {
  type: 'string';
  description: string;
  default?: string;
  override?: boolean;
  enum?: string[];
  options?: Array<{ label: string; value: string; description?: string }>;
};

const freeInputModelField = (): ModelConfigField => ({
  type: 'string',
  override: true,
  description: 'Claude model alias or full id (e.g. sonnet, opus, claude-opus-4-5).',
  default: 'sonnet',
});

export async function resolveModelConfigField(): Promise<ModelConfigField> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return freeInputModelField();

    const registry = (await res.json()) as Registry;
    const models = registry.providers?.[ANTHROPIC_PROVIDER]?.models ?? [];
    if (models.length === 0) return freeInputModelField();

    const defaultModel =
      models.find((model) => /sonnet/i.test(model.id))?.id ?? models[0].id;

    return {
      type: 'string',
      override: true,
      description: 'Claude model from the OpenBot registry (Anthropic).',
      default: defaultModel,
      enum: models.map((model) => model.id),
      options: models.map((model) => ({
        label: model.label,
        value: model.id,
        description: model.description,
      })),
    };
  } catch {
    return freeInputModelField();
  }
}
