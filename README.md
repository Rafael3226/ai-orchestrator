# AI Orchestrator

A board-driven AI dev team. Cards on a Trello board dispatch role agents
(DEV-FE, DEV-BE, QA, PM, DEVOPS); each agent runs Claude Code headlessly in
its own git worktree, the orchestrator verifies the result, pushes a branch,
opens a draft PR and reports back on the card. A read-only 2D office shows
who is working on what.

> **Status:** Phase 1 — scaffold. See `docs/roadmap.md`.

## Quick start

```sh
corepack enable                     # honours packageManager in package.json
pnpm install
cp .env.example .env                # fill in credentials
cp orchestrator.example.yaml orchestrator.yaml
pnpm orchestrator doctor            # checks toolchain, credentials and config
```

## Layout

| Path             | Purpose                                                 |
| ---------------- | ------------------------------------------------------- |
| `src/config/`    | env + YAML loading, zod-validated, frozen               |
| `src/board/`     | `BoardSource` / writer abstraction; Trello first        |
| `src/queue/`     | SQLite store, task state machine, scheduler             |
| `src/exec/`      | `ExecDriver` — runs Claude Code via the Agent SDK       |
| `src/workspace/` | git worktree lifecycle                                  |
| `src/pipeline/`  | verify → commit → push → draft PR → board writeback     |
| `src/server/`    | Fastify + SSE feeding the office                        |
| `web/`           | Vite + canvas office client                             |
| `docs/`          | roadmap and conventions (mirrored by `.claude/skills/`) |

## Conventions

Conventional Commits with a closed scope list (`commitlint.config.mjs`),
Husky + lint-staged, ESLint flat config + Prettier, Vitest with co-located
`*.test.ts`. LF line endings are enforced by `.gitattributes`.
