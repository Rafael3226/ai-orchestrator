# Roadmap

| Phase | Deliverable                                                                 | Status |
| ----- | --------------------------------------------------------------------------- | ------ |
| 0     | Unblock git (stray `D:\Repos\.git` moved to backup), init this repo         | done   |
| 1     | Scaffold: tooling, env + YAML config schema, CLI skeleton, `doctor`         | done   |
| 2     | Execution spine: worktrees, `LocalDriver`, policy hooks, pipeline, SQLite   | done   |
| 3     | Board integration: fake source, Trello client + poller, router, outbox, MCP | done   |
| 4     | Office UI: Fastify + SSE + Vite canvas                                      | done   |
| 5     | Breadth: remaining roles, Docker driver, webhooks, ADO / Jira               |        |

Design decisions and their rationale live in the plan that produced this repo;
the short version of each is recorded in `docs/decisions.md` as it lands.
