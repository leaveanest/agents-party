export type AppSettings = {
  appEnv: string;
  appHost: string;
  appName: string;
  appPort: number;
  databaseUrl: string | undefined;
  slackBotToken: string | undefined;
  slackClientId: string | undefined;
  slackClientSecret: string | undefined;
  slackEnabled: boolean;
  slackEventsPath: string;
  slackInstallationStoreEnabled: boolean;
  slackInstallPath: string;
  slackOAuthInstallEnabled: boolean;
  slackOAuthRedirectPath: string;
  slackScopes: string[];
  slackSigningSecret: string | undefined;
  slackStateSecret: string | undefined;
  slackUserScopes: string[];
};

const DEFAULT_PORT = 8000;
const DEFAULT_SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "groups:history",
  "im:history",
  "mpim:history",
  "reactions:read",
  "users:read",
  "views:write",
];

/**
 * Read application settings from environment variables.
 *
 * @param env - Environment mapping to read. Defaults to `process.env`.
 * @returns Runtime settings for the TypeScript application process.
 * @throws Error when `APP_PORT` or `PORT` is present but not a valid TCP port.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  const databaseUrl = readText(env.DATABASE_URL);
  const slackBotToken = readText(env.SLACK_BOT_TOKEN);
  const slackClientId = readText(env.SLACK_CLIENT_ID);
  const slackClientSecret = readText(env.SLACK_CLIENT_SECRET);
  const slackSigningSecret = readText(env.SLACK_SIGNING_SECRET);
  const slackStateSecret = readText(env.SLACK_STATE_SECRET);
  const slackInstallationStoreEnabled = slackClientId !== undefined && databaseUrl !== undefined;
  const slackOAuthInstallEnabled =
    slackInstallationStoreEnabled &&
    slackClientSecret !== undefined &&
    slackStateSecret !== undefined;
  const slackEnabled =
    slackSigningSecret !== undefined &&
    (slackBotToken !== undefined || slackInstallationStoreEnabled);

  return {
    appEnv: env.APP_ENV ?? "local",
    appHost: env.APP_HOST ?? "0.0.0.0",
    appName: env.APP_NAME ?? "agents-party",
    appPort: parsePort(env.PORT ?? env.APP_PORT, DEFAULT_PORT),
    databaseUrl,
    slackBotToken,
    slackClientId,
    slackClientSecret,
    slackEnabled,
    slackEventsPath: readPath(env.SLACK_EVENTS_PATH, "/slack/events"),
    slackInstallationStoreEnabled,
    slackInstallPath: readPath(env.SLACK_INSTALL_PATH, "/slack/install"),
    slackOAuthInstallEnabled,
    slackOAuthRedirectPath: readPath(env.SLACK_OAUTH_REDIRECT_PATH, "/slack/oauth_redirect"),
    slackScopes: parseList(env.SLACK_SCOPES, DEFAULT_SLACK_SCOPES),
    slackSigningSecret,
    slackStateSecret,
    slackUserScopes: parseList(env.SLACK_USER_SCOPES, []),
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

function readText(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function readPath(value: string | undefined, fallback: string): string {
  const path = readText(value) ?? fallback;
  if (!path.startsWith("/")) {
    throw new Error("Slack route paths must start with '/'.");
  }
  return path;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") {
    return [...fallback];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
