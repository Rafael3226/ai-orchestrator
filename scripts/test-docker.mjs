// Runs the Docker live-lane tests, which are skipped unless AIORCH_DOCKER_E2E
// is set. Kept as a script so the env var works the same on Windows and POSIX
// without pulling in cross-env.
import { spawn } from 'node:child_process';

const child = spawn('vitest', ['run', 'src/exec/docker', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, AIORCH_DOCKER_E2E: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
