import type { ProjectConfig, ResolvedExec } from '../config/config.loader.js';
import type { Role } from '../config/config.schema.js';

import { DockerDriver } from './docker/docker.driver.js';
import type { DriverKind, ExecDriver } from './exec.driver.js';
import { LocalDriver } from './local.driver.js';

export interface DriverFactoryOptions {
  /** Identifies this daemon boot, so the container sweep can spot orphans. */
  readonly bootId: string;
  readonly log?: (msg: string) => void;
}

export function createDriver(exec: ResolvedExec, opts: DriverFactoryOptions): ExecDriver {
  if (exec.driver === 'docker') {
    return new DockerDriver({
      cfg: exec.docker,
      bootId: opts.bootId,
      ...(opts.log ? { log: opts.log } : {}),
    });
  }
  return new LocalDriver();
}

/**
 * One driver per distinct (kind, image) across every project and role, so a
 * daemon running three projects on the same image preflights once rather than
 * three times.
 */
export class DriverRegistry {
  private readonly drivers = new Map<string, ExecDriver>();

  constructor(private readonly opts: DriverFactoryOptions) {}

  for(project: ProjectConfig, role: Role): ExecDriver {
    const exec = project.agents[role].exec;
    const key = exec.driver === 'docker' ? `docker:${exec.docker.image}` : 'local';
    let driver = this.drivers.get(key);
    if (!driver) this.drivers.set(key, (driver = createDriver(exec, this.opts)));
    return driver;
  }

  kinds(): readonly DriverKind[] {
    return [...new Set([...this.drivers.values()].map((d) => d.kind))];
  }

  /** Preflight every driver built so far; call after the registry is warm. */
  async preflightAll(): Promise<void> {
    for (const driver of this.drivers.values()) await driver.preflight();
  }

  /** Build a driver for every enabled role so preflight covers them all. */
  warm(projects: readonly ProjectConfig[], roles: readonly Role[]): void {
    for (const project of projects) {
      if (!project.enabled) continue;
      for (const role of roles) {
        if (project.agents[role].enabled) this.for(project, role);
      }
    }
  }
}
