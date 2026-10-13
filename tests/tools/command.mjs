import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Executes an argument vector without a shell; native failures retain exit, signal, and captured output. */
export const runCommand = (file, args, options = {}) => execute(file, args, { ...options, encoding: 'utf8', shell: false });
