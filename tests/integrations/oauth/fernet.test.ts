import { describe, expect, it } from "vite-plus/test";

import { OAuthContextSigner } from "../../../src/integrations/oauth/contextSigner.js";
import {
  googleOAuthStartContextSchema,
  googleOAuthStateTokenSchema,
} from "../../../src/integrations/oauth/domain.js";
import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";

describe("FernetTextCipher", () => {
  it("decrypts tokens produced by Python cryptography Fernet", () => {
    const cipher = new FernetTextCipher("TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=");

    expect(
      cipher.decrypt(
        "gAAAAABqAb64J8UUMC7toqffeqoMQ98iRp8sDwY5VqejvvWDpLbiSvQ9ZE8YbI8utP6NJZLTqQbhI80Yjexugu6PGxouasH4Cg==",
      ),
    ).toBe("access-token");
  });

  it("round-trips TS encrypted values", () => {
    const cipher = new FernetTextCipher("TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=");

    expect(cipher.decrypt(cipher.encrypt("refresh-token"))).toBe("refresh-token");
  });
});

describe("OAuthContextSigner", () => {
  it("loads context tokens produced by Python context signers", () => {
    const signer = new OAuthContextSigner({
      contextSchema: googleOAuthStartContextSchema,
      secret: "context-secret",
      stateTokenSchema: googleOAuthStateTokenSchema,
    });

    expect(
      signer.loads(
        "gAAAAABqAb64D9JjFgjnDhlEw67X0RM2OO2bTBgjO-ESUaEvCqdZJYsUUbj_citcTsBrzORPUlSX6yipHjfpqUaK2Q6oTK0yc7Rfnjh3lY4XO7iTD0X9wibe2tsZssW6tpdHjYrMfBzksKVNqiC3IQaV8zoIF0ho3SmCDJNTAfM9-wXYfGj4quaxhceI6wnKsmkoB8SJuH_pMTWre1KLdSOi2jlM3Eakug==",
      ),
    ).toMatchObject({
      redirect_after_connect: "/done",
      slack_user_id: "U123",
      team_id: "T123",
    });
  });
});
