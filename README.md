# AI Orchestrator

A board-driven AI dev team. Cards on a Trello, Azure DevOps or Jira board
dispatch role agents (DEV-FE, DEV-BE, QA, PM, DEVOPS); each agent runs Claude
Code headlessly in its own git worktree, the orchestrator verifies the result,
pushes a branch, opens a draft PR (GitHub or Azure Repos) and reports back on
the card. A read-only 2D office shows who is working on what. Setting up each
board and repo host is in `docs/providers.md`.

> **Status:** phases 0–4 done; phase 5 (all five roles, webhook delivery, the
> Docker driver) is built and green but not yet live-proven. Milestone 1 is met:
> two Trello cards have gone from **Ready for Dev** to a reviewed draft PR
> unattended. Milestone 2 is the live runs listed in `docs/roadmap.md`.

## Quick start

```sh
corepack enable                          # honours packageManager in package.json
pnpm install
cp .env.example .env                     # TRELLO_MAIN_API_KEY / TRELLO_MAIN_TOKEN (+ optional ANTHROPIC_API_KEY)
gh auth setup-git                        # pushes use git credentials wired to gh
pnpm orchestrator boards                 # your boards, and your member id → board.botMemberId
pnpm orchestrator init-board "My Board"  # optional: creates the standard columns + labels
cp orchestrator.example.yaml orchestrator.yaml   # fill boardId / botMemberId / repo paths
pnpm orchestrator doctor                 # toolchain, auth, config, target repos
pnpm build                               # server + office client
pnpm orchestrator start                  # daemon + office at http://127.0.0.1:7777
```

Move a card with the `be` label into **Ready for Dev** and watch the office.

## Commands

| Command                                                      | What it does                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `start`                                                      | Daemon: poll boards, dispatch agents, write back, serve the office (`--no-server` / `--no-webhook` to skip either) |
| `serve`                                                      | Office UI only, over the existing database                                                                         |
| `status`                                                     | Queue, cursors and outbox from the local database                                                                  |
| `run-task -p <project> -t <title> -s <spec>`                 | One task end to end with no board (`--dry-run` skips push/PR)                                                      |
| `smoke [--cancel <ms>]`                                      | Cheap live check of the Agent SDK driver and the cancel ladder                                                     |
| `webhooks list\|register\|delete`                            | Manage board-side push registrations (see `docs/webhooks.md`)                                                      |
| `doctor` · `boards` · `lists <id>` · `whoami` · `init-board` | Setup helpers; `--provider trello\|azure-devops\|jira`, see `docs/providers.md`                                    |

## How a card becomes a PR

1. **Poll → route.** The Trello actions feed yields exact transitions
   (`listBefore`/`listAfter`, actor). The router dispatches only on _arrival_
   in a routed column — edits and comments never fire — and writes the ledger
   row and the task in one transaction. Our own writeback echoes are dropped.
2. **Worktree.** The dispatcher claims the task, branches from
   `origin/<base>` into a short path under `worktreeRoot`, copies `.env`-style
   includes and installs dependencies.
3. **Agent.** Claude Code runs via the Agent SDK with the target repo's own
   settings/MCP _not_ loaded. A PreToolUse hook confines writes to the
   worktree and blocks `git push`, network tools and history rewriting. An
   in-process `mcp__board__*` server carries progress, blockers and the final
   `propose_summary`, which the target repo's own commitlint validates.
4. **Verify → publish.** The orchestrator runs the verify command itself
   (one retry in the same session), scans the staged diff for secrets, commits
   with a bot identity, pushes, opens a **draft PR**, and posts the report on
   the card through a crash-safe outbox.

## Layout

| Path             | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `src/config/`    | env + YAML loading, zod-validated, frozen, credential refs            |
| `src/board/`     | `BoardSource` abstraction; Trello, Azure DevOps, Jira sources; outbox |
| `src/router/`    | event → dispatch: arrival detection, dedupe key, loop guard           |
| `src/db/`        | SQLite store with CAS task transitions                                |
| `src/exec/`      | `ExecDriver` — runs Claude Code via the Agent SDK                     |
| `src/policy/`    | PreToolUse guard, bash allowlist, role tool policies, secrets         |
| `src/mcp/`       | in-process board tools exposed to the agent                           |
| `src/workspace/` | git worktree lifecycle                                                |
| `src/pipeline/`  | verify → commit → push → draft PR (GitHub, Azure Repos) → report      |
| `src/scheduler/` | task lifecycle and the daemon                                         |
| `src/server/`    | Fastify + SSE state projection                                        |
| `web/`           | Vite + canvas office client                                           |
| `docs/`          | roadmap and conventions                                               |

## Conventions

Conventional Commits with a closed scope list (`commitlint.config.mjs`),
Husky + lint-staged, ESLint flat config + Prettier, Vitest with co-located
`*.test.ts`. LF line endings are enforced by `.gitattributes`.
