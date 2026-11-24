/**
 * The `Add / Edit / Remove AI Model` and `Update AI Model Key` commands, and the multi-step wizard
 * behind add and edit: the AI counterpart of the Database Connection commands, on the same
 * QuickInput steps ({@link wizardPrompts}). An entry is the `dataLineageViz.ai.models` item the
 * settings schema declares, written to user settings; its key lives in SecretStorage under the
 * entry id and is never in settings, a log line or a message.
 */

import * as vscode from 'vscode';
import { ModelPortError, modelUserMessage } from '../ai/model/modelPort';
import { apiKeySecretName, baseUrlFault, MAX_ENTRY_NAME_LENGTH, parseModelEntries, type ModelEntry } from '../ai/providers/modelEntries';
import { createProviderModelPort } from '../ai/providers/openAiTransport';
import type { Logger } from '../utils/log';
import { notifyWarning } from '../utils/notifications';
import { rawId, readRawList, rewriteRawList } from './rawSettingList';
import { outcome, runSteps, wizardPrompts, type WizardStep } from './wizardSteps';

export const ADD_AI_MODEL_COMMAND = 'dataLineageViz.addAiModel';
export const MANAGE_AI_MODELS_COMMAND = 'dataLineageViz.manageAiModels';
const EDIT_AI_MODEL_COMMAND = 'dataLineageViz.editAiModel';
const REMOVE_AI_MODEL_COMMAND = 'dataLineageViz.removeAiModel';
const UPDATE_AI_MODEL_KEY_COMMAND = 'dataLineageViz.updateAiModelKey';

const OPEN_SETTINGS_JSON = 'workbench.action.openSettingsJson';
const OPEN_SETTINGS = 'Open settings.json';
const SAVE_AND_OPEN = 'Save and open settings.json';

const WIZARD_TITLE = 'Add AI Model';
const WIZARD_STEPS = 5;
const { askInput, askPick } = wizardPrompts(WIZARD_TITLE, WIZARD_STEPS);

type ApiType = ModelEntry['apiType'];

/** The window and output limit a new entry gets; the user edits them in settings.json. */
const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Sampling written into a new chat-completions entry; the Responses preset has none (reasoning
 * models reject it). */
const SAMPLING_REQUEST_BODY = { temperature: 0.1, top_p: 1 };

/** A provider the wizard starts from: its base URL and wire format, so the user types the rest. */
interface ModelPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly url: string;
  readonly apiType: ApiType;
  /** The `requestBody` a new entry is written with; the user tunes it in the settings JSON. */
  readonly requestBody?: Readonly<Record<string, unknown>>;
  /** A local server that ignores the key. */
  readonly local?: true;
}

const PRESETS: readonly ModelPreset[] = [
  { id: 'openai', label: 'OpenAI', description: 'api.openai.com', url: 'https://api.openai.com/v1/', apiType: 'responses' },
  { id: 'openrouter', label: 'OpenRouter', description: 'openrouter.ai', url: 'https://openrouter.ai/api/v1/', apiType: 'chat-completions', requestBody: SAMPLING_REQUEST_BODY },
  { id: 'ollama', label: 'Ollama', description: 'Local server', url: 'http://localhost:11434/v1/', apiType: 'chat-completions', requestBody: SAMPLING_REQUEST_BODY, local: true },
  { id: 'lmstudio', label: 'LM Studio', description: 'Local server', url: 'http://localhost:1234/v1/', apiType: 'chat-completions', requestBody: SAMPLING_REQUEST_BODY, local: true },
  { id: 'custom', label: 'Other OpenAI-compatible endpoint', description: 'Azure OpenAI, a gateway or any server', url: '', apiType: 'chat-completions', requestBody: SAMPLING_REQUEST_BODY },
];

/** What the connection test asks the endpoint; any reply shows URL, key and model are accepted. */
const TEST_PROMPT = 'Reply with the single word OK.';

interface WizardState {
  preset?: ModelPreset;
  url: string;
  model: string;
  /** The key to test with and save: the saved one of an edited entry until another is typed. */
  key?: string;
  name: string;
}

const AI_CONFIG_SECTION = 'dataLineageViz.ai';
const MODELS_SETTING = 'models';

