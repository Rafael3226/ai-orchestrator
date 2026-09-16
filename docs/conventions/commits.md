# Commits

Conventional Commits 1.0.0, enforced by `commitlint.config.mjs` on the
`commit-msg` hook.

- `type(scope): subject` — type from the closed list, scope from the closed
  list of modules (`config`, `board`, `trello`, `router`, `queue`, `exec`,
  `policy`, `mcp`, `workspace`, `pipeline`, `prompt`, `server`, `web`, `cli`,
  `docs`, `infra`, `ci`, `deps`, `repo`) or empty.
- Subject: imperative, lowercase, no trailing period, header ≤ 72 chars
  (hard limit 100).
- Body explains _why_, wrapped at 100.
- Stage deliberately (`git add <path>`); never `--no-verify`.
