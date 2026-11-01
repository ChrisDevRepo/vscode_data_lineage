/** Role enum tests use to build language-model messages without the extension host. */
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

/** Text part of a language-model message in the vscode stub tests import. */
export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

/** Tool-call part so a test can replay a model turn that invoked a tool. */
export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: unknown,
  ) {}
}

/** Tool-result part so a test can pass a tool reply into the next model turn. */
export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: readonly LanguageModelTextPart[],
  ) {}
}

/** Message type with User and Assistant factories the product calls on vscode. */
export class LanguageModelChatMessage {
  public static User(
    content: string | readonly LanguageModelChatMessagePart[],
    name?: string,
  ): LanguageModelChatMessage {
    return new LanguageModelChatMessage(
      LanguageModelChatMessageRole.User,
      toParts(content),
      name,
    );
  }

  public static Assistant(
    content: string | readonly LanguageModelChatMessagePart[],
    name?: string,
  ): LanguageModelChatMessage {
    return new LanguageModelChatMessage(
      LanguageModelChatMessageRole.Assistant,
      toParts(content),
      name,
    );
  }

  constructor(
    public readonly role: LanguageModelChatMessageRole,
    public readonly content: readonly LanguageModelChatMessagePart[],
    public readonly name?: string,
  ) {}
}

type LanguageModelChatMessagePart =
  | LanguageModelTextPart
  | LanguageModelToolCallPart
  | LanguageModelToolResultPart;

function toParts(
  content: string | readonly LanguageModelChatMessagePart[],
): readonly LanguageModelChatMessagePart[] {
  return typeof content === 'string'
    ? [new LanguageModelTextPart(content)]
    : content;
}

/** Auto and Required modes product code reads when sending a tool-capable request. */
export const LanguageModelChatToolMode = { Auto: 0, Required: 1 } as const;

/** Token source a test cancels without the real vscode cancellation implementation. */
export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  public readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
  constructor() {
    const isCancelled = () => this.cancelled;
    const listeners = this.listeners;
    this.token = {
      get isCancellationRequested() {
        return isCancelled();
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
  }
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
  }
  public dispose(): void {}
}

/** Minimal `vscode.extensions` surface: a registry unit tests write before exercising code that
 * reaches for another extension's exported API. Empty by default, so the absent-extension path is
 * what a test gets unless it registers one.
 */
export const extensions = {
  registry: new Map<
    string,
    { isActive: boolean; exports: unknown; packageJSON: { version: string } }
  >(),
  changeListeners: new Set<() => void>(),
  getExtension(id: string) {
    return extensions.registry.get(id);
  },
  onDidChange(
    listener: () => void,
    _thisArgs?: unknown,
    disposables?: { dispose(): void }[],
  ) {
    extensions.changeListeners.add(listener);
    const disposable = {
      dispose: () => {
        extensions.changeListeners.delete(listener);
      },
    };
    disposables?.push(disposable);
    return disposable;
  },
  /** Raises the change event, as installing, enabling or disabling an extension does. */
  fireDidChange() {
    for (const listener of [...extensions.changeListeners]) listener();
  },
  reset() {
    extensions.registry.clear();
    extensions.changeListeners.clear();
  },
};
