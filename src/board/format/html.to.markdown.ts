/**
 * Azure DevOps stores rich text (`System.Description`, comments) as HTML. The
 * agent reads the description as its spec, so it gets markdown: this covers
 * the subset the ADO editor produces, and anything else degrades to its text.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#') && lower !== '#39')
      return String.fromCodePoint(Number(lower.slice(1)));
    return ENTITIES[lower] ?? m;
  });
}

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return '';
  let s = html.replace(/\r\n?/g, '\n');

  // Code blocks first, so nothing below rewrites their contents.
  const blocks: string[] = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const code = decodeEntities(stripTags(body.replace(/<br\s*\/?>/gi, '\n'))).replace(/\n+$/, '');
    blocks.push('```\n' + code + '\n```');
    // A private-use code point: it cannot occur in the HTML we convert.
    return `\n\n${blocks.length - 1}\n\n`;
  });

  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => {
      return `\n\n${'#'.repeat(Number(n))} ${inline(t).trim()}\n\n`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  s = convertLists(s);

  s = s
    .replace(/<\/(p|div|table|blockquote)>/gi, '\n\n')
    .replace(/<(p|div|table|blockquote)[^>]*>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<tr[^>]*>/gi, '| ');

  s = inline(s);
  s = decodeEntities(stripTags(s));
  s = s.replace(/(\d+)/g, (_m, i: string) => blocks[Number(i)] ?? '');

  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(s: string): string {
  return s
    .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, _a, t: string) => wrap('**', t))
    .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, _a, t: string) => wrap('_', t))
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => '`' + stripTags(t) + '`')
    .replace(
      /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, t: string) => {
        const text = stripTags(t).trim();
        return !text || text === href ? href : `[${text}](${href})`;
      },
    )
    .replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, src: string) => `![image](${src})`);
}

function wrap(mark: string, t: string): string {
  const inner = t.trim();
  return inner ? `${mark}${inner}${mark}` : '';
}

/** Innermost list first, so nested lists indent under their parent item. */
function convertLists(s: string): string {
  const re = /<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[\s>])[\s\S])*?)<\/\1>/i;
  for (let guard = 0; guard < 100 && re.test(s); guard++) {
    s = s.replace(re, (_m, kind: string, body: string) => {
      let n = 0;
      const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => {
        n += 1;
        const bullet = kind.toLowerCase() === 'ol' ? `${n}.` : '-';
        const text = inline(m[1] ?? '')
          .replace(/<(p|div)[^>]*>|<\/(p|div)>/gi, '')
          .trim()
          .split('\n')
          .map((line, i) => (i === 0 ? line : `  ${line}`))
          .join('\n');
        return `${bullet} ${text}`;
      });
      return `\n\n${items.join('\n')}\n\n`;
    });
  }
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
