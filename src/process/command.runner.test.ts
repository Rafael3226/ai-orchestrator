import { describe, expect, it } from 'vitest';

import { runCommand, runOrThrow } from './command.runner.js';

describe('runCommand', () => {
  it('captures output and exit code', async () => {
    const r = await runCommand(process.execPath, ['-e', 'console.log("hi"); process.exit(3)'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe('hi');
    expect(r.timedOut).toBe(false);
  });

  it('feeds stdin when input is given', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      input: 'from-stdin',
    });
    expect(r.stdout).toBe('from-stdin');
  });

  it('enforces the wall clock', async () => {
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
  });

  it('runOrThrow throws on non-zero exit', async () => {
    await expect(
      runOrThrow(process.execPath, ['-e', 'process.exit(1)'], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited with 1/);
  });
});
