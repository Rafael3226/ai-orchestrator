# Roadmap

| Phase | Deliverable                                                                 | Status |
| ----- | --------------------------------------------------------------------------- | ------ |
| 0     | Unblock git (stray `D:\Repos\.git` moved to backup), init this repo         | done   |
| 1     | Scaffold: tooling, env + YAML config schema, CLI skeleton, `doctor`         | done   |
| 2     | Execution spine: worktrees, `LocalDriver`, policy hooks, pipeline, SQLite   | done   |
| 3     | Board integration: fake source, Trello client + poller, router, outbox, MCP | done   |
| 4     | Office UI: Fastify + SSE + Vite canvas                                      | done   |
| 5     | Breadth: remaining roles, Docker driver, webhooks                           | built  |
| 6     | ADO / Jira boards, Azure Repos PRs (polling; see `docs/providers.md`)       | built  |

**Milestone 1 — a real card to a real draft PR — is met.** Two `be` cards on the
live board dispatched DEV-BE, verified, pushed and opened draft PRs without a
hand on the wheel: a slugify utility and a Redis readiness check, both against
`ai-auto-apply`. The fixes the two runs turned up (quote-aware bash guard, MSYS
`cd` paths, label rejection surfaced instead of swallowed, office asset serving
and canvas layout) are in.

**Phase 5 is built and green, and not yet live-proven.** Three of its four items
shipped; ADO / Jira moved to its own row rather than being half-started.

- **Remaining roles.** DEV-FE, QA, PM and DEVOPS are wired end to end. The
  blocker was that the pipeline hardcoded a code-producing outcome in four
  places, so a PM that wrote a good spec and a QA that correctly found nothing
  to change both landed in `failed` with `nothing-to-commit`. A per-role
  delivery policy (`src/policy/delivery.policy.ts`) now decides whether a run
  ends in a pull request or on the board, whether an empty diff is a failure,
  what it verifies with, and which paths it may write. Writeback became
  per-role, and one role's move can hand the card to the next.
  See `docs/conventions/roles.md`.
- **Webhooks.** Trello push delivery, buffered by a decorator and drained by the
  existing `poll()`, exactly as `board.source.ts` always said it would be. The
  cursor still only advances from a real poll, which is what lets the buffer
  live in memory. See `docs/webhooks.md`.
- **Docker driver.** Host-side SDK client, container-side CLI, bridged by
  `docker run -i`. The in-process board server and the guard hooks keep working
  untouched. See `docs/docker.md`.

**Still to do for phase 5: the live runs.** Milestone 2 is not met until each of
these has happened unattended against the live board, and is written up here the
way Milestone 1 was:

1. A `fe` card dispatching DEV-FE to a draft PR.
2. An `infra` card dispatching DEVOPS, with an empty _Guard denials_ section.
3. QA reviewing a branch, changing nothing, and finishing `review` — the run
   that proves `nothing-to-commit` is no longer a failure.
4. DEV-BE finishing and its own move waking QA, with no human touching the board.
5. A `needs-spec` card dispatching PM: no install, no verify, no branch, no PR.
6. A card dragged to **Ready for Dev** dispatching in seconds via webhook, with
   the writeback echoes not looping and the poller still covering a dead tunnel.
7. A card dispatched to a containerized agent that produces a draft PR, leaving
   no container behind.

Design decisions and their rationale live in the plan that produced this repo;
the short version of each is recorded in `docs/decisions.md` as it lands.
