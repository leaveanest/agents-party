import { createSign } from "node:crypto";

import { createAzure } from "@ai-sdk/azure";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe, type TranscriptionModel } from "ai";

import type { AppSettings } from "../config.js";
import type { ModelInfo } from "./contracts.js";
import type { ProviderCredential, ProviderCredentialResolver } from "./credentials.js";
import { createDefaultModelRegistry, type ModelRegistry } from "./modelRegistry.js";

export type TranscriptionRequest = {
  audio: Uint8Array;
  context: {
    workspaceId: string;
  };
  filename?: string;
  mediaType: string;
};

export type TranscriptionResult = {
  model?: string;
  provider: string;
  text: string;
};

export type TranscriptionGateway = {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
};

export class UnsupportedTranscriptionProviderError extends Error {
  constructor(readonly model: ModelInfo) {
    super(`Transcription provider '${model.provider}' is not supported.`);
    this.name = "UnsupportedTranscriptionProviderError";
  }
}

export class UnsupportedTranscriptionMediaTypeError extends Error {
  constructor(readonly mediaType: string) {
    super(`Audio media type '${mediaType}' is not supported for transcription.`);
    this.name = "UnsupportedTranscriptionMediaTypeError";
  }
}

export class TranscriptionProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly modelId: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TranscriptionProviderError";
  }
}

export type DefaultTranscriptionServiceOptions = {
  credentialResolver?: ProviderCredentialResolver;
  fetchFn?: typeof fetch;
  registry?: ModelRegistry;
  transcribeFn?: AiSdkTranscribeFunction;
};

export function createDefaultTranscriptionGateway(
  settings: AppSettings,
  options: DefaultTranscriptionServiceOptions = {},
): TranscriptionGateway | undefined {
  if (options.credentialResolver === undefined) {
    return undefined;
  }
  const registry = options.registry ?? createDefaultModelRegistry();
  const model = registry.get(settings.transcriptionModelId);
  registry.assertCapabilities(model, ["transcription"]);
  if (!supportedTranscriptionProviders.has(model.provider)) {
    throw new UnsupportedTranscriptionProviderError(model);
  }
  return new WorkspaceCredentialTranscriptionGateway({
    credentialResolver: options.credentialResolver,
    fetchFn: options.fetchFn,
    languageCode: settings.transcriptionLanguageCode,
    model,
    alternativeLanguageCodes: settings.transcriptionAlternativeLanguageCodes,
    transcribeFn: options.transcribeFn,
  });
}

export class WorkspaceCredentialTranscriptionGateway implements TranscriptionGateway {
  constructor(
    private readonly options: {
      alternativeLanguageCodes?: string[];
      credentialResolver: ProviderCredentialResolver;
      fetchFn?: typeof fetch;
      languageCode: string;
      model: ModelInfo;
      transcribeFn?: AiSdkTranscribeFunction;
    },
  ) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const credential = await this.options.credentialResolver.resolveProviderCredential({
      credentialName: credentialNameForTranscriptionProvider(this.options.model.provider),
      provider: this.options.model.provider,
      workspaceId: request.context.workspaceId,
    });
    if (credential === undefined) {
      throw new TranscriptionProviderError(
        this.options.model.provider,
        this.options.model.id,
        "Transcription provider credential is not configured.",
      );
    }
    if (this.options.model.provider !== "google") {
      return new AiSdkTranscriptionGateway({
        credential,
        model: this.options.model,
        transcribeFn: this.options.transcribeFn,
      }).transcribe(request);
    }
    return new GoogleSpeechToTextTranscriptionGateway({
      alternativeLanguageCodes: this.options.alternativeLanguageCodes,
      credential,
      fetchFn: this.options.fetchFn,
      languageCode: this.options.languageCode,
      model: this.options.model,
    }).transcribe(request);
  }
}

