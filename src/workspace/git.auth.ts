import type { ProjectConfig } from '../config/config.loader.js';

/**
 * Per-invocation git auth for hosts that are not wired to a credential helper.
 *
 * Azure Repos: the PAT goes in an `http.<url>.extraheader`, set through
 * GIT_CONFIG_COUNT/KEY/VALUE env vars so it never appears in argv (and so in
 * no process listing), is scoped to Azure DevOps URLs only, and never touches
 * the repo's config. Without a PAT in the environment git falls back to
 * whatever credential helper the host has (Git Credential Manager).
 *
 * GitHub keeps using `gh auth setup-git`, so it needs nothing here.
 */
export function gitAuthEnv(
  project: Pick<ProjectConfig, 'repo'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const host = project.repo.host;
  if (host.provider !== 'azure-devops') return {};
  const pat = env[`${host.credentials}_PAT`];
  if (!pat) return {};
  const header = `Authorization: Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const urls = ['https://dev.azure.com/', `https://${host.organization}.visualstudio.com/`];
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(urls.length) };
  urls.forEach((url, i) => {
    out[`GIT_CONFIG_KEY_${i}`] = `http.${url}.extraheader`;
    out[`GIT_CONFIG_VALUE_${i}`] = header;
  });
  return out;
}

/** What to tell a human when a push is refused for auth. */
export function pushAuthHint(project: Pick<ProjectConfig, 'repo'>): string {
  const host = project.repo.host;
  return host.provider === 'azure-devops'
    ? `set ${host.credentials}_PAT to a PAT with Code (read & write) on ${host.organization}`
    : 'run `gh auth setup-git`';
}
