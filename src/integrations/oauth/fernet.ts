import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class FernetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FernetError";
  }
}

export class FernetCipher {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;

  constructor(key: string) {
    const keyBytes = decodeBase64Url(key);
    if (keyBytes.length !== 32) {
      throw new FernetError("Fernet key must decode to 32 bytes.");
    }
    this.signingKey = keyBytes.subarray(0, 16);
    this.encryptionKey = keyBytes.subarray(16, 32);
  }

  encrypt(value: string | Buffer): string {
    const payload = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    if (payload.length === 0) {
      throw new FernetError("Cannot encrypt a blank value.");
    }
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-128-cbc", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tokenBody = Buffer.concat([Buffer.from([0x80]), timestampBuffer(), iv, ciphertext]);
    const signature = createHmac("sha256", this.signingKey).update(tokenBody).digest();
    return encodeBase64Url(Buffer.concat([tokenBody, signature]));
  }

  decrypt(token: string): Buffer {
    if (token.trim() === "") {
      throw new FernetError("Cannot decrypt a blank value.");
    }
    const tokenBytes = decodeBase64Url(token);
    if (tokenBytes.length < 73 || tokenBytes[0] !== 0x80) {
      throw new FernetError("Invalid Fernet token.");
    }
    const tokenBody = tokenBytes.subarray(0, tokenBytes.length - 32);
    const signature = tokenBytes.subarray(tokenBytes.length - 32);
    const expected = createHmac("sha256", this.signingKey).update(tokenBody).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new FernetError("Invalid Fernet token signature.");
    }
    const iv = tokenBytes.subarray(9, 25);
    const ciphertext = tokenBytes.subarray(25, tokenBytes.length - 32);
    try {
      const decipher = createDecipheriv("aes-128-cbc", this.encryptionKey, iv);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new FernetError("Invalid Fernet ciphertext.");
    }
  }
}

export class FernetTextCipher {
  private readonly cipher: FernetCipher;

  constructor(key: string) {
    this.cipher = new FernetCipher(key);
  }

  encrypt(value: string): string {
    if (value === "") {
      throw new FernetError("Cannot encrypt a blank value.");
    }
    return this.cipher.encrypt(value);
  }

  decrypt(value: string): string {
    return this.cipher.decrypt(value).toString("utf8");
  }
}

export function createContextCipher(secret: string): FernetTextCipher {
  if (secret.trim() === "") {
    throw new FernetError("OAuth context signing secret must not be blank.");
  }
  const digest = createHash("sha256").update(secret, "utf8").digest();
  return new FernetTextCipher(encodeBase64Url(digest));
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonValue(record[key])]),
    );
  }
  return value;
}

function timestampBuffer(): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  return buffer;
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Buffer {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
