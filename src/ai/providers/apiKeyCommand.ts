/**
 * "Data Lineage: Set API key": picks one `ai.models` entry and stores the key typed for it in
 * SecretStorage under the entry id. The key is never in settings, a log line or a message.
 */
import * as vscode from 'vscode';
import type { Logger } from '../../utils/log';
import { notifyWarning } from '../../utils/notifications';
import { apiKeySecretName, parseModelEntries } from './modelEntries';

/** Command id; the optional argument is an entry id, for callers that skip the picker. */
const SET_API_KEY_COMMAND = 'dataLineageViz.setApiKey';

/** Registers the command; resolves `true` once a key was stored. */
export function registerSetApiKeyCommand(context: vscode.ExtensionContext, logger: Logger): vscode.Disposable {
  return vscode.commands.registerCommand(SET_API_KEY_COMMAND, async (entryId?: unknown): Promise<boolean> => {
    const { entries, invalid } = parseModelEntries(vscode.workspace.getConfiguration('dataLineageViz').get('ai.models'));
    if (invalid.length > 0) {
      notifyWarning(
        logger,
        'Set API key',
        `Data Lineage: Not offered, invalid in ai.models: ${invalid.map((entry) => entry.name).join(', ')}.`,
        { issues: invalid.flatMap((entry) => entry.issues) },
      );
    }
    const picked = typeof entryId === 'string'
      ? entries.find((entry) => entry.id === entryId)
      : (await vscode.window.showQuickPick(
          entries.map((entry) => ({ label: entry.name, description: entry.id, id: entry.id })),
          { placeHolder: 'Select the model entry the key belongs to' },
        ));
    const id = picked?.id;
    if (!id) return false;
    const key = await vscode.window.showInputBox({
      title: 'API key',
      prompt: 'Stored in the VS Code secret store, never in settings.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!key?.trim()) return false;
    await context.secrets.store(apiKeySecretName(id), key.trim());
    logger.info('Saved model API key');
    logger.debug(`Saved model API key for entry ${id}`);
    return true;
  });
}