/** A readable entry id from the display name, made unique among the ids already in the list. */
function newEntryId(name: string, taken: readonly unknown[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'model';
  const used = new Set(taken.map(rawId));
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

const required = (what: string) => (value: string): string | undefined => (value.trim() ? undefined : `${what} is required.`);

/**
 * Sends one short request through the real model port. Resolves `undefined` when the endpoint
 * answered, `'cancelled'` when the user cancelled the progress notification, else the failure text.
 */
function testConnection(entry: ModelEntry, apiKey: string, logger: Logger): Thenable<string | undefined> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${entry.name}…`, cancellable: true }, async (_progress, token) => {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    try {
      await createProviderModelPort(entry, apiKey).completeText({ messages: [modelUserMessage(TEST_PROMPT)], phase: 'connection-test', signal: abort.signal });
      return undefined;
    } catch (err) {
      if (abort.signal.aborted) return 'cancelled';
      logger.error('Test AI model connection', err);
      return err instanceof ModelPortError ? err.message : 'The endpoint could not be reached.';
    }
  });
}

/**
 * Runs the add (or, with `existing`, edit) wizard and saves the result. Five steps (provider
 * preset, base URL, model name, API key, display name), each with a Back button after the first;
 * the entry is test-connected before it is written, which reports a wrong URL, key or model name.
 * A new entry gets the preset's wire format and the default limits; the user tunes them, and adds
 * `requestBody` and the rest, in the settings JSON.
 *
 * @param existing - Entry to edit; its id, every field the wizard does not ask and its saved key
 *   are kept. A changed base URL requires the key again, so a saved key never goes to another host.
 * @returns The saved entry id, or `undefined` when the user cancelled.
 */
async function runModelWizard(secrets: vscode.SecretStorage, logger: Logger, existing?: ModelEntry): Promise<string | undefined> {
  const savedKey = existing ? await secrets.get(apiKeySecretName(existing.id)) : undefined;
  const state: WizardState = existing
    ? { url: existing.url, model: existing.model, name: existing.name, key: savedKey }
    : { url: '', model: '', name: '' };

  const steps: WizardStep[] = [
    {
      applies: () => existing === undefined,
      run: async (n) => {
        const items = PRESETS.map((preset) => ({ label: preset.label, description: preset.description, preset }));
        const answer = await askPick({
          step: n, canGoBack: false, placeholder: 'Provider', items, active: items.find((item) => item.preset === state.preset),
        });
        if (typeof answer === 'object' && answer.preset !== state.preset) {
          state.preset = answer.preset;
          state.url = answer.preset.url;
        }
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const answer = await askInput({
          step: n, canGoBack: existing === undefined, value: state.url,
          prompt: 'Base URL of the OpenAI-compatible API, e.g. https://host/v1/',
          validate: (v) => {
            const fault = v.trim() ? baseUrlFault(v.trim()) : 'is required';
            return fault ? `The base URL ${fault}.` : undefined;
          },
        });
        if (typeof answer === 'string') state.url = answer.trim();
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const answer = await askInput({
          step: n, canGoBack: true, value: state.model, prompt: 'Model name the endpoint expects, e.g. gpt-5', validate: required('A model name'),
        });
        if (typeof answer === 'string') state.model = answer.trim();
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const keepSaved = savedKey !== undefined && existing?.url === state.url;
        const answer = await askInput({
          step: n, canGoBack: true, password: true,
          prompt: keepSaved
            ? 'API key — leave empty to keep the saved key'
            : state.preset?.local ? 'API key — a local server ignores it, enter any text; stored in the VS Code secret store' : 'API key — stored in the VS Code secret store',
          validate: (v) => (v.trim() || keepSaved ? undefined : 'An API key is required.'),
        });
        if (typeof answer === 'string') state.key = answer.trim() || savedKey;
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const answer = await askInput({
          step: n, canGoBack: true, prompt: 'Display name', value: state.name || state.model,
          validate: (v) => (v.trim().length > MAX_ENTRY_NAME_LENGTH ? `A display name has at most ${MAX_ENTRY_NAME_LENGTH} characters.` : required('A display name')(v)),
        });
        if (typeof answer === 'string') state.name = answer.trim();
        return outcome(answer);
      },
    },
  ];

  if (!await runSteps(steps)) return undefined;
  let openSettings = false;
  while (true) {
    const models = readRawList(AI_CONFIG_SECTION, MODELS_SETTING);
    const id = existing?.id ?? newEntryId(state.name, models);
    const stored = models.find((entry) => rawId(entry) === id) as Partial<ModelEntry> | undefined;
    const added = stored ? {} : {
      apiType: state.preset?.apiType ?? 'chat-completions',
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      ...(state.preset?.requestBody ? { requestBody: state.preset.requestBody } : {}),
    };
    const candidate = { ...stored, id, name: state.name, url: state.url, model: state.model, ...added };
    const { entries: [entry], invalid } = parseModelEntries([candidate]);
    if (!entry) throw new Error(`Invalid AI model: ${invalid.flatMap((item) => item.issues).join('; ')}`);
    const failure = await testConnection(entry, state.key!, logger);
    if (failure === 'cancelled') return undefined;
    if (failure) {
      const choice = await vscode.window.showErrorMessage(failure, 'Edit', SAVE_AND_OPEN, 'Cancel');
      if (choice === 'Edit') {
        if (!await runSteps(steps)) return undefined;
        continue;
      }
      if (choice !== SAVE_AND_OPEN) return undefined;
      openSettings = true;
    }
    await rewriteRawList(AI_CONFIG_SECTION, MODELS_SETTING, (entries) => {
      const at = entries.findIndex((item) => rawId(item) === id);
      if (at >= 0) entries[at] = candidate;
      else entries.push(candidate);
      return entries;
    });
    if (state.key !== savedKey) await secrets.store(apiKeySecretName(id), state.key!);
    logger.info('Saved AI model');
    logger.debug(`Saved AI model ${id}`);
    void (openSettings ? vscode.commands.executeCommand(OPEN_SETTINGS_JSON) : offerSettingsJson());
    return id;
  }
}

/** After a save: the limits and any further setting of the entry are tuned in the settings JSON. */
async function offerSettingsJson(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'AI model saved. Tune its limits, requestBody and other settings in dataLineageViz.ai.models.', OPEN_SETTINGS,
  );
  if (choice === OPEN_SETTINGS) await vscode.commands.executeCommand(OPEN_SETTINGS_JSON);
}

/** The valid entry an argument names by id, or the picked one; an invalid entry is warned about. */
async function entryFromArg(arg: unknown, placeholder: string, logger: Logger): Promise<ModelEntry | undefined> {
  const { entries, invalid } = parseModelEntries(vscode.workspace.getConfiguration(AI_CONFIG_SECTION).get(MODELS_SETTING));
  if (invalid.length > 0) {
    notifyWarning(
      logger,
      'Select AI model',
      `Data Lineage: Not offered, invalid in ai.models: ${invalid.map((entry) => entry.name).join(', ')}.`,
      { issues: invalid.flatMap((entry) => entry.issues) },
    );
  }
  const id = typeof arg === 'string' ? arg : (arg as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string') return entries.find((entry) => entry.id === id);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`No AI models are configured. Use "Data Lineage: Add AI Model" first.`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({ label: entry.name, description: entry.id, detail: entry.model, entry })),
    { placeHolder: placeholder, ignoreFocusOut: true, matchOnDescription: true },
  );
  return picked?.entry;
}

/**
 * Registers the five AI model commands. Add and edit run the wizard and return the saved entry id;
 * edit, remove and update-key take an optional entry id and otherwise show a picker. Remove deletes
 * the entry and its key; update-key stores a typed key and returns whether it did. Manage lists the
 * four commands for the chat's "Manage models…" entry.
 */
export function registerAiModelCommands(context: vscode.ExtensionContext, logger: Logger): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(ADD_AI_MODEL_COMMAND, (): Promise<string | undefined> => runModelWizard(context.secrets, logger)),

    vscode.commands.registerCommand(EDIT_AI_MODEL_COMMAND, async (arg?: unknown): Promise<string | undefined> => {
      const existing = await entryFromArg(arg, 'Select a model to edit', logger);
      return existing ? runModelWizard(context.secrets, logger, existing) : undefined;
    }),

    vscode.commands.registerCommand(REMOVE_AI_MODEL_COMMAND, async (arg?: unknown): Promise<void> => {
      const target = await entryFromArg(arg, 'Select a model to remove', logger);
      if (!target) return;
      await rewriteRawList(AI_CONFIG_SECTION, MODELS_SETTING, (entries) => entries.filter((entry) => rawId(entry) !== target.id));
      await context.secrets.delete(apiKeySecretName(target.id));
      logger.info('Removed AI model');
      logger.debug(`Removed AI model ${target.id}`);
    }),

    vscode.commands.registerCommand(UPDATE_AI_MODEL_KEY_COMMAND, async (arg?: unknown): Promise<boolean> => {
      const target = await entryFromArg(arg, 'Select the model the key belongs to', logger);
      if (!target) return false;
      const key = await vscode.window.showInputBox({
        title: `New API key for ${target.name}`,
        prompt: 'Stored in the VS Code secret store, never in settings.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key?.trim()) return false;
      await context.secrets.store(apiKeySecretName(target.id), key.trim());
      logger.info('Saved model API key');
      logger.debug(`Saved model API key for entry ${target.id}`);
      return true;
    }),

    vscode.commands.registerCommand(MANAGE_AI_MODELS_COMMAND, async (): Promise<void> => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Add AI Model', command: ADD_AI_MODEL_COMMAND },
          { label: 'Edit AI Model', command: EDIT_AI_MODEL_COMMAND },
          { label: 'Remove AI Model', command: REMOVE_AI_MODEL_COMMAND },
          { label: 'Update AI Model Key', command: UPDATE_AI_MODEL_KEY_COMMAND },
        ],
        { placeHolder: 'Manage AI models', ignoreFocusOut: true },
      );
      if (picked) await vscode.commands.executeCommand(picked.command);
    }),
  ];
}
