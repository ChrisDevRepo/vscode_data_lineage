import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltInEnv } from '../../../../src/engine/db/builtInProvider';

type Widget = {
  step: number; value: string; validationMessage?: string;
  items: Array<{ value: string }>; selectedItems: Array<{ value: string }>;
  accept: () => void; hide: () => void;
};
const driver = vi.hoisted(() => ({ current: undefined as Widget | undefined, update: vi.fn(), openSession: vi.fn() }));
vi.mock('vscode', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  function widget() {
    const box = {
      step: 0, value: '', items: [], selectedItems: [], accept() {}, hide() {},
      onDidAccept(fn: () => void) { this.accept = fn; }, onDidHide(fn: () => void) { this.hide = fn; },
      onDidTriggerButton() {}, dispose() {},
      show() { this.selectedItems = this.items.slice(0, 1); driver.current = this; },
    };
    return box;
  }
  return { ...original,
    QuickInputButtons: { Back: {} },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    window: {
      createInputBox: widget, createQuickPick: widget,
      withProgress: (_options: unknown, task: () => unknown) => task(), showInformationMessage: vi.fn(),
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: driver.update }) },
  };
});
vi.mock('../../../../src/engine/db/builtInProvider', () => ({ openBuiltInSession: (...args: unknown[]) => driver.openSession(...args) }));
const { runAddConnectionFlow } = await import('../../../../src/engine/db/connectionCommands');
const env = {
  secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
  outputChannel: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as BuiltInEnv;
async function step(number: number) {
  await vi.waitFor(() => expect(driver.current?.step).toBe(number));
  return driver.current!;
}
async function atDatabase() {
  const flow = runAddConnectionFlow(env);
  for (const [number, value] of [[1, 'localhost'], [2, ''], [3, 'test_reader'], [4, 'synthetic-password']] as const) {
    const box = await step(number); box.value = value; box.accept();
  }
  return { flow, box: await step(5) };
}
beforeEach(() => {
  driver.current = undefined; driver.update.mockReset(); driver.openSession.mockReset();
  driver.openSession.mockResolvedValue({ dispose: vi.fn().mockResolvedValue(undefined) });
});
describe('database name at the add/edit wizard boundary', () => {
  it.each(['', ' \t '])('rejects blank database input %j without advancing or opening a session', async value => {
    const { flow, box } = await atDatabase(); box.value = value; box.accept();
    try {
      expect(box.validationMessage).toBe('A database name is required.');
      expect(driver.current).toBe(box);
      expect(driver.openSession).not.toHaveBeenCalled(); expect(driver.update).not.toHaveBeenCalled();
    } finally { (box.validationMessage ? box : await step(6)).hide(); await flow; }
  });
  it('cancellation at the database step saves nothing', async () => {
    const { flow, box } = await atDatabase(); box.hide();
    expect(await flow).toBeUndefined(); expect(driver.update).not.toHaveBeenCalled(); expect(driver.openSession).not.toHaveBeenCalled();
  });
  it('tests and saves a valid trimmed database name', async () => {
    const { flow, box } = await atDatabase(); box.value = '  DemoDatabase  '; box.accept();
    const name = await step(6); name.value = 'Demo connection'; name.accept();
    expect(await flow).toMatchObject({ database: 'DemoDatabase' });
    expect(driver.openSession).toHaveBeenCalledWith(expect.objectContaining({ database: 'DemoDatabase' }), env, expect.anything());
    expect(driver.update).toHaveBeenCalledWith('connections', [expect.objectContaining({ database: 'DemoDatabase' })], expect.anything());
  });
});
