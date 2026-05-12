export type AppSettings = {
  agentModelId: string;
  appEnv: string;
  appHost: string;
  appName: string;
  appPort: number;
  databaseUrl: string | undefined;
  redisUrl?: string;
  imageGenerationModelId: string;
  googleOAuthCallbackPath: string;
  googleOAuthCallbackUrl: string;
  googleOAuthClientId: string | undefined;
  googleOAuthClientSecret: string | undefined;
  googleOAuthContextSigningSecret: string | undefined;
  googleOAuthEnabled: boolean;
  googleOAuthRedirectBaseUrl: string | undefined;
  googleOAuthStartPath: string;
  googleTokenEncryptionKey: string | undefined;
  googleMapsApiKey: string | undefined;
  googleGenerativeAiApiKey: string | undefined;
  videoGenerationModelId: string;
  slackBotToken: string | undefined;
  slackClientId: string | undefined;
  slackClientSecret: string | undefined;
  slackAgentQueueEnabled?: boolean;
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
  salesforceOAuthCallbackPath: string;
  salesforceOAuthCallbackUrl: string;
  salesforceOAuthContextSigningSecret: string | undefined;
  salesforceOAuthDisconnectPath: string;
  salesforceOAuthEnabled: boolean;
  salesforceOAuthRedirectBaseUrl: string | undefined;
  salesforceOAuthStartPath: string;
  salesforceTokenEncryptionKey: string | undefined;
};

const DEFAULT_PORT = 8000;
const DEFAULT_AGENT_MODEL_ID = "google:gemini-2.5-flash";
const DEFAULT_IMAGE_GENERATION_MODEL_ID = "google:gemini-2.5-flash-image";
const DEFAULT_VIDEO_GENERATION_MODEL_ID = "google:veo-3.1-fast-generate-001";
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
  const redisUrl = readText(env.REDIS_URL);
  const googleOAuthClientId = readText(env.GOOGLE_OAUTH_CLIENT_ID);
  const googleOAuthClientSecret = readText(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const googleOAuthContextSigningSecret = readText(env.GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET);
  const googleOAuthRedirectBaseUrl = readAbsoluteBaseUrl(
    env.GOOGLE_OAUTH_REDIRECT_BASE_URL,
    "GOOGLE_OAUTH_REDIRECT_BASE_URL",
  );
  const googleTokenEncryptionKey = readText(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const googleMapsApiKey = readText(env.GOOGLE_MAPS_API_KEY);
  const googleGenerativeAiApiKey =
    readText(env.GOOGLE_GENERATIVE_AI_API_KEY) ?? readText(env.GEMINI_API_KEY);
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
  const googleOAuthStartPath = readRoutePath(env.GOOGLE_OAUTH_START_PATH, "/oauth/google/start");
  const googleOAuthCallbackPath = readRoutePath(
    env.GOOGLE_OAUTH_CALLBACK_PATH,
    "/oauth/google/callback",
  );
  const googleOAuthEnabled =
    databaseUrl !== undefined &&
    googleOAuthClientId !== undefined &&
    googleOAuthClientSecret !== undefined &&
    googleOAuthContextSigningSecret !== undefined &&
    googleOAuthRedirectBaseUrl !== undefined &&
    googleTokenEncryptionKey !== undefined;
  const salesforceOAuthContextSigningSecret = readText(env.SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET);
  const salesforceOAuthRedirectBaseUrl = readAbsoluteBaseUrl(
    env.SALESFORCE_OAUTH_REDIRECT_BASE_URL,
    "SALESFORCE_OAUTH_REDIRECT_BASE_URL",
  );
  const salesforceOAuthStartPath = readRoutePath(
    env.SALESFORCE_OAUTH_START_PATH,
    "/oauth/salesforce/start",
  );
  const salesforceOAuthCallbackPath = readRoutePath(
    env.SALESFORCE_OAUTH_CALLBACK_PATH,
    "/oauth/salesforce/callback",
  );
  const salesforceOAuthDisconnectPath = readRoutePath(
    env.SALESFORCE_OAUTH_DISCONNECT_PATH,
    "/oauth/salesforce/disconnect",
  );
  const salesforceTokenEncryptionKey = readText(env.SALESFORCE_TOKEN_ENCRYPTION_KEY);
  const salesforceOAuthEnabled =
    databaseUrl !== undefined &&
    salesforceOAuthContextSigningSecret !== undefined &&
    salesforceOAuthRedirectBaseUrl !== undefined &&
    salesforceTokenEncryptionKey !== undefined;

  return {
    agentModelId: readText(env.AGENT_MODEL) ?? DEFAULT_AGENT_MODEL_ID,
    appEnv: env.APP_ENV ?? "local",
    appHost: env.APP_HOST ?? "0.0.0.0",
    appName: env.APP_NAME ?? "agents-party",
    appPort: parsePort(env.PORT ?? env.APP_PORT, DEFAULT_PORT),
    databaseUrl,
    redisUrl,
    imageGenerationModelId:
      readText(env.IMAGE_GENERATION_MODEL) ?? DEFAULT_IMAGE_GENERATION_MODEL_ID,
    googleOAuthCallbackPath,
    googleOAuthCallbackUrl: buildCallbackUrl(googleOAuthRedirectBaseUrl, googleOAuthCallbackPath),
    googleOAuthClientId,
    googleOAuthClientSecret,
    googleOAuthContextSigningSecret,
    googleOAuthEnabled,
    googleOAuthRedirectBaseUrl,
    googleOAuthStartPath,
    googleTokenEncryptionKey,
    googleMapsApiKey,
    googleGenerativeAiApiKey,
    videoGenerationModelId:
      readText(env.VIDEO_GENERATION_MODEL) ?? DEFAULT_VIDEO_GENERATION_MODEL_ID,
    slackBotToken,
    slackClientId,
    slackClientSecret,
    slackAgentQueueEnabled: parseBoolean(env.SLACK_AGENT_QUEUE_ENABLED, false),
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
    salesforceOAuthCallbackPath,
    salesforceOAuthCallbackUrl: buildCallbackUrl(
      salesforceOAuthRedirectBaseUrl,
      salesforceOAuthCallbackPath,
    ),
    salesforceOAuthContextSigningSecret,
    salesforceOAuthDisconnectPath,
    salesforceOAuthEnabled,
    salesforceOAuthRedirectBaseUrl,
    salesforceOAuthStartPath,
    salesforceTokenEncryptionKey,
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
  return readRoutePath(value, fallback, "Slack route paths");
}

function readRoutePath(value: string | undefined, fallback: string, label = "Route paths"): string {
  const path = readText(value) ?? fallback;
  if (!path.startsWith("/")) {
    throw new Error(`${label} must start with '/'.`);
  }
  return path;
}

function readAbsoluteBaseUrl(value: string | undefined, envName: string): string | undefined {
  const text = readText(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = new URL(text);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${envName} must be an absolute http(s) URL.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${envName} must not include a query string or fragment.`);
  }
  return text.replace(/\/+$/, "");
}

function buildCallbackUrl(baseUrl: string | undefined, path: string): string {
  return baseUrl === undefined ? path : `${baseUrl}${path}`;
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLocaleLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("Boolean environment values must be true or false.");
}
