/**
 * Load a local `.env` into `process.env` using Node 22's built-in loader, so
 * no dotenv dependency is needed. A missing file is expected in CI/prod where
 * variables are ambient, so that failure is swallowed.
 */
export function loadDotEnv(path?: string): void {
  try {
    if (path) {
      process.loadEnvFile(path);
    } else {
      process.loadEnvFile();
    }
  } catch {
    // No `.env` file — fall back to the ambient environment.
  }
}
