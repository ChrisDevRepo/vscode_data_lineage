/**
 * The model port for one `ai.models` entry or live VS Code language model: reads the entry list, the
 * selected entry and, for an API entry, its key from SecretStorage, and returns the port the turn
 * runs on. Failures are port errors whose text names the entry id only, never a key, URL or header.
 */
import { ModelPortError } from '../model/modelPort';
import { ProviderModelPort, type ProviderModelPortOptions } from '../model/providerModelPort';
import { apiKeySecretName, LIVE_MODEL_ID_PREFIX, parseModelEntries, type VscodeLmModelEntry } from './modelEntries';
import { createProviderModelPort } from './openAiTransport';
import { createVscodeLmChat, type LmModelInfo } from './vscodeLmTransport';
import { NO_MODEL_MESSAGE } from '../../engine/shared/chatContract';

/** Where the entry list, the default entry and the keys live; the VS Code API fits it. */
export interface ModelPortSources {
  /** The raw `dataLineageViz.ai.models` value. */
  readonly models: unknown;
  /** The `dataLineageViz.ai.defaultModel` value. */
  readonly defaultModel: string | undefined;
  readonly secrets: { get(key: string): PromiseLike<string | undefined> };
  /** The language model a `vscode-lm` entry id or a live selection id resolves to right now. */
  readonly lmModel: (id: string) => LmModelInfo | undefined;
}

/**
 * Builds the port for `entryId`, or for `ai.defaultModel` when none is given. `effort` replaces the
 * entry's own `reasoningEffort` for this port's requests.
 *
 * An `entryId` with the live-model prefix names a language model VS Code lists, which needs no
 * entry and sends no `modelOptions`.
 *
 * @throws `ModelPortError` `invalid_request` when no valid entry is selected, `no_permission` when
 * the entry has no stored key, `model_not_found` when no language model matches a `vscode-lm` entry
 * or live selection.
 */
export async function createConfiguredModelPort(
  sources: ModelPortSources,
  options: ProviderModelPortOptions & { readonly entryId?: string; readonly effort?: string } = {},
): Promise<ProviderModelPort> {
  const { entryId = sources.defaultModel, ...portOptions } = options;
  if (entryId?.startsWith(LIVE_MODEL_ID_PREFIX)) {
    const info = sources.lmModel(entryId);
    return lmPort(info, { id: entryId, name: info?.name ?? entryId, apiType: 'vscode-lm', selector: {} }, portOptions);
  }
  const { entries, invalid } = parseModelEntries(sources.models);
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    const named = invalid.find((candidate) => candidate.name === entryId);
    throw new ModelPortError('invalid_request', named
      ? `Model entry "${named.name}" is invalid in ai.models.`
      : NO_MODEL_MESSAGE);
  }
  if (entry.apiType === 'vscode-lm') return lmPort(sources.lmModel(entry.id), entry, portOptions);
  const apiKey = (await sources.secrets.get(apiKeySecretName(entry.id)))?.trim();
  if (!apiKey) {
    throw new ModelPortError(
      'no_permission',
      `No API key is stored for model entry "${entry.id}"; run Data Lineage: Update AI Model Key.`,
    );
  }
  return createProviderModelPort(entry, apiKey, portOptions);
}

function lmPort(info: LmModelInfo | undefined, entry: VscodeLmModelEntry, options: ProviderModelPortOptions): ProviderModelPort {
  if (!info) throw new ModelPortError('model_not_found', `No VS Code language model matches model entry "${entry.id}".`);
  return new ProviderModelPort(createVscodeLmChat(entry, info.model), options);
}
