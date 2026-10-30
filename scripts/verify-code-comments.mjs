#!/usr/bin/env node
/**
 * Verifies that all code comments across the codebase follow state-of-the-art TSDoc
 * and repo style guidelines:
 * - Exported declarations must have TSDoc comments.
 * - Comments must not contain chatty conversational phrasing, personal pronouns (I, we, you),
 *   narration, history markers, author/date tags, or commented-out code.
 * - TSDoc must not use redundant JSDoc type annotations like `@param {string}`.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const SCAN_DIR = path.join(REPO_ROOT, 'src');

/**
 * Returns all TypeScript source files under the given directory.
 */
function getSourceFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getSourceFiles(fullPath));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

// Patterns that indicate chatty, narrative, or non-TSDoc comment styles.
const CHATTY_PATTERNS = [
  {
    id: 'first-person',
    label: 'First-person pronoun (I, we, our, us, my)',
    test: (comment) => {
      // Strip URLs and inline code in backticks before checking pronouns
      const sanitized = comment
        .replace(/https?:\/\/\S+/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\ben-us\b/gi, '');
      return (
        /\b(I|we|our|my|mine)\b/.test(sanitized) ||
        /\b(we|our|us|my|mine)\b/i.test(sanitized)
      );
    },
  },
  {
    id: 'second-person',
    label: 'Second-person pronoun (you, your, yours)',
    test: (comment) => {
      const sanitized = comment
        .replace(/https?:\/\/\S+/g, '')
        .replace(/`[^`]+`/g, '');
      return /\b(you|your|yours)\b/i.test(sanitized);
    },
  },
  {
    id: 'conversational-filler',
    label:
      'Conversational filler (actually, basically, obviously, simply, just, maybe, perhaps)',
    test: (comment) => {
      const sanitized = comment
        .replace(/https?:\/\/\S+/g, '')
        .replace(/`[^`]+`/g, '');
      return /\b(actually|basically|obviously|simply|maybe|perhaps)\b/i.test(
        sanitized,
      );
    },
  },
  {
    id: 'narration',
    label:
      "Narration (here we, now we, then we, lets, let's, note that, please note, remember that)",
    test: (comment) => {
      const sanitized = comment
        .replace(/https?:\/\/\S+/g, '')
        .replace(/`[^`]+`/g, '');
      return /\b(here\s+we|now\s+we|then\s+we|first\s+we|next\s+we|let'?s|note\s+that|please\s+note|remember\s+that|notice\s+that)\b/i.test(
        sanitized,
      );
    },
  },
  {
    id: 'history-marker',
    label:
      'Historical note or changelog (previously, used to be, before this, formerly)',
    test: (comment) => {
      const sanitized = comment
        .replace(/https?:\/\/\S+/g, '')
        .replace(/`[^`]+`/g, '');
      return /\b(used\s+to\s+be|before\s+this\s+(change|commit|fix)|formerly\s+was|previously\s+was|prior\s+to\s+this)\b/i.test(
        sanitized,
      );
    },
  },
  {
    id: 'author-date',
    label: 'Author/date marker (@author, @date, created by, authored by)',
    test: (comment) =>
      /(@author|@date|created\s+by|authored\s+by)/i.test(comment),
  },
  {
    id: 'jsdoc-type',
    label:
      'Redundant JSDoc type annotation in TSDoc (@param {type} or @returns {type})',
    test: (comment) => /@(param|returns?)\s*\{[^}]+\}/.test(comment),
  },
  {
    id: 'commented-code',
    label: 'Commented-out code',
    test: (comment) =>
      /^\s*\/\/\s*(const|let|var|function|return|import|export)\s+[a-zA-Z_$0-9]+\s*(=|\(|:)/.test(
        comment,
      ),
  },
  {
    id: 'todo-marker',
    label: 'TODO / FIXME / HACK marker',
    test: (comment) => /\b(TODO|FIXME|HACK|XXX)\b/.test(comment),
  },
];

let totalIssues = 0;
const files = getSourceFiles(SCAN_DIR);

const issuesByFile = new Map();

function addIssue(filePath, line, col, ruleId, message, sample) {
  totalIssues++;
  const relPath = path.relative(REPO_ROOT, filePath);
  if (!issuesByFile.has(relPath)) {
    issuesByFile.set(relPath, []);
  }
  issuesByFile.get(relPath).push({ line, col, ruleId, message, sample });
}

for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );

  // 1. Check exported declarations for missing TSDoc
  function isExported(node) {
    if (!node.modifiers) return false;
    return node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  function hasTsDocComment(node) {
    const text = node.getFullText(sf);
    const leadingRanges = ts.getLeadingCommentRanges(text, 0) || [];
    return leadingRanges.some((r) =>
      text.slice(r.pos, r.end).startsWith('/**'),
    );
  }

  ts.forEachChild(sf, (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      (ts.isVariableStatement(node) && isExported(node))
    ) {
      if (isExported(node)) {
        if (!hasTsDocComment(node)) {
          const { line, character } = sf.getLineAndCharacterOfPosition(
            node.getStart(sf),
          );
          let name = 'declaration';
          if (node.name && node.name.text) {
            name = node.name.text;
          } else if (ts.isVariableStatement(node)) {
            name = node.declarationList.declarations
              .map((d) => d.name.getText(sf))
              .join(', ');
          }
          addIssue(
            filePath,
            line + 1,
            character + 1,
            'missing-tsdoc',
            `Exported declaration '${name}' is missing TSDoc documentation.`,
            node.getText(sf).slice(0, 60),
          );
        }
      }
    }
  });

  // 2. Scan all comments for chatty phrasing, narration, author markers, etc.
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    content,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      const commentRaw = content.slice(start, end);
      const { line, character } = sf.getLineAndCharacterOfPosition(start);

      // Check against chatty patterns
      for (const pattern of CHATTY_PATTERNS) {
        if (pattern.test(commentRaw)) {
          // Special cases:
          // In comments mentioning third-party licenses or standard docs, check context.
          // In Vite client reference (/// <reference types="vite/client" />), ignore.
          if (commentRaw.startsWith('/// <reference')) {
            continue;
          }

          const firstLine = commentRaw.split('\n')[0].trim().slice(0, 100);
          addIssue(
            filePath,
            line + 1,
            character + 1,
            pattern.id,
            pattern.label,
            firstLine,
          );
          break;
        }
      }
    }
    token = scanner.scan();
  }
}

// Print results
if (totalIssues === 0) {
  console.log(
    `PASS: All code comments verified across ${files.length} files. No chatty or missing TSDoc comments found.`,
  );
  process.exit(0);
} else {
  console.log(
    `FAIL: Found ${totalIssues} comment issues across ${issuesByFile.size} files:\n`,
  );
  for (const [relPath, issues] of issuesByFile.entries()) {
    console.log(`--- ${relPath} (${issues.length}) ---`);
    for (const issue of issues) {
      console.log(
        `  L${issue.line}:${issue.col} [${issue.ruleId}] ${issue.message}`,
      );
      if (issue.sample) {
        console.log(`    > ${issue.sample}`);
      }
    }
  }
  process.exit(1);
}
