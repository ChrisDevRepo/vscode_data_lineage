/**
 * Markdown/math parity corpus — the cases an AI-authored description must survive on the way to a
 * rendered surface.
 *
 * @remarks
 * The Copilot chat window renders the model's bytes through `marked` + the vendored
 * `markedKatexExtension` + DOMPurify with no pre-render text handling. Our React overlay renders the
 * same bytes through the same code, so any transform we apply between the tool call and the renderer
 * must be invisible in the rendered HTML. Every case here is exercised twice: once for what the
 * renderer produces, and once for that invisibility invariant.
 *
 * Classes cover the KaTeX single-dollar delimiter bug (KaTeX#1830), marked's backslash tokenisation
 * gap (marked#3434), and the escaping states a model reaches through JSON tool arguments.
 */

/** One corpus entry. */
export interface MathParityCase {
  /** Class name, used as the test title. */
  readonly name: string;
  /** Markdown as the model authored it. */
  readonly markdown: string;
}

/** The corpus, in class order. */
export const MATH_PARITY_CASES: readonly MathParityCase[] = [
  // 1. Inline math whose macro starts with a literal backslash + n.
  { name: 'inline math with \\neq', markdown: 'Totals differ when $\\text{Net} \\neq \\text{Gross}$ holds.' },
  { name: 'inline math with \\not and \\nabla', markdown: 'Cases $a \\not\\subset b$ and $\\nabla f$ both apply.' },
  { name: 'inline math with \\ne', markdown: 'Rows where $x \\ne y$ are rejected.' },

  // 2. Inline math with other macros.
  { name: 'inline math with \\times', markdown: 'Line value is $Qty \\times Price$ per row.' },
  { name: 'inline math with \\operatorname', markdown: 'Nulls fold via $\\operatorname{COALESCE}(a, 0)$.' },
  { name: 'inline math with \\rightarrow', markdown: 'The hop is `A` $\\rightarrow$ `B`.' },

  // 3. Display math.
  { name: 'display math on its own lines', markdown: 'Before.\n\n$$\nNet = Qty \\times Price\n$$\n\nAfter.' },
  { name: 'display math inline-delimited', markdown: '$$ \\text{RawQty} = 0 $$' },
  { name: 'display math with \\neq', markdown: '$$\n\\text{Net} \\neq \\text{Gross}\n$$' },

  // 4. Prose currency must stay prose.
  { name: 'currency amounts', markdown: 'A $5 fee and a $10 credit net out.' },
  { name: 'currency range', markdown: 'Between $20,000 and $30,000 per period.' },
  { name: 'abbreviated currency', markdown: 'A $5M write-down landed in Q3.' },

  // 5. Dollars inside code must stay literal.
  { name: 'dollar in an inline code span', markdown: 'The parameter `@Total = $x$` is literal.' },
  { name: 'dollar in a fenced block', markdown: '```sql\nSELECT $1, $\\neq$ AS lit\n```' },
  { name: 'dollar adjacent to word characters', markdown: 'Column A$B and cost5$ stay text.' },

  // 6. Unmatched delimiters.
  { name: 'a lone dollar', markdown: 'One $ sign alone in prose.' },
  { name: 'mismatched double-then-single', markdown: 'Text $$ x $ tail.' },
  { name: 'mismatched single-then-double', markdown: 'Text $x$$ tail.' },

  // 7. Escaped delimiter.
  { name: 'backslash-escaped dollar', markdown: 'A literal \\$5 amount.' },

  // 8. Math inside block structures.
  { name: 'math in a table cell', markdown: '| Rule | Formula |\n| --- | --- |\n| Net | $Qty \\times P$ |\n| Flag | $a \\neq b$ |' },
  { name: 'math in a list item', markdown: '- First $x \\neq y$\n- Second $\\nabla f$' },
  { name: 'math in a heading', markdown: '### Objects $x \\neq y$' },

  // 9. Escaping states of one paragraph.
  { name: 'real newlines', markdown: 'First line.\n\nSecond paragraph.' },
  { name: 'literal backslash-n', markdown: 'First line.\\n\\nSecond paragraph.' },
  { name: 'literal backslash-n beside inline math', markdown: 'Rule $a \\neq b$ applies.\\n\\nNext paragraph.' },

  // 9b. The reported spImportOrders rule: a `\not` macro in a block, after prose carrying literal \n.
  {
    name: 'spImportOrders IsValidated rule after literal backslash-n prose',
    markdown: 'Prose line one.\\nProse line two.\n\n'
      + '$$IsValidated := 1 \\quad \\text{when } ValidationMessage \\text{ is NULL } '
      + '\\lor ValidationMessage \\not\\text{ LIKE } \\%Unknown\\ region\\%$$',
  },

  // 10. Unparseable math degrades to source.
  { name: 'unparseable math', markdown: 'Broken $\\frac{1$ here.' },

  // 11. Sanitiser input.
  { name: 'script and handler injection', markdown: 'Text <script>alert(1)</script> and <img src=x onerror="alert(1)"> and [x](javascript:alert(1)).' },

  // 12. Engine-assembled link markup.
  { name: 'focus-node link beside math', markdown: '### Objects [dbo.Orders](#focus-node:dbo.Orders)\n\nWhere $x \\neq y$.' },

  // 14. Non-Latin text adjacent to a delimiter.
  { name: 'CJK and emoji beside math', markdown: '合計 $x \\neq y$ 🎯 done.' },
];
