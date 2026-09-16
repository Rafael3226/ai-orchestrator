#!/usr/bin/env node
import { Command } from 'commander';

import { runDoctor } from './cli/doctor.js';
import { loadDotEnv } from './config/load-env.js';

loadDotEnv();

const program = new Command()
  .name('orchestrator')
  .description('Board-driven AI dev team: role agents running Claude Code in isolated worktrees')
  .version('0.1.0');

program
  .command('doctor')
  .description('Check toolchain, credentials, config and target repos')
  .action(() => {
    process.exitCode = runDoctor();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
