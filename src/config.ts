export type AppSettings = {
  appEnv: string;
  appHost: string;
  appName: string;
  appPort: number;
};

const DEFAULT_PORT = 8000;

/**
 * Read application settings from environment variables.
 *
 * @param env - Environment mapping to read. Defaults to `process.env`.
 * @returns Runtime settings for the TypeScript application process.
 * @throws Error when `APP_PORT` or `PORT` is present but not a valid TCP port.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  return {
    appEnv: env.APP_ENV ?? "local",
    appHost: env.APP_HOST ?? "0.0.0.0",
    appName: env.APP_NAME ?? "agents-party",
    appPort: parsePort(env.PORT ?? env.APP_PORT, DEFAULT_PORT),
  };
}

/**
 * Parse a TCP port value from environment configuration.
 *
 * @param value - Raw port value from the environment.
 * @param fallback - Port to use when the raw value is absent.
 * @returns Valid TCP port number.
 * @throws Error when the value is not an integer between 1 and 65535.
 */
export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("APP_PORT or PORT must be an integer between 1 and 65535.");
  }
  return port;
}