export class GoogleSpeechToTextTranscriptionGateway implements TranscriptionGateway {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly options: {
      alternativeLanguageCodes?: string[];
      credential: ProviderCredential;
      fetchFn?: typeof fetch;
      languageCode: string;
      model: ModelInfo;
    },
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const encoding = googleSpeechEncodingForMediaType(request.mediaType);
    if (encoding === undefined) {
      throw new UnsupportedTranscriptionMediaTypeError(request.mediaType);
    }
    const url = googleSpeechRecognizeUrl(this.options.credential);
    const headers = await googleSpeechAuthHeaders(
      this.options.credential,
      this.fetchFn,
      this.options.model.id,
    );
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        body: JSON.stringify({
          audio: {
            content: Buffer.from(request.audio).toString("base64"),
          },
          config: {
            alternativeLanguageCodes: this.options.alternativeLanguageCodes,
            enableAutomaticPunctuation: true,
            encoding,
            languageCode: this.options.languageCode,
            model: this.options.model.providerModelId,
          },
        }),
        headers,
        method: "POST",
      });
    } catch {
      throw new TranscriptionProviderError(
        "google",
        this.options.model.id,
        "Google Speech-to-Text request failed.",
      );
    }
    if (!response.ok) {
      throw new TranscriptionProviderError(
        "google",
        this.options.model.id,
        `Google Speech-to-Text failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    let payload: GoogleSpeechRecognizeResponse;
    try {
      payload = (await response.json()) as GoogleSpeechRecognizeResponse;
    } catch {
      throw new TranscriptionProviderError(
        "google",
        this.options.model.id,
        "Google Speech-to-Text returned an invalid response.",
      );
    }
    const text = extractGoogleSpeechTranscript(payload);
    if (text === "") {
      throw new TranscriptionProviderError(
        "google",
        this.options.model.id,
        "Google Speech-to-Text did not return transcript text.",
      );
    }
    return {
      model: this.options.model.id,
      provider: "google",
      text,
    };
  }
}

export type AiSdkTranscribeFunction = typeof transcribe;

export class AiSdkTranscriptionGateway implements TranscriptionGateway {
  private readonly transcribeFn: AiSdkTranscribeFunction;

  constructor(
    private readonly options: {
      credential: ProviderCredential;
      model: ModelInfo;
      transcribeFn?: AiSdkTranscribeFunction;
    },
  ) {
    this.transcribeFn = options.transcribeFn ?? transcribe;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = aiSdkTranscriptionModel(this.options.model, this.options.credential);
    let result;
    try {
      result = await this.transcribeFn({
        audio: request.audio,
        model,
      });
    } catch {
      throw new TranscriptionProviderError(
        this.options.model.provider,
        this.options.model.id,
        "AI SDK transcription request failed.",
      );
    }
    if (result.text.trim() === "") {
      throw new TranscriptionProviderError(
        this.options.model.provider,
        this.options.model.id,
        "AI SDK transcription did not return transcript text.",
      );
    }
    return {
      model: this.options.model.id,
      provider: this.options.model.provider,
      text: result.text,
    };
  }
}

type GoogleSpeechRecognizeResponse = {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
    }>;
  }>;
};

function googleSpeechRecognizeUrl(credential: ProviderCredential): string {
  const baseUrl = credential.baseURL ?? "https://speech.googleapis.com";
  const url = new URL("/v1p1beta1/speech:recognize", baseUrl);
  return url.toString();
}

async function googleSpeechAuthHeaders(
  credential: ProviderCredential,
  fetchFn: typeof fetch,
  modelId: string,
): Promise<Record<string, string>> {
  const accessToken = await googleSpeechAccessToken(credential, fetchFn, modelId);
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function googleSpeechAccessToken(
  credential: ProviderCredential,
  fetchFn: typeof fetch,
  modelId: string,
): Promise<string> {
  const serviceAccount = parseGoogleServiceAccountCredential(credential.apiKey, modelId);
  if (serviceAccount === undefined) {
    return credential.apiKey;
  }
  const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  let assertion: string;
  try {
    assertion = signGoogleServiceAccountJwt(serviceAccount, tokenUri);
  } catch {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text service account credential is invalid.",
    );
  }
  let response: Response;
  try {
    response = await fetchFn(tokenUri, {
      body: new URLSearchParams({
        assertion,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text authentication failed.",
    );
  }
  if (!response.ok) {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      `Google Speech-to-Text authentication failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  let payload: GoogleOAuthTokenResponse;
  try {
    payload = (await response.json()) as GoogleOAuthTokenResponse;
  } catch {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text authentication returned an invalid response.",
    );
  }
  if (typeof payload.access_token !== "string" || payload.access_token.trim() === "") {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text authentication did not return an access token.",
    );
  }
  return payload.access_token;
}

type GoogleServiceAccountCredential = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type GoogleOAuthTokenResponse = {
  access_token?: string;
};

function parseGoogleServiceAccountCredential(
  secret: string,
  modelId: string,
): GoogleServiceAccountCredential | undefined {
  if (!secret.trim().startsWith("{")) {
    return undefined;
  }
  let parsed: Partial<GoogleServiceAccountCredential>;
  try {
    parsed = JSON.parse(secret) as Partial<GoogleServiceAccountCredential>;
  } catch {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text service account credential is invalid.",
    );
  }
  if (
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    (parsed.token_uri !== undefined && typeof parsed.token_uri !== "string")
  ) {
    throw new TranscriptionProviderError(
      "google",
      modelId,
      "Google Speech-to-Text service account credential is invalid.",
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri,
  };
}

function signGoogleServiceAccountJwt(
  credential: GoogleServiceAccountCredential,
  audience: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    aud: audience,
    exp: now + 3600,
    iat: now,
    iss: credential.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(credential.private_key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function aiSdkTranscriptionModel(
  model: ModelInfo,
  credential: ProviderCredential,
): TranscriptionModel {
  switch (model.provider) {
    case "openai":
      return createOpenAI({
        apiKey: credential.apiKey,
        baseURL: credential.baseURL,
      }).transcription(model.providerModelId);
    case "azure_openai":
      return createAzure({
        apiKey: credential.apiKey,
        baseURL: credential.baseURL,
      }).transcription(model.providerModelId);
    case "groq":
      return createGroq({
        apiKey: credential.apiKey,
        baseURL: credential.baseURL,
      }).transcription(model.providerModelId);
    default:
      throw new UnsupportedTranscriptionProviderError(model);
  }
}

function credentialNameForTranscriptionProvider(provider: ModelInfo["provider"]): string {
  return provider === "google" ? "service_account_json" : "api_key";
}

function googleSpeechEncodingForMediaType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLocaleLowerCase();
  switch (normalized) {
    case "audio/flac":
    case "audio/x-flac":
      return "FLAC";
    case "audio/mpeg":
    case "audio/mp3":
      return "MP3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "LINEAR16";
    default:
      return undefined;
  }
}

function extractGoogleSpeechTranscript(payload: GoogleSpeechRecognizeResponse): string {
  return (payload.results ?? [])
    .map((result) => result.alternatives?.[0]?.transcript?.trim() ?? "")
    .filter((transcript) => transcript.length > 0)
    .join("\n");
}

const supportedTranscriptionProviders = new Set<ModelInfo["provider"]>([
  "azure_openai",
  "google",
  "groq",
  "openai",
]);
