/// <reference lib="dom" />
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';

/** One captured `present-result.json` to show in the real webview; written by tests/tools/ai-preview-sbs.mjs. */
interface PreviewRender {
  key: string;
  presentResult: string;
}

interface PreviewManifest {
  dacpac: string;
  out: string;
  renders: PreviewRender[];
}

interface SessionProjection {
  model: { nodes: Array<{ id: string }> } | null;
  presentationArtifact: unknown;
}

/** Reads the rendered AI report and graph of the AI preview from the webview DOM. */
function readPreview(): unknown {
  const md = document.querySelector('.ln-ai-description-md');
  interface Section {
    heading: string;
    text: number;
    labels: string[];
    stepsWithoutList: number;
  }
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const child of Array.from(md?.children ?? [])) {
    if (child.tagName === 'H2') {
      current = {
        heading: child.textContent?.trim() ?? '',
        text: 0,
        labels: [],
        stepsWithoutList: 0,
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.text += child.textContent?.trim().length ?? 0;
    // A bold lead-in paragraph is a section label of the output template.
    const lead = child.tagName === 'P' ? child.firstElementChild : null;
    if (
      lead?.tagName === 'STRONG' &&
      child.textContent?.trimStart().startsWith(lead.textContent ?? '')
    ) {
      const label = lead.textContent?.trim() ?? '';
      current.labels.push(label);
      if (
        /^Steps\b/u.test(label) &&
        !child.querySelector('ol') &&
        child.nextElementSibling?.tagName !== 'OL'
      )
        current.stepsWithoutList += 1;
    }
  }
  const warnings = Array.from(md?.querySelectorAll('*') ?? []).filter((el) =>
    Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent?.includes('\u26A0'),
    ),
  );
  const count = (selector: string) =>
    md ? md.querySelectorAll(selector).length : 0;
  return {
    html: md?.innerHTML ?? null,
    text: md?.textContent?.length ?? 0,
    headings: Array.from(md?.querySelectorAll('h1,h2,h3,h4') ?? []).map(
      (h) => `${h.tagName.toLowerCase()} ${h.textContent?.trim()}`,
    ),
    sections,
    structure: {
      tables: count('table'),
      listItems: count('li'),
      codeBlocks: count('pre'),
      inlineFormulas: count('.katex:not(.katex-display .katex)'),
      displayFormulas: count('.katex-display'),
      objectsLines: count('.ln-ai-objects'),
    },
    formulaErrors: Array.from(
      md?.querySelectorAll('.ln-ai-formula-error') ?? [],
    ).map((e) => `${e.textContent} :: ${e.getAttribute('title')}`),
    katexErrors: count('.katex-error'),
    callouts: {
      total: warnings.length,
      outsideListItem: warnings.filter((el) => !el.closest('li')).length,
      merged: Array.from(md?.querySelectorAll('li') ?? []).filter(
        (li) =>
          Array.from(li.childNodes)
            .filter((n) => n.nodeName !== 'UL' && n.nodeName !== 'OL')
            .map((n) => n.textContent ?? '')
            .join('')
            .split('\u26A0').length > 2,
      ).length,
    },
    codeLanguages: Array.from(md?.querySelectorAll('pre > code') ?? []).map(
      (code) => /language-(\S+)/u.exec(code.className)?.[1] ?? 'none',
    ),
    chips: document.querySelectorAll('.ln-ai-section-chip').length,
    nodes: Array.from(document.querySelectorAll('.react-flow__node')).map((n) =>
      n.getAttribute('data-id'),
    ),
    edges: Array.from(document.querySelectorAll('.react-flow__edge')).map((e) =>
      e.getAttribute('data-id'),
    ),
    notes: document.querySelectorAll('[class*="ln-ai-note"]').length,
  };
}

