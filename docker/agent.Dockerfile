# The image an agent runs in under `exec.driver: docker`.
#
# bookworm-slim, not alpine: the Claude Code CLI ships a glibc native binary and
# fails to start on musl.
FROM node:22-bookworm-slim

# Pinned so the CLI in the image matches the control protocol the SDK speaks.
# `orchestrator image check` compares this against the SDK's bundled version.
ARG CLAUDE_CLI_VERSION=latest
ARG PNPM_VERSION=10.14.0

# Deliberately absent: gh, ssh, curl, wget. The bash guard denies all of them,
# and leaving them out of the image makes that structural rather than a rule.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git \
       ca-certificates \
       ripgrep \
       jq \
       less \
       tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
  && npm cache clean --force

# uid 1000 matches the default `user:` in the docker config block.
RUN useradd --create-home --uid 1000 --shell /bin/bash agent
USER agent

ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    PNPM_HOME=/home/agent/.local/share/pnpm \
    PATH=/home/agent/.local/share/pnpm:$PATH \
    CI=1

# Mount points; the orchestrator bind-mounts over these.
RUN mkdir -p /home/agent/.claude /home/agent/.local/share/pnpm/store
WORKDIR /work

LABEL org.aiorch.cli-version=$CLAUDE_CLI_VERSION
LABEL org.aiorch.pnpm-version=$PNPM_VERSION

ENTRYPOINT ["/usr/bin/tini", "--"]
