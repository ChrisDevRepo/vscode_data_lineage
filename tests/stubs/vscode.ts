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
    public readonly input: unknown,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: readonly LanguageModelTextPart[],
  ) {}
}

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
  return typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
}

export const LanguageModelChatToolMode = { Auto: 0, Required: 1 } as const;

export class CancellationError extends Error {}

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
