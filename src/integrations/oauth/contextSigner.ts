import { z } from "zod";

import {
  createContextCipher,
  FernetError,
  type FernetTextCipher,
  stableJsonStringify,
} from "./fernet.js";

export class OAuthContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthContextError";
  }
}

export class OAuthContextSigner<Context, StateToken> {
  private readonly cipher: FernetTextCipher;
  private readonly contextSchema: z.ZodType<Context>;
  private readonly stateTokenSchema: z.ZodType<StateToken>;

  constructor(input: {
    contextSchema: z.ZodType<Context>;
    secret: string;
    stateTokenSchema: z.ZodType<StateToken>;
  }) {
    this.cipher = createContextCipher(input.secret);
    this.contextSchema = input.contextSchema;
    this.stateTokenSchema = input.stateTokenSchema;
  }

  dumps(context: unknown): string {
    return this.cipher.encrypt(stableJsonStringify(context));
  }

  loads(token: string): Context {
    return this.loadToken(token, this.contextSchema);
  }

  dumpsStateToken(stateToken: unknown): string {
    return this.cipher.encrypt(stableJsonStringify(stateToken));
  }

  loadsStateToken(token: string): StateToken {
    return this.loadToken(token, this.stateTokenSchema);
  }

  private loadToken<T>(token: string, schema: z.ZodType<T>): T {
    try {
      const parsed = schema.parse(JSON.parse(this.cipher.decrypt(token)));
      if (hasExpired(parsed)) {
        throw new OAuthContextError("Expired OAuth context token.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof OAuthContextError) {
        throw error;
      }
      if (
        error instanceof FernetError ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      ) {
        throw new OAuthContextError("Malformed OAuth context token.");
      }
      throw error;
    }
  }
}

function hasExpired(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("expires_at" in value)) {
    return false;
  }
  const expiresAt = (value as { expires_at?: unknown }).expires_at;
  return expiresAt instanceof Date && expiresAt.getTime() <= Date.now();
}
