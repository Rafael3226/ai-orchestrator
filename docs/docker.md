# The Docker driver

Runs the agent in a container instead of on the host.

```yaml
exec:
  driver: docker
  docker:
    image: ai-orchestrator/agent:latest
```

Set it under `defaults.exec`, per project (`projects[].exec`), or per role
(`projects[].agents.<ROLE>.docker`). Narrower wins, key by key.

## Where the boundary actually is

```
  orchestrator process (host)              container
  ─────────────────────────────            ──────────────────────
  Agent SDK client                         claude CLI
  board MCP server  ──┐                    Bash / Edit / Read
  PreToolUse guards ──┼── stdio control ──▶ pnpm install
  SQLite, Trello token│   protocol          pnpm test
  git commit/push, gh ┘                    git status / add
```

The SDK client stays on the host and the CLI runs in the container, bridged by
`docker run -i` through the SDK's `spawnClaudeCodeProcess` hook.

That split is deliberate. The board MCP server and the guard hooks are plain JS
objects handed to the SDK, driven over the stdio control protocol rather than
serialized. Keeping the client host-side means `report_progress`,
`propose_summary`, the path guard and the bash guard all keep working with no new
RPC surface, no auth story for a port the agent can reach, and no settings file
written into the image.

**What it costs**, plainly:

- `Options.stderr` never fires under a custom spawner, so the driver pumps the
  container's stderr into the event sink itself.
- The image's CLI is not the CLI the SDK bundles. Pinned at build time and
  checked by `orchestrator image check` and `doctor`; a mismatch typically looks
  like a run that stalls right after `init`.
- ~1–3s of container start per attempt.
- **The container protects the host from the agent. It does not protect the
  orchestrator**, which still holds the board token and `gh`. This is a
  blast-radius boundary, not a security milestone.

## The git worktree problem

A worktree's `.git` is a _file_ containing `gitdir: D:/repo/.git/worktrees/<name>`.
Bind-mounting only the worktree hands the container a dangling Windows path and
every git command fails.

We never rewrite that file — the host publisher reads it moments later to stage,
commit and push. Instead:

```
--mount type=bind,source=<worktree>,target=/work
--mount type=bind,source=<repo>\.git,target=/gitcommon
-e GIT_DIR=/gitcommon/worktrees/<name>  -e GIT_WORK_TREE=/work
```

`GIT_DIR` short-circuits discovery so the `.git` file is never read, and
`<gitdir>/commondir` is the relative `../..`, which resolves to `/gitcommon`.

Consequences worth knowing:

- `/gitcommon` is **read-write**: `git status` refreshes and `git add` writes
  `<gitdir>/index`. That shared index is exactly what lets the host commit what
  the container staged.
- The index is now written from two operating systems. Stat data recorded by
  Linux does not match Windows, so the host's next `git status` re-hashes the
  tree. Correct, just not free.
- Submodules do not work under a pinned `GIT_DIR`.
- `git worktree list/prune` would read a stale path — `bash.guard` denies both.

## Windows specifics

| Trap                                                               | Handling                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dubious ownership / file mode (bind mounts surface as uid 0, 0777) | `safe.directory=*` and `core.fileMode=false` via `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` — no file written                                                  |
| CRLF checkout                                                      | `worktree add` runs with `-c core.autocrlf=false -c core.eol=lf` when the driver is docker, otherwise the Linux container lints and `exec`s CRLF scripts |
| MSYS rewriting `/work`                                             | docker is spawned with `shell: false` plus `MSYS2_ARG_CONV_EXCL=*`                                                                                       |
| A drive Docker Desktop will not share                              | `doctor` actually bind-mounts each `worktreeRoot` rather than guessing                                                                                   |
| Backend                                                            | WSL2. Hyper-V's shared-drive model needs the drive added by hand and is slower                                                                           |

**Bind-mount I/O is the real Windows tax.** `nodeModulesVolume: true` keeps
`node_modules` on a Docker volume, off the bind mount. Turn it **off** for a
pnpm-workspace monorepo, whose `node_modules` is not a single directory.

## Install and verify move into the container

Not for speed — for correctness. A host `pnpm install` produces win32 native
binaries (`better-sqlite3`, `esbuild`) that a Linux container cannot load. Under
the docker driver, `checks.install`, the verification command and the target
repo's `commitlint` all run in a one-shot container with the same mount, env and
limit recipe as the agent's.

## Credentials

| Secret                                  | Where                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / OAuth token       | **Into the container**, as `-e NAME` with no value — docker inherits it from its own environment, so it never reaches argv, logs or `docker inspect` |
| git push credentials, `gh` / `GH_TOKEN` | **Host only.** The publisher runs host-side; `gh` is not in the image and `bash.guard` denies it                                                     |
| Trello token, `ORCHESTRATOR_DB`         | **Host only.** The board server runs in-process                                                                                                      |

`buildContainerEnv` is an **allowlist**, not a filter: only `AGENT_ENV`, model
auth, the `HOME`/`GIT_*` vars we set, and keys the SDK injected that the host
lacked. A test asserts a sentinel host variable never appears.

Note `.env` files: `include.copier` deliberately copies real secrets into the
worktree, and the worktree is the mount. The agent can read them, exactly as it
can under the local driver.

## The guards still apply

The container is a blast-radius boundary, not a semantic one. `/gitcommon` is
writable, and the `FORBIDDEN_WRITE` list protects `.git`, `.env`, `node_modules`
and `.husky` _inside_ the mount. `bash.guard`'s reasons — repo integrity,
exfiltration — are unchanged.

What does change is dialect: the guards run on the host but judge container
paths, so they switch to `mode: 'posix'` (see `path.guard.ts`). Accepted
limitation: a symlink planted inside `/work` pointing out of it is not caught
host-side; `--cap-drop ALL` and the mount set contain that.

## Network

`--network none` is **not** viable by default — the CLI must reach
`api.anthropic.com` and installs must reach the registry. Default is `bridge`.
Use `none` for roles that never install anything, or a user-defined network plus
an `HTTPS_PROXY` allowlist for real egress control.

## Building the image

```sh
pnpm orchestrator image build   # pins the CLI to the version the SDK bundles
pnpm orchestrator image check   # warns on drift between image CLI and SDK
pnpm orchestrator doctor        # daemon, Linux mode, image, mount probe, model auth
```

The image is `node:22-bookworm-slim` (glibc — musl breaks the CLI's native
binary), non-root uid 1000, and deliberately ships **no gh, ssh, curl or wget**,
so the bash guard's denials are structural rather than merely a rule.

## Cleanup

`--rm` covers the happy path. A daemon crash, a Docker Desktop restart or a
killed `docker run` client all leave a container running, so every container
carries `aiorch.daemon=<bootId>` and the daemon sweeps by label at boot. A
`cancel` always names the **container**, never just the pipe — killing the client
alone is where orphans come from.

## Trying it

```sh
pnpm orchestrator smoke --driver docker          # one turn through the pipe
pnpm orchestrator run-task -p <id> -t "..." --driver docker --dry-run
pnpm test:docker                                 # the live lane, needs a daemon
```
