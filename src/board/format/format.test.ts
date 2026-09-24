import { describe, expect, it } from 'vitest';

import { adfToMarkdown, markdownToAdf } from './adf.js';
import { decodeEntities, htmlToMarkdown } from './html.to.markdown.js';

describe('htmlToMarkdown', () => {
  it('converts what the Azure DevOps editor produces', () => {
    const html =
      '<div><h2>Goal</h2><p>Add <b>pagination</b> to <code>/api/jobs</code>.</p>' +
      '<ul><li>page size 20</li><li>see <a href="https://x.test/spec">the spec</a></li></ul>' +
      '<ol><li>first</li><li>second</li></ol></div>';
    expect(htmlToMarkdown(html)).toBe(
      [
        '## Goal',
        '',
        'Add **pagination** to `/api/jobs`.',
        '',
        '- page size 20',
        '- see [the spec](https://x.test/spec)',
        '',
        '1. first',
        '2. second',
      ].join('\n'),
    );
  });

  it('keeps code blocks verbatim and decodes entities', () => {
    expect(htmlToMarkdown('<pre>if (a &lt; b) {<br>  x();<br>}</pre>')).toBe(
      '```\nif (a < b) {\n  x();\n}\n```',
    );
    expect(decodeEntities('&amp;&nbsp;&#39;&#x41;&quot;')).toBe('& \'A"');
  });

  it('handles empty input', () => {
    expect(htmlToMarkdown(undefined)).toBe('');
    expect(htmlToMarkdown('')).toBe('');
  });
});

describe('ADF', () => {
  it('reads a Jira description as markdown', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Call ' },
            { type: 'text', text: 'listJobs()', marks: [{ type: 'code' }] },
            { type: 'text', text: ' with ' },
            { type: 'text', text: 'paging', marks: [{ type: 'strong' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
            },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x()' }] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      '### Acceptance\n\nCall `listJobs()` with **paging**\n\n- a\n- b\n\n```ts\nx()\n```',
    );
  });

  it('passes plain strings through and tolerates null', () => {
    expect(adfToMarkdown('plain')).toBe('plain');
    expect(adfToMarkdown(null)).toBe('');
  });

  it('writes our report markdown as ADF', () => {
    const doc = markdownToAdf(
      '## Summary\n\nDid the **thing**, see [PR](https://x.test/pr/1).\n\n- one\n- two\n\n```\ncode\n```\n\n---',
    );
    expect(doc.type).toBe('doc');
    expect(doc.content.map((n) => n.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'codeBlock',
      'rule',
    ]);
    const para = doc.content[1]?.content ?? [];
    expect(para.find((n) => n.marks?.[0]?.type === 'strong')?.text).toBe('thing');
    expect(para.find((n) => n.marks?.[0]?.type === 'link')?.marks?.[0]?.attrs).toEqual({
      href: 'https://x.test/pr/1',
    });
  });

  it('round-trips the writer dedupe marker', () => {
    const marker = 'run `01J9ZTASK`';
    const back = adfToMarkdown(markdownToAdf(`Report\n\n<sub>${marker}</sub>`));
    expect(back).toContain(marker);
  });
});
