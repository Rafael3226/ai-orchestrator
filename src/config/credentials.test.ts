import { describe, expect, it, vi } from 'vitest';

import { resolveBoardCredentials } from './credentials.js';

describe('resolveBoardCredentials', () => {
  it('resolves <REF>_API_KEY and <REF>_TOKEN per ref', () => {
    const refs = new Map([['TRELLO_MAIN', ['p1']]]);
    const out = resolveBoardCredentials(refs, {
      TRELLO_MAIN_API_KEY: 'k',
      TRELLO_MAIN_TOKEN: 't',
    });
    expect(out.get('TRELLO_MAIN')).toEqual({ ref: 'TRELLO_MAIN', apiKey: 'k', token: 't' });
  });

  it('fails naming the project that needs the missing credential', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refs = new Map([['TRELLO_WORK', ['acts-portal']]]);
    expect(() => resolveBoardCredentials(refs, {})).toThrow(/board credentials/);
    expect(spy.mock.calls.flat().join('\n')).toMatch(/acts-portal/);
  });
});
