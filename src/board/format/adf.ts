/**
 * Jira Cloud REST v3 speaks Atlassian Document Format (ADF) for descriptions
 * and comments. We read ADF as markdown (the agent's spec, and the writer's
 * comment dedupe marker) and write our markdown reports back as ADF.
 *
 * Inline code round-trips as backticks. That matters: the writer finds its
 * own comment by the marker `` run `taskId` ``.
 */

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  readonly content?: readonly AdfNode[];
}

export interface AdfDoc extends AdfNode {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfNode[];
}

// ── ADF → markdown ──────────────────────────────────────────────────────

export function adfToMarkdown(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc; // REST v2 or a plain-text field
  return blocks((doc as AdfNode).content ?? [], '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blocks(nodes: readonly AdfNode[], indent: string): string {
  return nodes.map((n) => block(n, indent)).join('');
}

function block(n: AdfNode, indent: string): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case 'paragraph':
      return `${indent}${inlines(kids)}\n\n`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 1)));
      return `${'#'.repeat(level)} ${inlines(kids)}\n\n`;
    }
    case 'codeBlock':
      return '```' + String(n.attrs?.['language'] ?? '') + '\n' + plain(kids) + '\n```\n\n';
    case 'blockquote':
      return (
        blocks(kids, '')
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n') + '\n\n'
      );
    case 'bulletList':
    case 'orderedList': {
      const lines = kids.map((item, i) => {
        const bullet = n.type === 'orderedList' ? `${i + 1}.` : '-';
        const body = blocks(item.content ?? [], `${indent}  `).trim();
        return `${indent}${bullet} ${body.replace(/^\s+/, '')}`;
      });
      return `${lines.join('\n')}\n\n`;
    }
    case 'rule':
      return '---\n\n';
    case 'table':
      return (
        kids
          .map(
            (row) =>
              `| ${(row.content ?? []).map((c) => blocks(c.content ?? [], '').trim()).join(' | ')} |`,
          )
          .join('\n') + '\n\n'
      );
    case 'panel':
    case 'expand':
    case 'nestedExpand':
      return blocks(kids, indent);
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]\n\n';
    default:
      return kids.length ? blocks(kids, indent) : n.text ? `${n.text}\n\n` : '';
  }
}

function inlines(nodes: readonly AdfNode[]): string {
  return nodes.map(inlineNode).join('');
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return applyMarks(n.text ?? '', n.marks ?? []);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(n.attrs?.['text'] ?? '@user');
    case 'emoji':
      return String(n.attrs?.['text'] ?? n.attrs?.['shortName'] ?? '');
    case 'inlineCard':
      return String(n.attrs?.['url'] ?? '');
    default:
      return n.content ? inlines(n.content) : (n.text ?? '');
  }
}

function applyMarks(text: string, marks: NonNullable<AdfNode['marks']>): string {
  let out = text;
  for (const m of marks) {
    if (m.type === 'code') out = '`' + out + '`';
    else if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `_${out}_`;
    else if (m.type === 'strike') out = `~~${out}~~`;
    else if (m.type === 'link') out = `[${out}](${String(m.attrs?.['href'] ?? '')})`;
  }
  return out;
}

function plain(nodes: readonly AdfNode[]): string {
  return nodes.map((n) => n.text ?? (n.content ? plain(n.content) : '')).join('');
}

// ── markdown → ADF ──────────────────────────────────────────────────────

/**
 * Enough markdown for our own reports: headings, paragraphs, bullet and
 * numbered lists, fenced code, rules, and inline code / bold / italic / links.
 * Anything else survives as text.
 */
export function markdownToAdf(md: string): AdfDoc {
  // Jira shows inline HTML literally; our reports only use it for <sub> footers.
  const lines = md
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?(sub|sup|br)\s*\/?>/gi, '')
    .split('\n');
  const content: AdfNode[] = [];
  let para: string[] = [];

  const flush = (): void => {
    if (para.length) content.push({ type: 'paragraph', content: inlineAdf(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i] ?? ''); i++)
        code.push(lines[i] ?? '');
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: code.length ? [{ type: 'text', text: code.join('\n') }] : [],
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      content.push({
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: inlineAdf(heading[2] ?? ''),
      });
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      content.push({ type: 'rule' });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1] ?? '');
      const items: AdfNode[] = [];
      for (; i < lines.length; i++) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? '');
        if (!m || /\d/.test(m[1] ?? '') !== ordered) break;
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineAdf(m[2] ?? '') }],
        });
      }
      i--;
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return { type: 'doc', version: 1, content };
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(_[^_\s][^_]*_)/g;

function inlineAdf(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  const pushText = (t: string): void => {
    const parts = t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (p) out.push({ type: 'text', text: p });
    });
  };
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(text.slice(last, idx));
    const tok = m[0];
    if (m[1]) out.push({ type: 'text', text: tok.slice(1, -1), marks: [{ type: 'code' }] });
    else if (m[2]) out.push({ type: 'text', text: tok.slice(2, -2), marks: [{ type: 'strong' }] });
    else if (m[3]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      out.push({
        type: 'text',
        text: link?.[1] ?? tok,
        marks: [{ type: 'link', attrs: { href: link?.[2] ?? '' } }],
      });
    } else out.push({ type: 'text', text: tok.slice(1, -1), marks: [{ type: 'em' }] });
    last = idx + tok.length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}
