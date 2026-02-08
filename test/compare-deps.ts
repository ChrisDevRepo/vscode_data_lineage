/**
 * Compare XML BodyDependencies vs Regex-parsed results for every SP.
 * Goal: find gaps where XML has deps that regex misses (or vice versa).
 *
 * Usage: npx tsx test/compare-deps.ts <dacpac-path>
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { parseSqlBody } from '../src/engine/sqlBodyParser';

// ─── Minimal XML helpers (duplicated from dacpacExtractor since they're not exported) ──

function asArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function normalizeName(name: string): string {
  const parts = name.replace(/\[|\]/g, '').split('.');
  if (parts.length >= 2) return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
  return `[dbo].[${parts[0]}]`.toLowerCase();
}

function isObjectLevelRef(name: string): boolean {
  const parts = name.replace(/\[|\]/g, '').split('.');
  return parts.length === 2 && !parts[1].startsWith('@');
}

function extractPropertyValue(prop: any): string | undefined {
  if (prop['@_Value'] !== undefined) return String(prop['@_Value']);
  if (prop.Value !== undefined) {
    if (typeof prop.Value === 'string') return prop.Value;
    if (typeof prop.Value === 'object' && prop.Value['#text']) return String(prop.Value['#text']);
  }
  return undefined;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const dacpacPath = process.argv[2];
  if (!dacpacPath) {
    console.error('Usage: npx tsx test/compare-deps.ts <dacpac-path>');
    process.exit(1);
  }

  const absPath = resolve(dacpacPath);
  console.log(`\nAnalyzing: ${absPath}\n`);

  const buffer = readFileSync(absPath);
  const zip = await JSZip.loadAsync(buffer);
  const modelFile = zip.file('model.xml');
  if (!modelFile) throw new Error('model.xml not found');
  const xml = await modelFile.async('string');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) => ['Element', 'Entry', 'Property', 'Relationship', 'Annotation'].includes(name),
    parseTagValue: true,
    trimValues: true,
  });

  const doc = parser.parse(xml);
  const elements: any[] = asArray(doc?.DataSchemaModel?.Model?.Element);

  // Build catalog of all known objects with their types (for filtering + direction inference)
  const ELEMENT_TYPE_MAP: Record<string, string> = {
    SqlTable: 'table', SqlView: 'view', SqlProcedure: 'procedure',
    SqlScalarFunction: 'function', SqlInlineTableValuedFunction: 'function',
    SqlMultiStatementTableValuedFunction: 'function', SqlTableValuedFunction: 'function',
  };
  const catalog = new Set<string>();
  const catalogType = new Map<string, string>();  // id -> 'table'|'view'|'procedure'|'function'
  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name) continue;
    const objType = ELEMENT_TYPE_MAP[type];
    if (objType) {
      const id = normalizeName(name);
      catalog.add(id);
      catalogType.set(id, objType);
    }
  }

  console.log(`Catalog: ${catalog.size} objects\n`);

  // Process each SP
  let totalXmlOnly = 0;
  let totalRegexOnly = 0;
  let totalBoth = 0;
  let totalSPs = 0;
  const issues: string[] = [];

  for (const el of elements) {
    if (el['@_Type'] !== 'SqlProcedure') continue;
    const spName = el['@_Name'];
    if (!spName) continue;
    totalSPs++;

    const spId = normalizeName(spName);

    // 1. XML BodyDependencies (object-level only, in catalog)
    const xmlDeps = new Set<string>();
    const rels = asArray(el.Relationship);
    for (const rel of rels) {
      if (rel['@_Name'] !== 'BodyDependencies' && rel['@_Name'] !== 'QueryDependencies') continue;
      const entries = asArray(rel.Entry);
      for (const entry of entries) {
        const refs = asArray(entry.References);
        for (const ref of refs) {
          if (ref['@_ExternalSource']) continue;
          const refName = ref['@_Name'];
          if (!refName || !isObjectLevelRef(refName)) continue;
          const norm = normalizeName(refName);
          if (norm !== spId && catalog.has(norm)) xmlDeps.add(norm);
        }
      }
    }

    // 2. Get body script
    let bodyScript: string | undefined;

    // Try HeaderContents + BodyScript
    const annotations = asArray(el.Annotation);
    for (const ann of annotations) {
      if (ann['@_Type'] === 'SysCommentsObjectAnnotation') {
        const annProps = asArray(ann.Property);
        for (const prop of annProps) {
          if (prop['@_Name'] === 'HeaderContents') {
            const header = extractPropertyValue(prop);
            const props = asArray(el.Property);
            for (const p of props) {
              if (p['@_Name'] === 'BodyScript') {
                const val = extractPropertyValue(p);
                if (header && val) bodyScript = `${header}\n${val}`;
              }
            }
          }
        }
      }
    }

    if (!bodyScript) {
      const props = asArray(el.Property);
      for (const p of props) {
        if (p['@_Name'] === 'BodyScript') {
          bodyScript = extractPropertyValue(p);
        }
      }
    }

    // 3. Regex parse
    const regexAll = new Set<string>();
    const regexSources = new Set<string>();
    const regexTargets = new Set<string>();
    const regexExec = new Set<string>();

    if (bodyScript) {
      const parsed = parseSqlBody(bodyScript);
      for (const s of parsed.sources) {
        const n = normalizeName(s);
        if (n !== spId && catalog.has(n)) { regexAll.add(n); regexSources.add(n); }
      }
      for (const t of parsed.targets) {
        const n = normalizeName(t);
        if (n !== spId && catalog.has(n)) { regexAll.add(n); regexTargets.add(n); }
      }
      for (const e of parsed.execCalls) {
        const n = normalizeName(e);
        if (n !== spId && catalog.has(n)) { regexAll.add(n); regexExec.add(n); }
      }
    }

    // 4. Compare
    const xmlOnly = [...xmlDeps].filter(d => !regexAll.has(d));
    const regexOnly = [...regexAll].filter(d => !xmlDeps.has(d));
    const both = [...xmlDeps].filter(d => regexAll.has(d));

    totalXmlOnly += xmlOnly.length;
    totalRegexOnly += regexOnly.length;
    totalBoth += both.length;

    // Print per-SP report
    const hasGap = xmlOnly.length > 0 || regexOnly.length > 0;
    const marker = hasGap ? '!!' : 'OK';

    console.log(`${marker} ${spName}`);
    console.log(`  XML deps: ${xmlDeps.size}  |  Regex deps: ${regexAll.size}  |  Overlap: ${both.length}`);

    if (regexSources.size > 0 || regexTargets.size > 0 || regexExec.size > 0) {
      console.log(`  Regex breakdown -> Sources: ${regexSources.size}, Targets: ${regexTargets.size}, Exec: ${regexExec.size}`);
    }

    if (xmlOnly.length > 0) {
      console.log(`  XML-only (regex MISSED):  ${xmlOnly.join(', ')}`);
      for (const dep of xmlOnly) {
        issues.push(`${spName}: regex missed "${dep}" (XML has it)`);
      }
    }

    if (regexOnly.length > 0) {
      console.log(`  Regex-only (not in XML):  ${regexOnly.join(', ')}`);
    }

    if (both.length > 0) {
      console.log(`  Both agree: ${both.join(', ')}`);
    }

    // Show direction for matched deps
    for (const dep of both) {
      const dir = regexTargets.has(dep) ? 'WRITE' : regexExec.has(dep) ? 'EXEC' : 'READ';
      console.log(`     ${dep} -> ${dir}`);
    }
    for (const dep of xmlOnly) {
      console.log(`     ${dep} -> ??? (direction unknown - regex missed it)`);
    }
    for (const dep of regexOnly) {
      const dir = regexTargets.has(dep) ? 'WRITE' : regexExec.has(dep) ? 'EXEC' : 'READ';
      console.log(`     ${dep} -> ${dir} (regex-only)`);
    }

    console.log();
  }

  // Summary
  console.log('='.repeat(70));
  console.log(`SUMMARY: ${totalSPs} stored procedures analyzed`);
  console.log(`  Both agree:      ${totalBoth} deps`);
  console.log(`  XML-only:        ${totalXmlOnly} deps (regex MISSED these)`);
  console.log(`  Regex-only:      ${totalRegexOnly} deps (not in XML)`);
  console.log();

  if (issues.length > 0) {
    console.log(`!! ${issues.length} GAPS where XML has deps that regex missed:`);
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
  } else {
    console.log('OK No gaps: regex found all deps that XML has.');
  }

  if (totalRegexOnly > 0) {
    console.log(`\nNote: ${totalRegexOnly} regex-only deps are expected — these are typically`);
    console.log(`objects referenced via dynamic SQL or patterns XML doesn't track.`);
  }

  console.log();
}

main().catch(console.error);
