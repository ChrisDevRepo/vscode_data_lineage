/**
 * Pins the connection contributions in package.json: the provider enum, the credential-free
 * connections schema, application scope, the four commands, and that mssql stays a soft dependency.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../../helpers/testUtils';
import { BuiltInConnectionSchema } from '../../../../src/engine/db/connectionSettings';

interface Manifest {
  extensionDependencies?: string[];
  dependencies: Record<string, string>;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    configuration: Array<{ properties: Record<string, any> }>;
  };
}

const manifest = JSON.parse(readFileSync(rootPath('package.json'), 'utf-8')) as Manifest;
const settings = Object.assign({}, ...manifest.contributes.configuration.map((s) => s.properties)) as Record<string, any>;

describe('connection settings contribution', () => {
  it('offers exactly mssqlExtension and builtIn, defaulting to mssqlExtension, one description each', () => {
    const provider = settings['dataLineageViz.database.connectionProvider'];
    expect(provider.enum).toEqual(['mssqlExtension', 'builtIn']);
    expect(provider.default).toBe('mssqlExtension');
    expect(provider.enumDescriptions).toHaveLength(2);
  });

  it('is application-scoped so a workspace cannot override where connections come from', () => {
    expect(settings['dataLineageViz.database.connectionProvider'].scope).toBe('application');
    expect(settings['dataLineageViz.database.connections'].scope).toBe('application');
  });

  it('declares the connections array with a closed item schema and no password property', () => {
    const connections = settings['dataLineageViz.database.connections'];
    expect(connections.type).toBe('array');
    expect(connections.items.additionalProperties).toBe(false);
    expect(Object.keys(connections.items.properties)).not.toContain('password');
    expect(connections.markdownDescription).toMatch(/passwords are never stored here/i);
  });

  it('item properties match the runtime schema keys', () => {
    const declared = Object.keys(settings['dataLineageViz.database.connections'].items.properties).sort();
    expect(declared).toEqual(Object.keys(BuiltInConnectionSchema.shape).sort());
  });

  it('contributes the four commands under the Data Lineage category', () => {
    const wanted = ['addDatabaseConnection', 'editDatabaseConnection', 'removeDatabaseConnection', 'updateDatabasePassword'];
    for (const name of wanted) {
      const entry = manifest.contributes.commands.find((c) => c.command === `dataLineageViz.${name}`);
      expect(entry, name).toBeDefined();
      expect(entry?.category).toBe('Data Lineage');
    }
    expect(manifest.contributes.commands.find((c) => c.command === 'dataLineageViz.addDatabaseConnection')?.title).toBe('Add Database Connection');
  });

  it('keeps the mssql extension a soft dependency and ships tedious', () => {
    expect(manifest.extensionDependencies ?? []).toEqual([]);
    expect(manifest.dependencies.tedious).toBeDefined();
  });
});
