export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

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
