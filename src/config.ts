import { DEFAULT_LOCALE, resolveLocale, type Locale } from "./i18n/index.js";

export type AppSettings = {
  agentModelId: string;
  appEnv: string;
  appHost: string;
  appName: string;
  appPort: number;
  databaseUrl: string | undefined;
  defaultLocale: Locale;
  redisUrl?: string;
  imageGenerationModelId: string;
  llmApiKeyEncryptionKey: string | undefined;
  objectStorageAccessKeyId: string | undefined;
  objectStorageBucket: string | undefined;
  objectStorageEnabled: boolean;
  objectStorageEndpoint: string | undefined;
  objectStorageForcePathStyle: boolean;
  objectStoragePrefix: string | undefined;
  objectStoragePublicBaseUrl: string | undefined;
  objectStorageRegion: string | undefined;
  objectStorageSecretAccessKey: string | undefined;
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
  transcriptionAlternativeLanguageCodes: string[];
  transcriptionLanguageCode: string;
  transcriptionModelId: string;
  videoGenerationModelId: string;
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
const LOCAL_BOOTSTRAP_AGENT_MODEL_ID = "google:gemini-2.5-flash";
const DEFAULT_IMAGE_GENERATION_MODEL_ID = "google:gemini-2.5-flash-image";
const DEFAULT_TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES = ["en-US"];
const DEFAULT_TRANSCRIPTION_LANGUAGE_CODE = "ja-JP";
const DEFAULT_TRANSCRIPTION_MODEL_ID = "google:speech-to-text-latest-long";
const DEFAULT_VIDEO_GENERATION_MODEL_ID = "google:veo-3.1-fast-generate-001";
const APP_ENVS_REQUIRING_AGENT_MODEL = new Set(["heroku", "prod", "production", "staging"]);
const DEFAULT_SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "im:history",
  "mpim:history",
  "reactions:read",
  "users:read",
];

