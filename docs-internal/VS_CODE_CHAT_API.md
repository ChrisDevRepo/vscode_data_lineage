# VS Code Chat API — How `@lineage` Uses It

The `@lineage` chat participant is built on VS Code's Chat / Language Model / Language Model Tools extension APIs — the same in-process transport any Copilot Chat participant uses. This doc is the ground-truth reference: every API surface we touch, quoted from the official guide, cross-referenced to the file and line where we use it.

When prompt changes or AI-instruction updates drift toward a generic "LLM API" mental model (bending history from the prompt, re-implementing tool gating, inventing alternative transports), read this doc first. If the behavior is already enforced by the API, the prompt-level change is a band-aid.

---

## Capabilities cheatsheet — what we CAN code as a chat participant

Everything below is grounded in https://code.visualstudio.com/api/extension-guides/ai/chat. If you want a UI interaction that is not in this table, it's not possible through the chat-participant surface.

### UI primitives — inline in the response (`ChatResponseStream`)

| Primitive | Method | User sees | On click / interaction |
|---|---|---|---|
| **Markdown prose** | `stream.markdown(text)` | Rendered markdown (headings, bold, code, tables, LaTeX). External images/links need the trusted-domain allowlist. | Inert — just text. |
| **Code block with copy/apply** | `stream.markdown('```lang\ncode\n```')` | Syntax-highlighted block with copy and apply-to-file buttons. | Copy copies to clipboard; apply inserts into the active editor. |
| **Action button** (inline) | `stream.button({ command, title, arguments? })` | Clickable button rendered in the response body. | Executes the named VS Code command with `arguments`. Fire-and-forget — no return to the handler. |
| **Command link** (inline) | `stream.markdown(new MarkdownString('[label](command:id)')); ms.isTrusted = { enabledCommands: ['id'] };` | Underlined link mid-prose. | Same as button — executes the command. Missing `isTrusted` allowlist = dead link. |
| **Reference chip** | `stream.reference(Uri \| Location)` | Entry in the "References" list under the response. | Opens the referenced file/location. |
| **Inline anchor** | `stream.anchor(Uri \| Location, title?)` | Clickable symbol/file link in prose. | Navigates to the target. |
| **File-tree preview** | `stream.filetree(ChatResponseFileTree[], baseUri)` | Expandable tree of files/folders. | Preview only — no editing. |
| **Progress message** | `stream.progress(text)` | Transient "working on it" line. | Cleared when the next content arrives. |
| **Confirmation (2-button)** | `stream.confirmation({title, message, data, buttons?})` | Accept/Reject dialog. Deliberately unused by us (all operations are read-only). | Yes/no; max 2 buttons. No multi-option variant. |

### UI primitives — below the response (`ChatFollowupProvider`)

| Primitive | Method | User sees | On click |
|---|---|---|---|
| **Suggestion chip** | `participant.followupProvider.provideFollowups(result)` returning `ChatFollowup[]` | Suggestion pills below the response (label text). | Submits `prompt` as a new chat turn. If `command` is set, routes as `@participant /command prompt`. |

`ChatFollowup` shape:
```ts
{ prompt: string; label?: string; command?: string; participant?: string; }
```

### Slash commands

- Declared in `package.json` → `chatParticipants[].commands[] = { name, description }`.
- At runtime: `request.command === 'name'` when the user typed `/name`.
- Commands rewrite the user prompt only — they do not change the tool set or inject state.

### Auto-routing (disambiguation)

- Declared in `package.json` → `chatParticipants[].disambiguation[] = { category, description, examples[] }`.
- Lets VS Code route prompts to the participant even without `@name`.
- Built-in participants (e.g. `@workspace`) take precedence.

### Feedback

- `participant.onDidReceiveFeedback((fb: ChatResultFeedback) => …)` — fires when user clicks 👍/👎 on a response.
- `fb.kind` is `Helpful | Unhelpful`.
- Canonical success metric: `unhelpful_feedback / total_requests`.

### ChatResult metadata (round-trip state)

- The handler returns `{ metadata?: Record<string, unknown> }`.
- The same metadata is passed to `provideFollowups(result, …)` on the next render.
- Use it to pass contextual state between the handler and the followup provider (we pass `lastTools`, `deferredQuestionCount`).

### `ChatFollowupProvider` / `ChatFollowup` — suggestion chips below the response

