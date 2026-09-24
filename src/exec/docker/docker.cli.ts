import { runCommand, type CommandResult } from '../../process/command.runner.js';

export interface DockerCliOptions {
  /** DOCKER_HOST override; empty means the daemon's default. */
  readonly host?: string;
  readonly timeoutMs?: number;
}

/**
 * Thin, injectable wrapper around the `docker` binary. Always `shell: false`,
 * so a Windows path in a `--mount` is never touched by MSYS.
 */
export class DockerCli {
  constructor(
    private readonly opts: DockerCliOptions = {},
    private readonly run = runCommand,
  ) {}

  exec(args: readonly string[], timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<CommandResult> {
    const full = this.opts.host ? ['--host', this.opts.host, ...args] : [...args];
    return this.run('docker', full, {
      cwd: process.cwd(),
      timeoutMs,
      shell: false,
      // MSYS would otherwise rewrite /work-shaped arguments on a Windows host.
      env: { MSYS2_ARG_CONV_EXCL: '*' },
    });
  }

  async version(): Promise<CommandResult> {
    return this.exec(['version', '--format', '{{json .}}'], 15_000);
  }

  async info(): Promise<CommandResult> {
    return this.exec(['info', '--format', '{{json .}}'], 20_000);
  }

  async imageInspect(image: string): Promise<CommandResult> {
    return this.exec(['image', 'inspect', image, '--format', '{{json .Config.Labels}}'], 20_000);
  }

  async pull(image: string): Promise<CommandResult> {
    return this.exec(['pull', image], 15 * 60_000);
  }

  async ps(label: string): Promise<CommandResult> {
    return this.exec(['ps', '-a', '--filter', `label=${label}`, '--format', '{{json .}}']);
  }

  async rm(container: string): Promise<CommandResult> {
    return this.exec(['rm', '-f', container]);
  }

  async stop(container: string, seconds = 10): Promise<CommandResult> {
    return this.exec(['stop', '-t', String(seconds), container], (seconds + 10) * 1000);
  }

  async kill(container: string): Promise<CommandResult> {
    return this.exec(['kill', container], 20_000);
  }

  async volumeLs(label: string): Promise<CommandResult> {
    return this.exec(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{json .}}']);
  }

  async volumeRm(name: string): Promise<CommandResult> {
    return this.exec(['volume', 'rm', '-f', name]);
  }
}
