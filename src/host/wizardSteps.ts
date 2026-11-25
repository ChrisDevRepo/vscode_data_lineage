/**
 * The step prompts of the multi-step QuickInput wizards (Add Database Connection, Add AI Model): a
 * titled input box or pick list with Back, and the loop that walks the steps forward and back.
 */

import * as vscode from 'vscode';

/** What a step resolves to: the answer, {@link BACK}, or `undefined` when the user left the wizard. */
const BACK = Symbol('back');
type Answer<T> = T | typeof BACK | undefined;

type StepOutcome = 'next' | 'back' | 'cancel';

/** Maps an answer to how the wizard moves on. */
export const outcome = (answer: Answer<unknown>): StepOutcome => (answer === BACK ? 'back' : answer === undefined ? 'cancel' : 'next');

interface InputOptions {
  step: number;
  totalSteps: number;
  prompt: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  canGoBack: boolean;
  validate?: (value: string) => string | undefined;
}

interface PickOptions<T extends vscode.QuickPickItem> {
  step: number;
  totalSteps: number;
  placeholder: string;
  items: T[];
  /** The item Enter takes; the first when absent. */
  active?: T;
  canGoBack: boolean;
}

/** One wizard step: `run` gets the 1-based step number and total applicable count shown in the title bar. */
export interface WizardStep {
  applies: () => boolean;
  run: (stepNumber: number, totalSteps: number) => Promise<StepOutcome>;
}

/** The prompts of one wizard, titled `title`. */
export function wizardPrompts(title: string) {
  function askInput(options: InputOptions): Promise<Answer<string>> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      box.title = title;
      box.step = options.step;
      box.totalSteps = options.totalSteps;
      box.prompt = options.prompt;
      box.value = options.value ?? '';
      box.placeholder = options.placeholder;
      box.password = options.password === true;
      box.ignoreFocusOut = true;
      box.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
      const done = (answer: Answer<string>) => { resolve(answer); box.dispose(); };
      box.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) done(BACK); });
      box.onDidAccept(() => {
        const problem = options.validate?.(box.value);
        if (problem) { box.validationMessage = problem; return; }
        done(box.value);
      });
      box.onDidHide(() => done(undefined));
      box.show();
    });
  }

  function askPick<T extends vscode.QuickPickItem>(options: PickOptions<T>): Promise<Answer<T>> {
    return new Promise((resolve) => {
      const pick = vscode.window.createQuickPick<T>();
      pick.title = title;
      pick.step = options.step;
      pick.totalSteps = options.totalSteps;
      pick.placeholder = options.placeholder;
      pick.ignoreFocusOut = true;
      pick.matchOnDescription = true;
      pick.items = options.items;
      if (options.active) pick.activeItems = [options.active];
      pick.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
      const done = (answer: Answer<T>) => { resolve(answer); pick.dispose(); };
      pick.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) done(BACK); });
      pick.onDidAccept(() => done(pick.selectedItems[0]));
      pick.onDidHide(() => done(undefined));
      pick.show();
    });
  }

  return { askInput, askPick };
}

/**
 * Walks `steps` from the first: a step that does not apply is skipped in the direction of travel,
 * Back returns to the previous applicable step, and each step receives its 1-based ordinal and the
 * count of currently applicable steps.
 *
 * @returns `true` once the last step answered, `false` when the user left the wizard.
 */
export async function runSteps(steps: readonly WizardStep[]): Promise<boolean> {
  let at = 0;
  let direction = 1;
  while (at < steps.length) {
    if (at < 0) return false;
    const step = steps[at];
    if (!step.applies()) { at += direction; continue; }
    const totalSteps = steps.filter((item) => item.applies()).length;
    const stepNumber = steps.slice(0, at + 1).filter((item) => item.applies()).length;
    const result = await step.run(stepNumber, totalSteps);
    if (result === 'cancel') return false;
    direction = result === 'back' ? -1 : 1;
    at += direction;
  }
  return true;
}
