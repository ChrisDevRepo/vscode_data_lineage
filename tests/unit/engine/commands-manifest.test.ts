/** Checks statically declared VS Code registration calls against contributions; native activation is verified in the host lane. */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { rootPath } from '../helpers/testUtils';

type Command = { command: string };

/** Commands registered at runtime but deliberately absent from `contributes.commands`, so neither reaches the Command Palette. */
const INTENTIONALLY_UNCONTRIBUTED = [
  'dataLineageViz.aiResumeNativeGate',
  'dataLineageViz.openExternalProject',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function registeredCommandIds(
  files = Object.fromEntries(
    sourceFiles(rootPath('src')).map((file) => [
      file,
      readFileSync(file, 'utf-8'),
    ]),
  ),
): Set<string> {
  const options = {
    noLib: true,
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host),
    exists = host.fileExists.bind(host);
  host.readFile = (file) => files[file] ?? read(file);
  host.fileExists = (file) => file in files || exists(file);
  const program = ts.createProgram(Object.keys(files), options, host);
  const checker = program.getTypeChecker();
  const literal = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): string | undefined => {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.initializer
      ? literal(declaration.initializer, seen)
      : undefined;
  };
  const ids = new Set<string>();
  for (const name of Object.keys(files)) {
    const file = program.getSourceFile(name)!;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'vscode.commands' &&
        node.expression.name.text === 'registerCommand'
      ) {
        const id = node.arguments[0] && literal(node.arguments[0]);
        if (id === undefined)
          throw new Error(
            `Static command ID unresolved in ${name}; this check cannot establish runtime registration.`,
          );
        ids.add(id);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return ids;
}

function contributedCommandIds(): string[] {
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf-8')) as {
    contributes?: { commands?: Command[] };
  };
  return (pkg.contributes?.commands ?? []).map((entry) => entry.command);
}

describe('VS Code commands manifest consistency', () => {
  it('resolves literal and const/import registration IDs, never uncalled constants, comments or strings', () => {
    expect([
      ...registeredCommandIds({
        [rootPath('src', '__command-audit__.ts')]: `
        import { IMPORTED_ID } from './__command-ids__';
        const GHOST_COMMAND = 'dataLineageViz.ghost';
        const LOCAL_ID = 'dataLineageViz.local';
        // vscode.commands.registerCommand('dataLineageViz.comment', () => {});
        const example = "vscode.commands.registerCommand('dataLineageViz.string', () => {})";
        vscode.commands.registerCommand('dataLineageViz.actual', () => {});
        vscode.commands.registerCommand(LOCAL_ID, () => {});
        vscode.commands.registerCommand(IMPORTED_ID, () => {});
      `,
        [rootPath('src', '__command-ids__.ts')]:
          "export const IMPORTED_ID = 'dataLineageViz.imported';",
      }),
    ]).toEqual([
      'dataLineageViz.actual',
      'dataLineageViz.local',
      'dataLineageViz.imported',
    ]);
  });

  it('every contributed command has a statically declared registration call', () => {
    const registered = registeredCommandIds();
    const missing = contributedCommandIds().filter((id) => !registered.has(id));
    expect(missing, 'palette commands with no registerCommand call').toEqual(
      [],
    );
  });

  it('every statically registered command is contributed or explicitly exempt', () => {
    const contributed = new Set(contributedCommandIds());
    const undeclared = [...registeredCommandIds()]
      .filter((id) => id.startsWith('dataLineageViz.'))
      .filter(
        (id) =>
          !contributed.has(id) && !INTENTIONALLY_UNCONTRIBUTED.includes(id),
      )
      .sort();
    expect(
      undeclared,
      'commands registered but not reachable from the palette',
    ).toEqual([]);
  });
});
