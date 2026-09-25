import type { Role } from '../config/config.schema.js';

export function slugify(input: string, max = 40): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export interface BranchNameInput {
  readonly template: string; // e.g. ai/{role}/{cardShortId}-{slug}
  readonly role: Role;
  readonly cardShortId: string;
  readonly cardTitle: string;
}

export function renderBranchName(input: BranchNameInput): string {
  return input.template
    .replace('{role}', input.role.toLowerCase())
    .replace('{cardShortId}', slugify(input.cardShortId, 20))
    .replace('{slug}', slugify(input.cardTitle));
}

/** `ai/dev/142-add-pagination`, then `-2`, `-3` … on collision. */
export function withCollisionSuffix(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`could not find a free branch name for ${base}`);
}