/**
 * Read application settings from environment variables.
 *
 * @param env - Environment mapping to read. Defaults to `process.env`.
 * @returns Runtime settings for the TypeScript application process.
 * @throws Error when `APP_PORT` or `PORT` is present but not a valid TCP port.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  const appEnv = readText(env.APP_ENV) ?? "local";
  const agentModelId = readAgentModelId(env, appEnv);
  const databaseUrl = readText(env.DATABASE_URL);
  const redisUrl = readText(env.REDIS_URL);
  const llmApiKeyEncryptionKey = readText(env.LLM_API_KEY_ENCRYPTION_KEY);
  const objectStorageBucket =
    readText(env.OBJECT_STORAGE_BUCKET) ?? readText(env.BUCKETEER_BUCKET_NAME);
  const objectStorageRegion =
    readText(env.OBJECT_STORAGE_REGION) ?? readText(env.BUCKETEER_AWS_REGION);
  const objectStorageAccessKeyId =
    readText(env.OBJECT_STORAGE_ACCESS_KEY_ID) ?? readText(env.BUCKETEER_AWS_ACCESS_KEY_ID);
  const objectStorageSecretAccessKey =
    readText(env.OBJECT_STORAGE_SECRET_ACCESS_KEY) ?? readText(env.BUCKETEER_AWS_SECRET_ACCESS_KEY);
  const objectStorageEndpoint = readAbsoluteBaseUrl(
    env.OBJECT_STORAGE_ENDPOINT,
    "OBJECT_STORAGE_ENDPOINT",
  );
  const objectStoragePublicBaseUrl = readAbsoluteBaseUrl(
    env.OBJECT_STORAGE_PUBLIC_BASE_URL,
    "OBJECT_STORAGE_PUBLIC_BASE_URL",
  );
  assertProductionProviderCredentialSettings(env, appEnv, {
    databaseUrl,
    llmApiKeyEncryptionKey,
  });
  const googleOAuthClientId = readText(env.GOOGLE_OAUTH_CLIENT_ID);
  const googleOAuthClientSecret = readText(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const googleOAuthContextSigningSecret = readText(env.GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET);
  const googleOAuthRedirectBaseUrl = readAbsoluteBaseUrl(
    env.GOOGLE_OAUTH_REDIRECT_BASE_URL,
    "GOOGLE_OAUTH_REDIRECT_BASE_URL",
  );
  const googleTokenEncryptionKey = readText(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const googleMapsApiKey = readText(env.GOOGLE_MAPS_API_KEY);
  const slackClientId = readText(env.SLACK_CLIENT_ID);
  const slackClientSecret = readText(env.SLACK_CLIENT_SECRET);
  const slackSigningSecret = readText(env.SLACK_SIGNING_SECRET);
  const slackStateSecret = readText(env.SLACK_STATE_SECRET);
  const slackInstallationStoreEnabled = slackClientId !== undefined && databaseUrl !== undefined;
  const slackOAuthInstallEnabled =
    slackInstallationStoreEnabled &&
    slackClientSecret !== undefined &&
    slackStateSecret !== undefined;
  const slackEnabled = slackSigningSecret !== undefined && slackInstallationStoreEnabled;
  assertProductionSlackInstallationStoreSettings(env, appEnv, {
    databaseUrl,
    slackClientId,
    slackClientSecret,
    slackOAuthInstallEnabled,
    slackSigningSecret,
    slackStateSecret,
  });
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
    agentModelId,
    appEnv,
    appHost: env.APP_HOST ?? "0.0.0.0",
    appName: env.APP_NAME ?? "Agents party",
    appPort: parsePort(env.PORT ?? env.APP_PORT, DEFAULT_PORT),
    databaseUrl,
    defaultLocale: resolveLocale(readText(env.APP_DEFAULT_LOCALE), DEFAULT_LOCALE),
    redisUrl,
    imageGenerationModelId:
      readText(env.IMAGE_GENERATION_MODEL) ?? DEFAULT_IMAGE_GENERATION_MODEL_ID,
    llmApiKeyEncryptionKey,
    objectStorageAccessKeyId,
    objectStorageBucket,
    objectStorageEnabled: objectStorageBucket !== undefined,
    objectStorageEndpoint,
    objectStorageForcePathStyle: parseBoolean(env.OBJECT_STORAGE_FORCE_PATH_STYLE, false),
    objectStoragePrefix: readObjectStoragePrefix(env.OBJECT_STORAGE_PREFIX),
    objectStoragePublicBaseUrl,
    objectStorageRegion,
    objectStorageSecretAccessKey,
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
    transcriptionAlternativeLanguageCodes: parseList(
      env.TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES,
      DEFAULT_TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES,
    ),
    transcriptionLanguageCode:
      readText(env.TRANSCRIPTION_LANGUAGE_CODE) ?? DEFAULT_TRANSCRIPTION_LANGUAGE_CODE,
    transcriptionModelId: readText(env.TRANSCRIPTION_MODEL) ?? DEFAULT_TRANSCRIPTION_MODEL_ID,
    videoGenerationModelId:
      readText(env.VIDEO_GENERATION_MODEL) ?? DEFAULT_VIDEO_GENERATION_MODEL_ID,
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

function readAgentModelId(env: NodeJS.ProcessEnv, appEnv: string): string {
  const agentModelId = readText(env.AGENT_MODEL);
  if (agentModelId !== undefined) {
    return agentModelId;
  }
  if (requiresExplicitAgentModel(env, appEnv)) {
    throw new Error(
      "AGENT_MODEL is required for production-like runtimes. Set AGENT_MODEL to a registered provider model id.",
    );
  }
  return LOCAL_BOOTSTRAP_AGENT_MODEL_ID;
}

function requiresExplicitAgentModel(env: NodeJS.ProcessEnv, appEnv: string): boolean {
  return isProductionLikeRuntime(env, appEnv);
}

function assertProductionProviderCredentialSettings(
  env: NodeJS.ProcessEnv,
  appEnv: string,
  settings: {
    databaseUrl: string | undefined;
    llmApiKeyEncryptionKey: string | undefined;
  },
): void {
  if (!isProductionLikeRuntime(env, appEnv)) {
    return;
  }
  if (settings.databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is required for production-like runtimes so provider API keys resolve from workspace credentials.",
    );
  }
  if (settings.llmApiKeyEncryptionKey === undefined) {
    throw new Error(
      "LLM_API_KEY_ENCRYPTION_KEY is required for production-like runtimes so provider API keys resolve from workspace credentials.",
    );
  }
}

function assertProductionSlackInstallationStoreSettings(
  env: NodeJS.ProcessEnv,
  appEnv: string,
  settings: {
    databaseUrl: string | undefined;
    slackClientId: string | undefined;
    slackClientSecret: string | undefined;
    slackOAuthInstallEnabled: boolean;
    slackSigningSecret: string | undefined;
    slackStateSecret: string | undefined;
  },
): void {
  if (!isProductionLikeRuntime(env, appEnv)) {
    return;
  }
  if (settings.slackSigningSecret === undefined) {
    throw new Error(
      "SLACK_SIGNING_SECRET is required for production-like multi-workspace Slack runtimes.",
    );
  }
  if (settings.databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is required for production-like multi-workspace Slack installation storage.",
    );
  }
  if (settings.slackClientId === undefined) {
    throw new Error(
      "SLACK_CLIENT_ID is required for production-like multi-workspace Slack installation storage.",
    );
  }
  if (settings.slackClientSecret === undefined) {
    throw new Error(
      "SLACK_CLIENT_SECRET is required for production-like Slack OAuth installation.",
    );
  }
  if (settings.slackStateSecret === undefined) {
    throw new Error("SLACK_STATE_SECRET is required for production-like Slack OAuth installation.");
  }
  if (!settings.slackOAuthInstallEnabled) {
    throw new Error("Slack OAuth installation must be enabled for production-like runtimes.");
  }
}

function isProductionLikeRuntime(env: NodeJS.ProcessEnv, appEnv: string): boolean {
  return (
    APP_ENVS_REQUIRING_AGENT_MODEL.has(appEnv.trim().toLowerCase()) ||
    readText(env.DYNO) !== undefined ||
    readText(env.NODE_ENV)?.toLowerCase() === "production"
  );
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
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${envName} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${envName} must be an absolute http(s) URL.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${envName} must not include a query string or fragment.`);
  }
  return text.replace(/\/+$/, "");
}

function readObjectStoragePrefix(value: string | undefined): string | undefined {
  const text = readText(value);
  if (text === undefined) {
    return undefined;
  }
  return text.replace(/^\/+|\/+$/g, "");
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
