/**
 * The model port for one `ai.models` entry: reads the entry list, the selected entry and its key
 * from SecretStorage, and returns the port the turn runs on. Failures are port errors whose text
 * names the entry id only, never a key, URL or header.
 */
import { ModelPortError } from '../model/modelPort';
import type { ProviderModelPort, ProviderModelPortOptions } from '../model/providerModelPort';
import { apiKeySecretName, parseModelEntries } from './modelEntries';
import { createProviderModelPort } from './openAiTransport';

/** Where the entry list, the default entry and the keys live; `vscode` satisfies it structurally. */
export interface ModelPortSources {
  /** The raw `dataLineageViz.ai.models` value. */
  readonly models: unknown;
  /** The `dataLineageViz.ai.defaultModel` value. */
  readonly defaultModel: string | undefined;
  readonly secrets: { get(key: string): PromiseLike<string | undefined> };
}

/**
 * Builds the port for `entryId`, or for `ai.defaultModel` when none is given. `effort` replaces the
 * entry's own `reasoningEffort` for this port's requests.
 *
 * @throws `ModelPortError` `invalid_request` when no valid entry is selected, `no_permission` when
 * the entry has no stored key.
 */
export async function createConfiguredModelPort(
  sources: ModelPortSources,
  options: ProviderModelPortOptions & { readonly entryId?: string; readonly effort?: string } = {},
): Promise<ProviderModelPort> {
  const { entryId = sources.defaultModel, ...portOptions } = options;
  const { entries, invalid } = parseModelEntries(sources.models);
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    const named = invalid.find((candidate) => candidate.name === entryId);
    throw new ModelPortError('invalid_request', named
      ? `Model entry "${named.name}" is invalid in ai.models.`
      : 'No model entry is selected; add one to ai.models and set ai.defaultModel.');
  }
  const apiKey = (await sources.secrets.get(apiKeySecretName(entry.id)))?.trim();
  if (!apiKey) {
    throw new ModelPortError('no_permission', `No API key is stored for model entry "${entry.id}"; run Data Lineage: Set API key.`);
  }
  return createProviderModelPort(entry, apiKey, portOptions);
}
