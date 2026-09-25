import { describe, expect, it } from 'vitest';

import { renderBranchName, slugify, withCollisionSuffix } from './branch.namer.js';

describe('slugify', () => {
  it('folds accents, lowercases, collapses separators and truncates', () => {
    expect(slugify('Añadir paginación a /api/postings!')).toBe('anadir-paginacion-a-api-postings');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(slugify('---')).toBe('task');
  });
});

describe('renderBranchName', () => {
  it('renders the default template', () => {
    expect(
      renderBranchName({
        template: 'ai/{role}/{cardShortId}-{slug}',
        role: 'DEV',
        cardShortId: '142',
        cardTitle: 'Add pagination',
      }),
    ).toBe('ai/dev/142-add-pagination');
  });
});

describe('withCollisionSuffix', () => {
  it('appends -2, -3 on collisions', () => {
    const taken = new Set(['x', 'x-2']);
    expect(withCollisionSuffix('x', (c) => taken.has(c))).toBe('x-3');
    expect(withCollisionSuffix('y', (c) => taken.has(c))).toBe('y');
  });
});