Source: [Chat guide — "Register follow-up requests"](https://code.visualstudio.com/api/extension-guides/ai/chat#register-follow-up-requests), [`ChatFollowupProvider`](https://code.visualstudio.com/api/references/vscode-api#ChatFollowupProvider), [`ChatFollowup`](https://code.visualstudio.com/api/references/vscode-api#ChatFollowup).

```ts
participant.followupProvider = {
  provideFollowups(
    result: vscode.ChatResult,
    context: vscode.ChatContext,
    token: vscode.CancellationToken
  ): vscode.ChatFollowup[] {
    return [{ prompt: 'let us play', label: 'Play with the cat' }];
  }
};
```

`ChatFollowup` shape:
```ts
interface ChatFollowup {
  prompt: string;          // Text submitted as the next user message when the chip is clicked.
  label?: string;          // Display text shown in the chip. Falls back to `prompt` when absent.
  command?: string;        // Slash-command name (NOT a VS Code command ID). When set, the turn
                           //   fires as `@participant /command prompt`. Routes to
                           //   `request.command === command` inside the handler.
  participant?: string;    // Target participant id. Defaults to the current participant.
}
```

**Critical distinction — `ChatFollowup.command` vs `stream.button({command})` vs command-link markdown:**

| Surface | `command` field meaning | On click |
|---|---|---|
| `ChatFollowup.command` | **Slash-command name** (e.g. `'followup'`). Routes to `request.command === 'followup'` in the handler. | Submits a new chat turn: `@lineage /followup <prompt>`. |
| `stream.button({command})` | **VS Code command ID** (e.g. `'dataLineageViz.showDeferredQuestions'`). Direct command dispatch. | Executes the named VS Code command with `arguments`. Fire-and-forget — no return to chat. |
| `stream.markdown(new MarkdownString('[text](command:id)'))` with `isTrusted` | **VS Code command ID** (same as button). | Same as button but rendered inline mid-prose. |

**Consequence for BUG-006:** `ChatFollowup` chips cannot open a QuickPick directly — clicking a chip starts a *new chat turn*. To open the `showDeferredQuestions` QuickPick, use `stream.button({command: 'dataLineageViz.showDeferredQuestions', arguments: [entries]})` inside the response body, or a trusted command-link in `stream.markdown()`. The followup chip is the wrong mechanism for QuickPick invocation.

**MS tip (verbatim):** *"Follow-ups should be written as questions or directions, not just concise commands."*

### Lifecycle primitives

- `participant.iconPath: Uri` — custom avatar.
- `participant.dispose()` — remove registration.
- One participant per extension is the recommended pattern.

---

## What we CANNOT do

Anything that would require user input mid-stream or interactive picking within the response bubble.

| Want | Reality |
|---|---|
| QuickPick (multi-select modal inside chat) | No `stream.quickPick`. Only accessible from a dispatched VS Code command (opens the OS-level QuickPick window). |
| Mid-turn pause for user input | Turns are strictly one-shot. The handler runs to completion; the user's next message is a new turn. |
| `stream.confirmation` with N options | Maximum 2 buttons (Accept/Reject). No custom multi-option dialogs. |
| Inject a system-role message | VS Code LM API exposes `User` and `Assistant` only. Our "system prompt" is a User message at position 0. Copilot may add its own invisible framing. |
| Force history injection | `ChatContext.history` is available but NOT auto-injected into `sendRequest`. The participant decides what to replay. |
| Cross-turn persistent UI state in the response | Each `ChatResponseStream` dies at turn end. Persistent state must live in session objects (`sess.memory`, `sess.resultGraph`) and be re-read on the next turn. |
| Re-open an existing response to add content | Once the turn completes, the response is frozen. Users can scroll back but not re-trigger. |

### Decision tree — picking the right primitive

```
Is the UI element an immediate action on a target the user can click?
├── Action runs a VS Code command    → stream.button (bold) or command-link markdown (subtle)
├── Action opens a file/symbol       → stream.anchor or stream.reference
└── Action is "start a new chat turn" → ChatFollowup chip (set `prompt` + optional `command`)

Is the UI a passive artifact?
├── Prose, code, tables, math → stream.markdown
├── Folder structure          → stream.filetree
└── Status during work        → stream.progress (transient)

Need N-option selection?
├── ≤2 options (destructive action) → stream.confirmation
├── 3–10 options (common follow-ups) → ChatFollowup chips, one per option
└── >10 options or needing filtering → stream.button → command opens vscode.window.showQuickPick
```

---

## Source references

**Tier 1 — official VS Code API guides (authoritative):**

- [AI extensibility overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview) — decision map across the four AI extension points (Language Model Tool, MCP, Chat Participant, Language Model API)
- [Chat participant guide](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [Chat participant tutorial](https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial) — the official 8-step walkthrough
- [Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [Language Model Tools guide](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [Language Model Chat Provider API (BYOK)](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) — how third-party models register (we *consume*, we do not provide)
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api) — namespace anchors `#chat`, `#lm`
- [Use tools in chat (user docs)](https://code.visualstudio.com/docs/copilot/chat/chat-tools) — the Copilot UX around our `languageModelTools` contributions

**Tier 2 — canonical source code:**

- [microsoft/vscode `vscode.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts) — authoritative TypeScript signatures
- [vscode-extension-samples/chat-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample) — three reference patterns:
  - [`simple.ts`](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/src/simple.ts) — minimal handler
  - [`chatUtilsSample.ts`](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/src/chatUtilsSample.ts) — `@vscode/chat-extension-utils` wrapper
  - [`toolParticipant.ts`](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/src/toolParticipant.ts) — manual tool loop with `@vscode/prompt-tsx`
- [microsoft/vscode-chat-extension-utils](https://github.com/microsoft/vscode-chat-extension-utils) — exports `sendChatParticipantRequest`, `ToolCall`, `FilesContext`, `History`, `Tag`, `FileTree`
- [microsoft/vscode-prompt-tsx](https://github.com/microsoft/vscode-prompt-tsx) — token-budget-aware prompt composition

**Tier 3 — historical anchors:**

- [v1.95 release notes (October 2024)](https://code.visualstudio.com/updates/v1_95) — **Chat Participant Detection API** and **Language Model Tools API** both finalized. This is the stable baseline the code targets.
- [BYOK blog (October 2025)](https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key) — context on `LanguageModelChatProvider`

**Source-hygiene rule:** claims that affect code behavior cite Tier 1 or Tier 2. Tier 3 is for narrative and dates.

---

## 1. Chat participant lifecycle

A chat participant is a specialized assistant users invoke with `@name`. It owns the full conversation, unlike a Language Model Tool which is one orchestration step. Source: [Chat guide — "Core Benefits"](https://code.visualstudio.com/api/extension-guides/ai/chat).

### Manifest (`contributes.chatParticipants`)

Per the [Chat guide — "Register in package.json"](https://code.visualstudio.com/api/extension-guides/ai/chat):

| Field | Purpose |
|---|---|
| `id` | Globally unique, format `extension-name.unique-id` |
| `name` | `@`-mention name — alphanumeric, underscores, hyphens; lowercase recommended |
| `fullName` | Title-case display name |
| `description` | Placeholder text in the chat input |
| `isSticky` | If `true`, the participant stays selected for follow-up turns |
| `commands[]` | Slash commands (`name` lowerCamelCase + sentence-case `description`) |
| `disambiguation[]` | Optional auto-routing — `category` + `description` + `examples[]` (v1.95+) |

### Runtime registration

```ts
vscode.chat.createChatParticipant(id: string, handler: ChatRequestHandler): ChatParticipant
```

The returned `ChatParticipant` has three slots worth wiring:

- `iconPath` — participant avatar
- `followupProvider` — post-response suggestion chips
- `onDidReceiveFeedback` — Helpful/Unhelpful feedback for `unhelpful_feedback / total` metrics

### Our implementation

- Manifest: [package.json:456-487](../package.json#L456-L487) — participant id `dataLineageViz.lineage`, `isSticky: true`, commands `/trace` and `/search`, disambiguation category `lineage` with 5 examples.
- Registration: [src/ai/lineageParticipant.ts:77-99](../src/ai/lineageParticipant.ts#L77-L99) — `createChatParticipant('dataLineageViz.lineage', handleChatRequest)`, followup provider keyed on `lastTools` metadata, feedback logger.

---

## 2. `ChatRequest` — what the handler receives

Handler signature, from the [Chat guide — "Implement Request Handler"](https://code.visualstudio.com/api/extension-guides/ai/chat):

```ts
type ChatRequestHandler = (
  request: ChatRequest,
  context: ChatContext,
  stream: ChatResponseStream,
  token: CancellationToken
) => ProviderResult<ChatResult | void>
```

### `ChatRequest` fields

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` | Raw user text (after VS Code strips `@participant` and slash-command prefix) |
| `command` | `string \| undefined` | Slash command id (e.g. `trace`) |
| `references` | `readonly ChatPromptReference[]` | User-attached context (file, selection, etc.) |
| `toolReferences` | `readonly ChatLanguageModelToolReference[]` | `#tool` mentions the user typed |
| `toolInvocationToken` | `ChatParticipantToolToken` | **Opaque token — must be forwarded to `vscode.lm.invokeTool` if the tool should show in the Copilot UI**. Source: [Tools guide — "Tool invocation"](https://code.visualstudio.com/api/extension-guides/ai/tools) |
| `model` | `LanguageModelChat` | Pre-selected by Copilot Chat. We do **not** call `selectChatModels`, because consent is already granted for `request.model`. |

### Our implementation

- Full handler: [src/ai/lineageParticipant.ts:116-579](../src/ai/lineageParticipant.ts#L116-L579).
- `request.command` routing: [src/ai/lineageParticipant.ts:157-162](../src/ai/lineageParticipant.ts#L157-L162) — `/trace` → `buildTracePrompt` ([src/ai/prompts.ts:74-76](../src/ai/prompts.ts#L74-L76)); `/search` → `buildSearchPrompt` ([src/ai/prompts.ts:84-86](../src/ai/prompts.ts#L84-L86)).
- `request.toolInvocationToken`: [src/ai/lineageParticipant.ts:375-382](../src/ai/lineageParticipant.ts#L375-L382) — forwarded to `vscode.lm.invokeTool` only when `dataLineageViz.ai.showToolInvocations` is `true`; off by default so the built-in chat copy captures only AI prose, not tool JSON.
- `request.model.maxInputTokens` / `.countTokens()`: [src/ai/lineageParticipant.ts:245-261](../src/ai/lineageParticipant.ts#L245-L261) — driven by `CONTEXT_PRESSURE_THRESHOLD`; evict oldest history turn + inject `buildEvictionStub()` when over budget.

---

## 3. `ChatContext.history` — multi-turn memory

Per the [Chat guide — "Chat Message History"](https://code.visualstudio.com/api/extension-guides/ai/chat):

> History excluded from prompts by default; participant decides whether to add as context to language model.

Shape:

```ts
interface ChatContext {
  readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
}
```

VS Code filters history to turns that targeted *this* participant. History is **not** auto-injected into `sendRequest` — the participant must replay it if it wants continuity.

### Our implementation

- Reconstruction: [src/ai/lineageParticipant.ts:164-201](../src/ai/lineageParticipant.ts#L164-L201) — iterate `chatContext.history`, for each `ChatResponseTurn` reconstruct the assistant message (text + `LanguageModelToolCallPart[]`) followed by the user-role `LanguageModelToolResultPart[]` message. Before pushing, every result text is run through `compactStaleHopResult` / `compactNoiseResult` ([src/ai/historyManager.ts](../src/ai/historyManager.ts)) so stale hop JSON doesn't accumulate.
- New-chat detection: [src/ai/lineageParticipant.ts:138-150](../src/ai/lineageParticipant.ts#L138-L150) — `history.length === 0` ⇒ rotate `sess.id`, reset exploration state; the graph result is grafted forward if it's less than 5 minutes old.
- Sliding-memory wipe after every successful `submit_findings` hop: [src/ai/lineageParticipant.ts:531-543](../src/ai/lineageParticipant.ts#L531-L543) — `messages.length = 0`, re-seed with system + user prompt + nav prompt + last assistant + last result. This is how we stay inside `maxInputTokens` across deep explorations without losing continuity. History preservation on error so the AI can self-correct ([src/ai/lineageParticipant.ts:540-542](../src/ai/lineageParticipant.ts#L540-L542)).

---

## 4. `ChatResponseStream` — rendering back to the user

Per the [Chat guide — "Response Stream Output Types"](https://code.visualstudio.com/api/extension-guides/ai/chat):

| Method | Signature | What it emits |
|---|---|---|
| `markdown(value)` | `string \| MarkdownString` | Prose, code fences, inline math, links |
| `progress(message)` | `string` | Transient "working on it" line |
| `button({ command, title, arguments? })` | — | Action chip |
| `reference(target)` | `Uri \| Location \| { variableName, value? }` | Chip in the "Used N references" bar |
| `anchor(target, title?)` | `Uri \| Location` | Inline symbol link |
| `filetree(tree, baseUri)` | `ChatResponseFileTree[]`, `Uri` | Folder preview |
| `confirmation(title, message, data, buttons?)` | — | Gated destructive action |

Command URIs in Markdown require trust-marking:

```ts
const s = new vscode.MarkdownString(`[Click](command:${CMD})`);
s.isTrusted = { enabledCommands: [CMD] };
stream.markdown(s);
```

### Our implementation

- **Stream lifecycle wrapper**: [src/ai/chatResponseWriter.ts](../src/ai/chatResponseWriter.ts) — `ChatResponseWriter` owns the `ChatResponseStream` + `CancellationToken` pair. Every `stream.markdown / progress / button` in `lineageParticipant.ts` routes through it. Tracks a discriminated `open | cancelled | closed` status; writes become silent no-ops after either transition. Cancellation is polled via `token.isCancellationRequested` at each write + at FSM boundaries (top of hop, inside LM `for await`). Observed `"Response stream has been closed"` throws flip status to `closed` instead of propagating — VS Code silently tears down the stream in some edge cases (host reload) without cancelling the token, and the writer must absorb this. Non-stream-closed errors rethrow unchanged. One `info` log on cancel, one `warn` on observed close — never per-write.
- `writer.markdown`: call sites throughout [src/ai/lineageParticipant.ts](../src/ai/lineageParticipant.ts) — surfaces assistant text parts during streaming (active-phase prose is *suppressed* so hop narratives don't duplicate).
- `writer.progress`: hop-aware label `Hop N/M — analyzing <node>…` for `submit_findings`; deduped via `lastProgressLine`.
- `writer.button`: "Show in Graph" inside the `dispatchExit('final_answer')` case, dispatches `dataLineageViz.aiCreateView`.
- **Cancellation as a typed FSM exit**: `HopLoopExit` (in [src/ai/sessionPhase.ts](../src/ai/sessionPhase.ts)) has a first-class `kind: 'cancelled'` variant — `dispatchExit` handles user-cancel in its own case branch (`sess.enterIdle()`, no stream write — stream is already closed, VS Code renders its own "Cancelled" affordance). Rationale: per [.claude/rules/code-quality.md](../.claude/rules/code-quality.md) §"State Management", cancellation is a discriminated exit, not a caught exception — adding a variant forces every `dispatchExit` switch site to cover it (`tsc` exhaustiveness).

**Not adopted** (available, deliberately unused):

| Method | Why skipped |
|---|---|
| `filetree` | No file-tree output model in lineage |
| `anchor` | No symbol-in-editor linking — graph lives in a webview |
| `reference` | Nodes are referenced by DOM id in the graph, not by `vscode.Uri` |
| `confirmation` | All side-effects are read-only on a loaded model |

### Trust-on-resume: pattern for multi-turn consent gates (2026-04-18 iteration 3)

Chat turns are one-shot (§15). A consent gate that needs user input spans two turns: turn N emits the envelope, turn N+1 resolves it. State coherence across the boundary is preserved by **priming the engine at envelope-emission time** and embedding the necessary resume context in the envelope payload.

Concretely for our `confirm_sm_start` gate:

1. Tool calls `engine.init()` + `engine.getHopContext()` — engine advances to `awaiting_findings`; `currentFocusNodeId` is set.
2. Tool returns `{error: 'action_required', gate: 'confirm_sm_start', ..., hop_context}`. AI sees `hop_context` in its history.
3. Turn ends. User replies `yes` on turn N+1. Participant clears gate state and transitions to ACTIVE.
4. AI picks `focus_node_id` from `hop_context` in history and calls `submit_findings`. Engine accepts — it was primed in step 1.

Pattern: **no participant→engine coupling on resume.** Trust the AI to pick the right focus from its reconstructed history (§3). If user declines/redirects, `sess.resetExploration()` discards the engine; pre-consent mutation is never observed. This mirrors Orchestrator-Workers (Anthropic, *Building Effective Agents*, Dec 2024) where the worker's input context carries everything the worker needs.

Canonical implementation: `src/ai/toolProvider.ts` `lineage_start_exploration` — the `!useInline && sess.phase.kind === 'idle'` branch.

### SM closed-loop contract (2026-04-18)

After `confirm_sm_start` is approved, SM sessions run as a closed loop — no mid-session consent gates. Out-of-approved-scope routes are deferred by the engine (typed `DeferredQuestion[]` bucket) and surfaced at synthesis as an "Unanswered (out of approved scope)" tail-section of the report. The optional gate literal `confirm_scope_extension` is reserved in `PendingGateSchema` for future one-click re-spawn flows (the current implementation streams a post-synthesis summary instead).

`schema_out_of_filter` / `depth_cap_exceeded` / `schema_and_depth` gates remain live **only in inline mode**. The participant's gate-resume handler carries an inline-only comment; SM sessions never reach that branch because the engine's route validator branches on `_inlineMode` before the gate-envelope block at [smBase.ts:526](../src/ai/smBase.ts#L526). Full details in `docs-internal/AI_IMPLEMENTATION.md` §3.4.

### Button feasibility for consent gates (2026-04-18)

Consent gates (`confirm_sm_start`, `schema_out_of_filter`, `depth_cap_exceeded`, `schema_and_depth`, `confirm_scope_extension`) pause the chat turn and wait for the user's yes / no / redirect reply. A recurring question: could these be rendered as chat buttons instead of text-reply?

**No — not with the current VS Code Chat API.** Evidence, with section refs:

| API surface | What it does | Why it can't carry a reply here |
|---|---|---|
| `stream.button({command, title, arguments?})` (§4) | Renders action chip that **dispatches a VS Code command** | Command dispatch is fire-and-forget — no back-channel into the running `handleChatRequest`. Button would have to dispatch a command that re-invokes the chat participant via a synthetic message. |
| `stream.confirmation({title, message, data, buttons?})` (§4) | Renders Accept/Reject for destructive actions | Explicitly listed as **deliberately unused** in the "Not adopted" table above. Only 2 branches — no room for a `redirect` branch (the user can type "actually, trace customer instead"). |
| `stream.choice` / `stream.quickPick` | — | **Do not exist** in the chat API. |
| Mid-turn pause primitive | — | **Does not exist** (§15). Turns are strictly one-shot; handler completes, user's next message is a new turn. |

**The gate protocol is still button-ready for a future refactor:** `sess.phase.awaiting_gate.gate` + `.gate.classes` is all a hypothetical `dataLineageViz.resumeExploration` command would need. Adding buttons later is additive — no engine change required.

**Why this is the right answer, not a limitation:** redirect (a free-form new question) is a legitimate third branch users want. Button UI inherently can't carry arbitrary text. Text-reply gives the user strictly more expressive power than a 2-button modal.

---

## 5. The Language Model API (`vscode.lm`)

Source: [Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model).

### Key functions

```ts
namespace lm {
  function selectChatModels(selector?: LanguageModelChatSelector): Thenable<LanguageModelChat[]>;
  function registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable;
  function invokeTool(
    name: string,
    options: LanguageModelToolInvocationOptions<object>,
    token?: CancellationToken
  ): Thenable<LanguageModelToolResult>;
  const tools: readonly LanguageModelToolInformation[];
  const onDidChangeChatModels: Event<void>;
}
```

### `LanguageModelChat`

```ts
interface LanguageModelChat {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  sendRequest(
    messages: LanguageModelChatMessage[],
    options?: LanguageModelChatRequestOptions,
    token?: CancellationToken
  ): Thenable<LanguageModelChatResponse>;
  countTokens(text: string | LanguageModelChatMessage, token?: CancellationToken): Thenable<number>;
}
```

### `LanguageModelChatMessage`

Two roles. System is **not** a first-class role — the "system prompt" is a `User` message at the head of `messages[]`. This is the documented pattern, not a workaround. Source: [LM guide — "Message Types"](https://code.visualstudio.com/api/extension-guides/ai/language-model).

```ts
class LanguageModelChatMessage {
  static User(content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart>): LanguageModelChatMessage;
  static Assistant(content: string | Array<LanguageModelTextPart | LanguageModelToolCallPart>): LanguageModelChatMessage;
  constructor(role: LanguageModelChatMessageRole, content: ...);
  role: LanguageModelChatMessageRole; // User | Assistant
  content: Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart>;
}
```

### `LanguageModelChatResponse`

Streaming, always. Never buffer.

```ts
interface LanguageModelChatResponse {
  text: AsyncIterable<string>;                    // convenience — text only
  stream: AsyncIterable<LanguageModelTextPart     // tool-aware iteration
                      | LanguageModelToolCallPart
                      | unknown>;
}
```

### `LanguageModelChatRequestOptions`

```ts
interface LanguageModelChatRequestOptions {
  justification?: string;                // shown in consent dialog
  modelOptions?: { [key: string]: any }; // model-specific tuning
  tools?: LanguageModelChatTool[];       // tools the model may call
  toolMode?: LanguageModelChatToolMode;  // Auto | Required
}

enum LanguageModelChatToolMode { Auto = 1, Required = 2 }
```

`Required` forces the model to emit a tool call (no free-form text). Some models only honor `Required` when `tools[]` has a single entry.

### `LanguageModelError`

Catch and branch on `.code` (`NoPermissions`, `Blocked`, `NotFound`) and `.cause` (e.g. off-topic). Source: [LM guide — "Error Handling"](https://code.visualstudio.com/api/extension-guides/ai/language-model).

### Our implementation

- No explicit `selectChatModels` — we ride on `request.model` because Copilot Chat already selected it and negotiated consent: [src/ai/lineageParticipant.ts:123-124](../src/ai/lineageParticipant.ts#L123-L124).
- System-as-User head message: [src/ai/lineageParticipant.ts:263](../src/ai/lineageParticipant.ts#L263) — `[LanguageModelChatMessage.User(systemPrompt), ...historyMessages, LanguageModelChatMessage.User(effectivePrompt)]`.
- `sendRequest` with tool-mode switching: [src/ai/lineageParticipant.ts:302-309](../src/ai/lineageParticipant.ts#L302-L309) — `Required` in ACTIVE phase to force `submit_findings`, `Auto` in DISCOVER and SYNTHESIS so the model can produce trivial chat answers or final prose.
- Stream iteration + part dispatch: [src/ai/lineageParticipant.ts:316-327](../src/ai/lineageParticipant.ts#L316-L327) — branches on `ChatResponseMarkdownPart` (compatibility), `LanguageModelTextPart`, and `LanguageModelToolCallPart`.
- `countTokens` usage: input-tokens eviction ([lineageParticipant.ts:249-254](../src/ai/lineageParticipant.ts#L249-L254)), per-round telemetry ([lineageParticipant.ts:295-297](../src/ai/lineageParticipant.ts#L295-L297)), output-tokens telemetry ([lineageParticipant.ts:331-332](../src/ai/lineageParticipant.ts#L331-L332)).
- Tool-call extraction helper: [src/ai/lineageParticipant.ts:26-32](../src/ai/lineageParticipant.ts#L26-L32) — `extractToolCallFields`.
- Per-round error handling: [src/ai/lineageParticipant.ts:386-390](../src/ai/lineageParticipant.ts#L386-L390) — every tool exception wrapped into a `LanguageModelTextPart` with `{ error, message }` so the model can read and recover.

---

## 6. Language Model Tools API

Source: [Language Model Tools guide](https://code.visualstudio.com/api/extension-guides/ai/tools).

### Manifest (`contributes.languageModelTools`)

```jsonc
{
  "name": "verb_noun",                   // matches registerTool() id
  "displayName": "User-friendly name",
  "modelDescription": "When the LM should pick this tool, with constraints",
  "userDescription": "What this tool does, in human terms",
  "toolReferenceName": "refName",        // for `#refName` in chat
  "canBeReferencedInPrompt": true,       // enables agent mode + `#` refs
  "icon": "$(icon-id)",
  "tags": ["category"],
  "inputSchema": { "type": "object", "properties": { }, "required": [] },
  "when": "context-key-expression"
}
```

### `LanguageModelTool<T>` interface

```ts
interface LanguageModelTool<T> {
  prepareInvocation?(
    options: LanguageModelToolInvocationPrepareOptions<T>,
    token: CancellationToken
  ): ProviderResult<{
    invocationMessage?: string;
    confirmationMessages?: { title: string; message: string | MarkdownString };
  }>;
  invoke(
    options: LanguageModelToolInvocationOptions<T>,
    token: CancellationToken
  ): ProviderResult<LanguageModelToolResult>;
}

class LanguageModelToolResult {
  constructor(content: Array<LanguageModelTextPart | LanguageModelPromptTsxPart>);
}
```

### The tool-calling loop

From [Tools guide — "Tool-Calling Flow"](https://code.visualstudio.com/api/extension-guides/ai/tools):

1. Copilot sends prompt + context + tool descriptions to the LM.
2. LM returns a response that may include `LanguageModelToolCallPart`s.
3. Participant calls `vscode.lm.invokeTool(name, { input, toolInvocationToken }, token)` for each.
4. Results are wrapped in `LanguageModelToolResultPart(callId, content)` and pushed into `messages` as a User-role message.
5. Participant re-calls `sendRequest`. Loop exits when the LM returns text only.

### Our implementation

All 10 tools are registered in [src/ai/toolProvider.ts](../src/ai/toolProvider.ts). Shared helpers:

- `toolResult(data)`: [src/ai/toolProvider.ts:57-59](../src/ai/toolProvider.ts#L57-L59) — wraps any object as `new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(data))])`. JSON-in-one-TextPart is our convention — results are data for the LM, not prose for the user.
- `logAndReturn(name, data, input?)`: [src/ai/toolProvider.ts:61-78](../src/ai/toolProvider.ts#L61-L78) — appends to `sess.hopLog`, logs debug/warn based on `isError` detection.
- `toolError(name, err)`: [src/ai/toolProvider.ts:80-84](../src/ai/toolProvider.ts#L80-L84) — unhandled exceptions become `{ error: 'internal_error', tool, message }` results.

### Tool registry

| Tool | Registration | Manifest |
|---|---|---|
| `lineage_get_context` | [toolProvider.ts:90-100](../src/ai/toolProvider.ts#L90-L100) | [package.json:489-506](../package.json#L489-L506) |
| `lineage_search_objects` | [toolProvider.ts:102-113](../src/ai/toolProvider.ts#L102-L113) | [package.json:507-562](../package.json#L507-L562) |
| `lineage_get_object_detail` | [toolProvider.ts:270-281](../src/ai/toolProvider.ts#L270-L281) | [package.json:562-588](../package.json#L562-L588) |
| `lineage_run_bfs_trace` | [toolProvider.ts:258-268](../src/ai/toolProvider.ts#L258-L268) | [package.json:588-650](../package.json#L588-L650) |
| `lineage_run_analysis` | [toolProvider.ts:283-298](../src/ai/toolProvider.ts#L283-L298) | [package.json:650-691](../package.json#L650-L691) |
| `lineage_search_ddl` | [toolProvider.ts:300-311](../src/ai/toolProvider.ts#L300-L311) | [package.json:691-729](../package.json#L691-L729) |
| `lineage_enrich_view` | [toolProvider.ts:245-256](../src/ai/toolProvider.ts#L245-L256) | [package.json:729-879](../package.json#L729-L879) |
| `lineage_get_ddl_batch` | [toolProvider.ts:313-323](../src/ai/toolProvider.ts#L313-L323) | [package.json:879-907](../package.json#L879-L907) |
| `lineage_start_exploration` | [toolProvider.ts:115-200](../src/ai/toolProvider.ts#L115-L200) | [package.json:907-968](../package.json#L907-L968) |
| `lineage_submit_findings` | [toolProvider.ts:202-243](../src/ai/toolProvider.ts#L202-L243) | [package.json:968-1054](../package.json#L968-L1054) |

All tools share:
- `canBeReferencedInPrompt: true`
- `tags` includes `"lineage"` (used by the participant to filter the active toolset: [lineageParticipant.ts:155](../src/ai/lineageParticipant.ts#L155))
- `when: "dataLineageViz.modelLoaded"` — context key set in [src/panelProvider.ts:87](../src/panelProvider.ts#L87) and [src/bridge/messageHandlers.ts:107](../src/bridge/messageHandlers.ts#L107)

### Tool invocation from the handler

[src/ai/lineageParticipant.ts:374-390](../src/ai/lineageParticipant.ts#L374-L390):

```ts
const result = await vscode.lm.invokeTool(
  f.name,
  {
    input: f.input,
    toolInvocationToken: showToolInvocations ? request.toolInvocationToken : undefined,
  },
  token
);
resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, result.content));
```

Surrounding mechanics:

- Tool-call cache / dedup: [lineageParticipant.ts:350-354](../src/ai/lineageParticipant.ts#L350-L354) — same `name::input` returns `{ _dedup: true }` instead of re-running.
- Repeat-rejection guard: [lineageParticipant.ts:397-427](../src/ai/lineageParticipant.ts#L397-L427) — 3 consecutive identical failures abort the run.
- Action-required gate: [lineageParticipant.ts:429-444](../src/ai/lineageParticipant.ts#L429-L444) — a tool result flagged with `action_required: 'analyze_and_respond'` stops further tool calls until the LM produces prose.

---

## 7. Slash commands

Naming (from the [Chat guide — "Naming Conventions"](https://code.visualstudio.com/api/extension-guides/ai/chat)):
- `name`: lowerCamelCase, obvious purpose — e.g. `trace`, `explain`, `runCommand`
- `description`: sentence case, no terminal punctuation

### Our implementation

- Manifest: [package.json:465-471](../package.json#L465-L471) — `trace`, `search`.
- Routing: [src/ai/lineageParticipant.ts:157-162](../src/ai/lineageParticipant.ts#L157-L162) — reshape `request.prompt` via `buildTracePrompt` / `buildSearchPrompt` ([src/ai/prompts.ts:74-86](../src/ai/prompts.ts#L74-L86)).

---

## 8. Followups and feedback

```ts
interface ChatFollowupProvider {
  provideFollowups(
    result: ChatResult,
    context: ChatContext,
    token: CancellationToken
  ): ProviderResult<ChatFollowup[]>;
}

interface ChatFollowup {
  prompt: string;
  label?: string;
  command?: string;
  participant?: string;
}
```

Feedback:

```ts
cat.onDidReceiveFeedback((fb: ChatResultFeedback) => {
  // fb.kind: ChatResultFeedbackKind.Helpful | Unhelpful
});
```

### Our implementation

Both wired at participant creation: [src/ai/lineageParticipant.ts:81-94](../src/ai/lineageParticipant.ts#L81-L94). Followups are keyed on `result.metadata.lastTools` — so "Create AI view" appears after a `bfs_trace` call and "Show in Graph" after `submit_findings`.

---

## 9. Prompt architecture (how we feed the LM)

Three layers, all plain strings (we do **not** use `@vscode/prompt-tsx` — see §13).

1. **Base system prompt** — platform + schema + core rules: [src/ai/prompts.ts:22-36](../src/ai/prompts.ts#L22-L36) (`buildSystemPromptBase`), [src/ai/prompts.ts:45-47](../src/ai/prompts.ts#L45-L47) (`buildPlatformContext`), [src/ai/prompts.ts:59-65](../src/ai/prompts.ts#L59-L65) (`buildSchemaContext`).
2. **Stage-scoped template** — DISCOVER / ACTIVE / SYNTHESIS: [src/ai/lineageParticipant.ts:207-227](../src/ai/lineageParticipant.ts#L207-L227) (`buildStageSystemPrompt`). Injects different parts of `assets/aiOutputTemplates.yaml` per phase.
3. **Navigation prompt** — Unified (`Blackboard`) with optional **Column Aspect**: [src/ai/smPrompts.ts](../src/ai/smPrompts.ts) (`buildNavigationPrompt`). Appended when entering ACTIVE phase ([lineageParticipant.ts:470-474](../src/ai/lineageParticipant.ts#L470-L474)) and **must survive the sliding-memory wipe** ([lineageParticipant.ts:537](../src/ai/lineageParticipant.ts#L537)).

Output templates loaded from `assets/aiOutputTemplates.yaml` at activation: [src/extension.ts:165](../src/extension.ts#L165). Override via config key `dataLineageViz.ai.outputTemplateFile`.

---

## 10. The state machine layered on top

Clarification for anyone writing AI instructions: the state machine is **not** part of the VS Code API. `NavigationEngine` in [src/ai/smBase.ts](../src/ai/smBase.ts) is a hop-by-hop driver around `sendRequest` + `invokeTool` that:

- Persists agenda / working memory across hops via `sess.memory` ([src/ai/memoryManager.ts](../src/ai/memoryManager.ts)).
- Drives tool-mode transitions (`Auto` → `Required` → `Auto`) per phase: [lineageParticipant.ts:302-308](../src/ai/lineageParticipant.ts#L302-L308), [:458-475](../src/ai/lineageParticipant.ts#L458-L475), [:477-508](../src/ai/lineageParticipant.ts#L477-L508).
- Wipes conversation messages between hops while re-seeding semantic continuity (§3).

Session lifecycle:

- Session id rotation on new chat: [src/ai/session.ts](../src/ai/session.ts), invoked from [lineageParticipant.ts:142-149](../src/ai/lineageParticipant.ts#L142-L149).
- 30-min staleness window: checked at tool entry via `sess.resetIfStale()` ([toolProvider.ts:125](../src/ai/toolProvider.ts#L125)).

Why this sits outside the API: VS Code's LM API is stateless per-request. Multi-hop exploration with bounded token budget requires out-of-band state (memory + agenda) that the API doesn't model.

---

## 11. Eval bridge — mirroring `vscode.lm.invokeTool` over HTTP

For evals we can't use `vscode.lm` (no Copilot Chat host). The bridge at `127.0.0.1:3271` ([test-internal/ai-test-server.ts](../test-internal/ai-test-server.ts)) mirrors the transport:

| Endpoint | Method | Mirrors |
|---|---|---|
| `/health` | GET | — (model stats) |
| `/tools` | GET | `vscode.lm.tools` (names only) |
| `/prompts` | GET | **production** `system` + `bb_mode` + `column_aspect` + `tool_descriptions` **verbatim** |
| `/session` | POST | Opaque session-id, same TTL as in-extension (30 min) |
| `/filter` | POST | Simulates the UI schema/type filter |
| `/tool` | POST | `{ tool, input, sessionId }` — 1:1 mirror of `vscode.lm.invokeTool(name, { input })` |
| `/session/:id` | DELETE | Explicit teardown |

Endpoint routing: [test-internal/ai-test-server.ts:291-368](../test-internal/ai-test-server.ts#L291-L368).

**Hard rule:** harness code never alters prompts or tool descriptions. Violating this invalidates every score. See [.claude/rules/eval-validity.md](../.claude/rules/eval-validity.md).

---

## 12. Where we diverge from the stock guide (and why)

| Stock pattern | Our choice | Why |
|---|---|---|
| `@vscode/prompt-tsx` for prompt assembly | Plain strings in [src/ai/prompts.ts](../src/ai/prompts.ts) + [src/ai/smPrompts.ts](../src/ai/smPrompts.ts) | The sliding-memory wipe ([lineageParticipant.ts:531-543](../src/ai/lineageParticipant.ts#L531-L543)) owns the message array end-to-end. `PrioritizedList` would be a second budget mechanism competing for the same role. |
| `@vscode/chat-extension-utils` `sendChatParticipantRequest` | Hand-rolled `sendRequest` + tool loop ([lineageParticipant.ts:275-545](../src/ai/lineageParticipant.ts#L275-L545)) | The state machine needs per-hop tool-mode transitions (`Auto`↔`Required`) and wipe hooks. The wrapper's auto-loop would paper over both. |
| System message role | `User` message at head ([lineageParticipant.ts:263](../src/ai/lineageParticipant.ts#L263)) | VS Code LM API does not expose a `System` role. Documented pattern. |
| `selectChatModels` in handler | Use `request.model` | Copilot Chat already selected it and negotiated consent. Re-selecting risks a second consent dialog. |
| `toolInvocationToken` always forwarded | Forwarded only when `ai.showToolInvocations` is `true` ([lineageParticipant.ts:131, :379](../src/ai/lineageParticipant.ts#L131)) | Most of our tools are internal SM steps — UI noise is counterproductive. Users opt in when debugging. |
| Tool results as multiple `TextPart`s | One `TextPart` holding `JSON.stringify(...)` ([toolProvider.ts:57-59](../src/ai/toolProvider.ts#L57-L59)) | Results are structured data for the LM, not prose for the user. |
| `stream.confirmation` for gated actions | Not used | All side-effects are read-only on a loaded model. |

---

## 13. Related AI extension points we deliberately don't use

From the [AI extensibility overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview) decision matrix:

- **MCP tools** — out-of-process tools over Model Context Protocol. No `vscode.*` API access. Portable across editors, but our tools need the in-process lineage graph — so MCP is ruled out.
- **Language Model Chat Provider (BYOK)** — extensions can *provide* a chat model via `vscode.lm.registerLanguageModelChatProvider`. We *consume* `request.model`; providing is out of scope. See [BYOK blog](https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key).
- **`@vscode/prompt-tsx`** — `renderPrompt`, `PromptElement`, `PrioritizedList`, `PromptSizing`. Skipped; reason in §12.
- **`@vscode/chat-extension-utils`** — convenience wrapper `sendChatParticipantRequest` that auto-iterates the tool-call loop. Skipped; reason in §12.

---

## 14. API version anchor

The code targets VS Code's **finalized Chat Participant + Language Model Tools APIs as of v1.95 (October 2024)** — see [v1.95 release notes](https://code.visualstudio.com/updates/v1_95). Any proposal-API regression or deprecation after this baseline should trigger an update to this doc.

---

## 15. Best practice — Ask vs Agent vs Edit mode, and MCP

Copilot Chat in VS Code has three primary modes ([GitHub blog — Ask / Edit / Agent](https://github.blog/ai-and-ml/github-copilot/copilot-ask-edit-and-agent-modes-what-they-do-and-when-to-use-them/)):

| Mode | Copilot behavior | Tools | System prompt |
|---|---|---|---|
| **Ask** | Q&A, no file edits | `@participant` and `#tool` work; no auto tool-loop | Q&A-oriented |
| **Edit** | Apply code edits to selected files | Limited | Edit-focused |
| **Agent** | Autonomous multi-step loop over workspace | Full tool access, auto-invokes | Agent-oriented, self-planning |

Each mode has its own Copilot-internal system prompt — **but only when Copilot drives the turn**. A `@participant` invocation is a full handover: our `handleChatRequest` owns the LM turn end-to-end ([src/ai/lineageParticipant.ts:116](../src/ai/lineageParticipant.ts#L116)). Copilot's mode preamble does not reach our `sendRequest`. The only message stream the model sees is the one we assemble ([lineageParticipant.ts:263](../src/ai/lineageParticipant.ts#L263) + hop re-seeds at [:531-543](../src/ai/lineageParticipant.ts#L531-L543)).

### Is a mode a sandbox?

No. Modes are **tool-permission profiles + system prompts**, not isolated sandboxes. They share the same workspace, history, model, and tool registry.

A `@participant` is closer to a sandbox in spirit: it owns the turn, supplies its own system prompt, produces its own `ChatResult`. But it still runs in the same extension-host process and talks to the same `LanguageModelChat` instance.

### Best practice for `@lineage`

**Recommended: Ask mode.**

```
@lineage where does revenue come from?
@lineage /trace dbo.Orders
@lineage /search customer
```

In Ask mode, our participant owns the turn. The state machine runs hop-by-hop; sliding-memory wipes fire; ACTIVE-phase `toolMode: Required` holds; synthesis injects the detail archive. All guarantees in §§5–10 apply.

**Not recommended: Agent mode for deep lineage exploration.**

Agent mode is Copilot's own loop. If the user types a prompt without `@lineage`, Copilot's agent may call individual `lineage_*` tools (they're registered globally via `vscode.lm.registerTool`) — but it does **not** know our phase-transition contract. It can call `lineage_start_exploration` without then cycling `submit_findings` the way the state machine expects. The sliding-memory wipe does not run; tool-mode switching does not happen. Results will be partial and inconsistent.

For ad-hoc one-shot lookups, Agent mode can still invoke a single tool via `#lineage_get_object_detail` or `#lineage_search_objects` — those are stateless and work fine outside the SM. Deep hop-by-hop exploration must go through `@lineage`.

**Edit mode: not applicable.** We produce no file edits.

### MCP — do we need it?

No — not for normal usage. Our tools are registered via `vscode.lm.registerTool` (native), which is how Copilot Chat finds and invokes them in-process. MCP ([Model Context Protocol](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)) would only be needed if:

- A user wants to call lineage tools from **outside VS Code** — another MCP client, a local agent, a CLI — where the `vscode.*` API isn't available.
- Or if we wanted cross-editor portability.

Both are out of scope for the extension as shipped. Adding an MCP wrapper would duplicate tool definitions and lose `vscode.*` API access (graph, model, webview). See the [AI extensibility overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview) decision matrix — "MCP tool" is the wrong extension point for an in-editor graph assistant.

---

## 17. How to use this doc when writing AI instructions

1. Identify which API surface you're touching (participant, LM, tool, stream).
2. Jump to the matching section; follow the cross-ref into the code.
3. If the behavior you want is already enforced by the API, prefer the API over a prompt-level rule.
4. If you're invalidating a row in §12, re-read the "Why" first.
5. Re-run evals per [.claude/rules/eval-validity.md](../.claude/rules/eval-validity.md) before shipping.

---

## 18. File index (quick lookup)

| Concern | File | Notes |
|---|---|---|
| Participant registration & chat handler | [src/ai/lineageParticipant.ts](../src/ai/lineageParticipant.ts) | 581 lines, full agent loop |
| Tool definitions + `vscode.lm.registerTool` calls | [src/ai/toolProvider.ts](../src/ai/toolProvider.ts) | All 10 tools |
| Base system prompt | [src/ai/prompts.ts](../src/ai/prompts.ts) | Platform/schema/rules + trace/search shapers |
| Navigation (per-mode) prompt | [src/ai/smPrompts.ts](../src/ai/smPrompts.ts) | Blackboard + column-trace blocks |
| State machine core | [src/ai/smBase.ts](../src/ai/smBase.ts) | `NavigationEngine` |
| Session state | [src/ai/session.ts](../src/ai/session.ts) | Lifecycle + staleness |
| Memory manager | [src/ai/memoryManager.ts](../src/ai/memoryManager.ts) | Agenda + detail archive |
| History compaction | [src/ai/historyManager.ts](../src/ai/historyManager.ts) | Stale/noise result trimming |
| Context-key flip | [src/panelProvider.ts](../src/panelProvider.ts) | `dataLineageViz.modelLoaded` |
| Eval HTTP bridge | [test-internal/ai-test-server.ts](../test-internal/ai-test-server.ts) | Mirrors `vscode.lm.invokeTool` |
| Participant + tools manifest | [package.json](../package.json) | Lines 457-1054 |
