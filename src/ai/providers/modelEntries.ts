/**
 * The `dataLineageViz.ai.models` entry list: one entry per OpenAI-compatible endpoint, or per VS Code
 * language model (`apiType: "vscode-lm"`, a selector instead of a URL and key). Field names follow
 * VS Code's own custom-endpoint model entry. Keys never live in an entry; they sit in SecretStorage
 * under {@link apiKeySecretName}. No `vscode` import, so tests and the headless lane read entries
 * the way the extension does.
 */
import { z } from 'zod';

/** Wire formats of one endpoint: the OpenAI Chat Completions and Responses APIs. */
const MODEL_API_TYPES = ['chat-completions', 'responses'] as const;

/**
 * Request fields the port owns. `requestBody` carries everything else unchanged; a key of this
 * list would replace the conversation, tool offer, stream shape or output cap (`maxOutputTokens`
 * alone sets the cap), so an entry naming one is invalid. `input` is the Responses name of
 * `messages`.
 */
const PORT_OWNED_BODY_KEYS: readonly string[] = [
  'model', 'messages', 'input', 'tools', 'tool_choice', 'stream', 'stream_options',
  'max_tokens', 'max_completion_tokens', 'max_output_tokens',
];

/** Prefix of the id a live VS Code language model is offered under; no entry id may start with it. */
export const LIVE_MODEL_ID_PREFIX = 'lm:';

/** Header names that carry a credential; a key never belongs in a settings file. */
const CREDENTIAL_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;

/** Longest display name of an entry. */
export const MAX_ENTRY_NAME_LENGTH = 256;

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** Why a base URL cannot serve as the OpenAI client's `baseURL`; `undefined` when it can. */
export function baseUrlFault(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) {
    return 'must use https (http only on 127.0.0.1, localhost or [::1])';
  }
  if (url.username || url.password) return 'must not carry credentials';
  if (url.search || url.hash) return 'must be a base URL without query or fragment (the client appends the API path)';
  return undefined;
}

/** Stable identifier, also naming the SecretStorage entry of a key; never the live-model prefix. */
const EntryIdSchema = z.string().min(1).max(128).refine((id) => !id.startsWith(LIVE_MODEL_ID_PREFIX), `id must not start with "${LIVE_MODEL_ID_PREFIX}"`);
const EntryNameSchema = z.string().min(1).max(MAX_ENTRY_NAME_LENGTH);

/** `requestBody` keys the port owns are invalid on either kind of entry. */
function checkRequestBody(entry: { readonly requestBody?: Record<string, unknown> }, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(entry.requestBody ?? {})) {
    if (PORT_OWNED_BODY_KEYS.includes(key)) {
      ctx.addIssue({ code: 'custom', path: ['requestBody', key], message: `requestBody key "${key}" is owned by the port` });
    }
  }
}

/**
 * An OpenAI-compatible endpoint as stored in settings. Strict: an unknown key, `apiKey` above all,
 * is invalid.
 */
const OpenAiEntrySchema = z.strictObject({
  id: EntryIdSchema,
  name: EntryNameSchema,
  /** Base URL of the OpenAI-compatible API, e.g. `https://host/openai/v1/`. */
  url: z.string().min(1),
  model: z.string().min(1),
  apiType: z.enum(MODEL_API_TYPES),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** Efforts the entry offers for selection; absent when it has none. */
  supportsReasoningEffort: z.array(z.string().min(1)).min(1).optional(),
  /** The effort a request sends unless the caller picks another. */
  reasoningEffort: z.string().min(1).optional(),
  /** False for an endpoint that rejects a forced tool choice; the port then sends `auto`. */
  forcedToolChoice: z.boolean().default(true),
  /** Extra request parameters, sent unchanged. */
  requestBody: z.record(z.string().min(1), z.unknown()).optional(),
  /** Extra request headers; never a credential. */
  requestHeaders: z.record(z.string().min(1), z.string()).optional(),
}).superRefine((entry, ctx) => {
  const fault = baseUrlFault(entry.url);
  if (fault) ctx.addIssue({ code: 'custom', path: ['url'], message: `url ${fault}` });
  if (entry.reasoningEffort && entry.supportsReasoningEffort && !entry.supportsReasoningEffort.includes(entry.reasoningEffort)) {
    ctx.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'reasoningEffort is not in supportsReasoningEffort' });
  }
  checkRequestBody(entry, ctx);
  for (const name of Object.keys(entry.requestHeaders ?? {})) {
    if (CREDENTIAL_HEADER.test(name)) {
      ctx.addIssue({ code: 'custom', path: ['requestHeaders', name], message: `requestHeaders "${name}" looks like a credential; keys go through Update AI Model Key` });
    }
  }
});

/**
 * A VS Code language model (`vscode.lm`) as stored in settings: the selector VS Code matches
 * models against, no URL, key or input window (the model reports it). `requestBody` goes to the
 * model as `modelOptions`, `maxOutputTokens` as its `max_tokens`.
 */
const VscodeLmEntrySchema = z.strictObject({
  id: EntryIdSchema,
  name: EntryNameSchema,
  apiType: z.literal('vscode-lm'),
  selector: z.strictObject({
    vendor: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  }),
  maxOutputTokens: z.number().int().positive().optional(),
  requestBody: z.record(z.string().min(1), z.unknown()).optional(),
}).superRefine(checkRequestBody);

const ModelEntrySchema = z.discriminatedUnion('apiType', [OpenAiEntrySchema, VscodeLmEntrySchema]);

/** A valid OpenAI-compatible entry with its defaults applied. */
export type OpenAiModelEntry = z.output<typeof OpenAiEntrySchema>;

/** A valid VS Code language model entry. */
export type VscodeLmModelEntry = z.output<typeof VscodeLmEntrySchema>;

/** A valid model entry with its defaults applied. */
export type ModelEntry = OpenAiModelEntry | VscodeLmModelEntry;

/** An entry that failed validation, named so the user can find it; `issues` never echo a value. */
interface InvalidModelEntry {
  readonly name: string;
  readonly issues: readonly string[];
}

/** Result of reading the list: the entries to offer and the ones named as invalid. */
export interface ModelEntryRead {
  readonly entries: readonly ModelEntry[];
  readonly invalid: readonly InvalidModelEntry[];
}

/** SecretStorage key of an entry's API key. */
export function apiKeySecretName(entryId: string): string {
  return `dataLineageViz.ai.apiKey.${entryId}`;
}

/** Reads the raw `ai.models` value: valid entries are offered, each invalid one is named. */
export function parseModelEntries(raw: unknown): ModelEntryRead {
  if (raw === undefined) return { entries: [], invalid: [] };
  if (!Array.isArray(raw)) return { entries: [], invalid: [{ name: 'ai.models', issues: ['must be a list of entries'] }] };
  const entries: ModelEntry[] = [];
  const invalid: InvalidModelEntry[] = [];
  raw.forEach((item: unknown, index) => {
    const idValue = (item as { id?: unknown } | null)?.id;
    const name = typeof idValue === 'string' && idValue ? idValue : `entry ${index + 1}`;
    const parsed = ModelEntrySchema.safeParse(item);
    if (!parsed.success) {
      invalid.push({ name, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`) });
    } else if (entries.some((e) => e.id === parsed.data.id)) {
      invalid.push({ name, issues: ['id: duplicate of an earlier entry'] });
    } else {
      entries.push(parsed.data);
    }
  });
  return { entries, invalid };
}
