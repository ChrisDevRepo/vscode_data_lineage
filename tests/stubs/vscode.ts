export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  public readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
  constructor() {
    const source = this;
    this.token = {
      get isCancellationRequested() { return source.cancelled; },
      onCancellationRequested(listener) {
        source.listeners.add(listener);
        return { dispose: () => source.listeners.delete(listener) };
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

/**
 * Minimal `vscode.extensions` surface: a registry unit tests write before exercising code that
 * reaches for another extension's exported API. Empty by default, so the absent-extension path is
 * what a test gets unless it registers one.
 */
export const extensions = {
  registry: new Map<string, { isActive: boolean; exports: unknown; packageJSON: { version: string } }>(),
  changeListeners: new Set<() => void>(),
  getExtension(id: string) {
    return extensions.registry.get(id);
  },
  onDidChange(listener: () => void, _thisArgs?: unknown, disposables?: { dispose(): void }[]) {
    extensions.changeListeners.add(listener);
    const disposable = { dispose: () => { extensions.changeListeners.delete(listener); } };
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

/** The language-model classes `vscodeLmTransport` constructs and reads; values match the VS Code API. */
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: readonly unknown[],
  ) {}
}

export class LanguageModelChatMessage {
  constructor(
    public readonly role: LanguageModelChatMessageRole,
    public readonly content: readonly unknown[],
    public readonly name?: string,
  ) {}

  public static User(content: string | readonly unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, typeof content === 'string' ? [new LanguageModelTextPart(content)] : content, name);
  }

  public static Assistant(content: string | readonly unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, typeof content === 'string' ? [new LanguageModelTextPart(content)] : content, name);
  }
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }

  public static NoPermissions(message?: string): LanguageModelError { return new LanguageModelError(message ?? '', 'NoPermissions'); }
  public static Blocked(message?: string): LanguageModelError { return new LanguageModelError(message ?? '', 'Blocked'); }
  public static NotFound(message?: string): LanguageModelError { return new LanguageModelError(message ?? '', 'NotFound'); }
}

/** `vscode.lm`: the models a test registers in `models`, filtered by the selector as the host does. */
export const lm = {
  models: [] as Array<Record<string, unknown>>,
  changeListeners: new Set<() => void>(),
  selectChatModels(selector: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve(lm.models.filter((model) => Object.entries(selector).every(([key, value]) => value === undefined || model[key] === value)));
  },
  onDidChangeChatModels(listener: () => void) {
    lm.changeListeners.add(listener);
    return { dispose: () => { lm.changeListeners.delete(listener); } };
  },
  reset() {
    lm.models = [];
    lm.changeListeners.clear();
  },
};