/** Reads the Detail (column) view: each object's column rows and the drawn column edges. */
function readDetail(): unknown {
  return {
    nodes: Array.from(document.querySelectorAll('.react-flow__node')).map(
      (n) => ({
        id: n.getAttribute('data-id'),
        columns: Array.from(n.querySelectorAll('[role="listitem"]')).map(
          (row) => row.getAttribute('aria-label') ?? row.textContent ?? '',
        ),
      }),
    ),
    edges: Array.from(document.querySelectorAll('.react-flow__edge')).map((e) =>
      e.getAttribute('data-id'),
    ),
  };
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  ms: number,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Opt-in: shows captured AI results in the real lineage webview and records what it renders. No model calls. */
suite('AI preview side by side — real webview', () => {
  const manifestPath = process.env.DLV_AI_PREVIEW_MANIFEST;
  let browser: Browser;
  let page: Page;
  let exports: { getSession(): SessionProjection };

  suiteSetup(async function () {
    this.timeout(120_000);
    assert.ok(manifestPath, 'DLV_AI_PREVIEW_MANIFEST is required.');
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as PreviewManifest;
    exports = await vscode.extensions
      .getExtension('datahelper-chwagner.data-lineage-viz')!
      .activate();
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_CDP_PORT}`,
    );
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url().includes('workbench'))!;
    assert.ok(page, 'CDP must attach to the test workbench');
    await page.setViewportSize({ width: 1800, height: 1100 });
    await vscode.commands.executeCommand('dataLineageViz.open');
    const anyFrameShows = (selector: string) => async () => {
      for (const frame of page.frames())
        if (
          await frame
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
        )
          return true;
      return undefined;
    };
    // The forced load posts the model once; the webview must be listening first.
    assert.ok(
      await waitFor(anyFrameShows('text=Create New Project'), 60_000),
      'the lineage webview must open',
    );
    await vscode.commands.executeCommand(
      'dataLineageViz.openExternalProject',
      vscode.Uri.file(manifest.dacpac),
    );
    assert.ok(
      await waitFor(
        async () => (exports.getSession().model ? true : undefined),
        60_000,
      ),
      'the case DACPAC must load',
    );
    assert.ok(
      await waitFor(anyFrameShows('.react-flow__viewport'), 60_000),
      'the loaded model must render a graph',
    );
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  suiteTeardown(async () => {
    await browser?.close();
  });

  test('renders every captured result', async function () {
    const manifest = JSON.parse(
      readFileSync(manifestPath!, 'utf8'),
    ) as PreviewManifest;
    this.timeout(manifest.renders.length * 90_000 + 60_000);
    mkdirSync(join(manifest.out, 'renders'), { recursive: true });
    mkdirSync(join(manifest.out, 'png'), { recursive: true });
    let previousHtml: string | null = null;
    let previousDescription: string | null = null;
    for (const render of manifest.renders) {
      const artifact = JSON.parse(readFileSync(render.presentResult, 'utf8'));
      // The same description renders the same HTML, so only a new description is awaited as a change.
      const description = String(artifact.aiMetadata?.description ?? '');
      const sameDescription = description === previousDescription;
      const pageErrors: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === 'error') pageErrors.push(message.text());
      };
      page.on('console', onConsole);
      exports.getSession().presentationArtifact = artifact;
      await vscode.commands.executeCommand('dataLineageViz.aiCreateView');
      const found = await waitFor(async () => {
        for (const frame of page.frames()) {
          // A narrow window opens the report collapsed to its rail; expand it as a user would.
          await frame
            .locator('.ln-ai-description-rail')
            .first()
            .click({ timeout: 100 })
            .catch(() => undefined);
          const html = await frame
            .locator('.ln-ai-description-md')
            .first()
            .innerHTML({ timeout: 100 })
            .catch(() => undefined);
          if (html !== undefined && (sameDescription || html !== previousHtml))
            return { frame, html };
        }
        return undefined;
      }, 30_000);
      const result: Record<string, unknown> = {
        key: render.key,
        presentResult: render.presentResult,
      };
      if (!found) {
        result.error = 'the AI report did not render within 30 s';
        result.frames = page.frames().map((f) => f.url().slice(0, 120));
        await page.screenshot({
          path: join(manifest.out, 'png', `${render.key}-failed.png`),
        });
      } else {
        const frame: Frame = found.frame;
        previousHtml = found.html;
        previousDescription = description;
        // Let the graph layout settle before reading it.
        let last = '';
        await waitFor(async () => {
          const ids = JSON.stringify(
            await frame
              .locator('.react-flow__node')
              .evaluateAll((n) => n.map((x) => x.getAttribute('data-id'))),
          );
          const settled = ids === last && ids !== '[]';
          last = ids;
          return settled ? true : undefined;
        }, 15_000);
        await frame
          .getByRole('button', { name: 'Fit View', exact: true })
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(500);
        result.preview = await frame.evaluate(readPreview);
        await page.screenshot({
          path: join(manifest.out, 'png', `${render.key}-preview.png`),
        });
        const detail = frame.getByRole('button', {
          name: 'Detail',
          exact: true,
        });
        if (await detail.count()) {
          await detail.first().click();
          await frame
            .getByRole('listitem')
            .first()
            .waitFor({ state: 'visible', timeout: 10_000 })
            .catch(() => undefined);
          await frame
            .getByRole('button', { name: 'Fit View', exact: true })
            .click()
            .catch(() => undefined);
          let lastEdges = -1;
          await waitFor(async () => {
            const edges = await frame.locator('.react-flow__edge').count();
            const settled = edges === lastEdges;
            lastEdges = edges;
            return settled ? true : undefined;
          }, 10_000);
          result.detail = await frame.evaluate(readDetail);
          await page.screenshot({
            path: join(manifest.out, 'png', `${render.key}-detail.png`),
          });
          await frame
            .getByRole('button', { name: 'Objects', exact: true })
            .first()
            .click()
            .catch(() => undefined);
        } else result.detail = null;
      }
      page.off('console', onConsole);
      result.consoleErrors = pageErrors;
      writeFileSync(
        join(manifest.out, 'renders', `${render.key}.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(`[ai-preview] ${render.key}: ${result.error ?? 'rendered'}`);
    }
  });
});
