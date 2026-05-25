import { describe, expect, it } from "vite-plus/test";

import { createSoracomAgentTools } from "../../../src/agents/soracom/index.js";
import { AgentToolRegistry } from "../../../src/agents/toolContracts.js";
import type { ProviderCredentialResolver } from "../../../src/providers/credentials.js";

describe("SORACOM agent tools", () => {
  it("exposes read-only SORACOM tool definitions", () => {
    const registry = registryWith();

    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "soracom_get_sim_status",
      "soracom_find_resources",
      "soracom_get_sim_status_history",
      "soracom_list_soracam_devices",
      "soracom_list_soracam_events",
      "soracom_get_soracam_export_usage",
    ]);
  });

  it("returns setup guidance when SORACOM credentials are missing", async () => {
    const registry = registryWith({ credentialResolver: undefined });

    await expect(
      registry.execute({
        input: { resourceId: "sim-1" },
        toolCallId: "call-1",
        toolName: "soracom_get_sim_status",
      }),
    ).resolves.toMatchObject({
      output: {
        code: "missing_soracom_credential",
        ok: false,
      },
    });
  });

  it("normalizes SIM status without exposing credentials", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse({
        groupId: "group-1",
        iccid: "8981100000000000000",
        imsi: "440100000000000",
        sessionStatus: { lastUpdatedAt: 1770000000000, online: true },
        simId: "sim-abcdef1234",
        status: "active",
        tags: { name: "Store A" },
      }),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    const result = await registry.execute({
      input: { resourceId: "sim-1" },
      toolCallId: "call-1",
      toolName: "soracom_get_sim_status",
    });

    expect(result).toMatchObject({
      output: {
        ok: true,
        sim: {
          groupId: "group-1",
          lastModifiedTime: 1770000000000,
          sessionOnline: true,
          sessionStatus: "online",
          simId: "sim-...1234",
          status: "active",
        },
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("secret-1");
    expect(JSON.stringify(result.output)).not.toContain("sim-abcdef1234");
    expect(JSON.stringify(result.output)).not.toContain("440100000000000");
    expect(JSON.stringify(result.output)).not.toContain("8981100000000000000");
  });

  it("finds SIM and SoraCam resources by tag or name", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse([{ simId: "sim-abcdef1234", tags: { name: "Store A" } }]),
      jsonResponse([{ connected: true, deviceId: "cam-1", name: "Store A camera" }]),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    const result = await registry.execute({
      input: { query: "Store A" },
      toolCallId: "call-1",
      toolName: "soracom_find_resources",
    });

    expect(result).toMatchObject({
      output: {
        ok: true,
        resources: [
          expect.objectContaining({ id: "sim-...1234", resourceType: "sim" }),
          expect.objectContaining({ id: "cam-1", resourceType: "soracam_device" }),
        ],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("sim-abcdef1234");
  });

  it("supports generic SIM discovery when no SIM identifier is provided", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse([
        { imsi: "440100000000001", simId: "sim-abcdef0001", tags: { name: "Store A" } },
        { imsi: "440100000000002", simId: "sim-abcdef0002", tags: { name: "Store B" } },
      ]),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    await expect(
      registry.execute({
        input: { query: "sim", resourceTypes: ["sim"] },
        toolCallId: "call-1",
        toolName: "soracom_find_resources",
      }),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        resources: [
          expect.objectContaining({ id: "sim-...0001", resourceType: "sim" }),
          expect.objectContaining({ id: "sim-...0002", resourceType: "sim" }),
        ],
      },
    });
  });

  it("follows SIM pagination when resolving IMSI", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      ...Array.from({ length: 11 }, (_value, index) =>
        jsonResponse([{ imsi: `440100000000${index.toString().padStart(3, "0")}` }], {
          "x-soracom-next-key": `next-${index + 1}`,
        }),
      ),
      jsonResponse([{ imsi: "440100000000999", simId: "sim-final-page-9999" }]),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    const result = await registry.execute({
      input: { idType: "imsi", resourceId: "440100000000999" },
      toolCallId: "call-1",
      toolName: "soracom_get_sim_status",
    });

    expect(result).toMatchObject({
      output: {
        ok: true,
        sim: {
          imsi: "...0999",
          simId: "sim-...9999",
        },
      },
    });
    expect(fetch.calls.at(-1)?.url).toContain("last_evaluated_key=next-11");
    expect(JSON.stringify(result.output)).not.toContain("sim-final-page-9999");
  });

  it("returns SORACOM API failures as tool output", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse({ code: "SEM0001", message: "Too many requests" }, {}, 429),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    await expect(
      registry.execute({
        input: { limit: 10 },
        toolCallId: "call-1",
        toolName: "soracom_list_soracam_devices",
      }),
    ).resolves.toMatchObject({
      output: {
        code: "SEM0001",
        ok: false,
        retriable: true,
        status: 429,
      },
    });
  });

  it("normalizes SoraCam events without returning raw temporary URLs", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse([
        {
          deviceId: "cam-1",
          eventId: "event-1",
          eventType: "motion",
          time: 1770000000000,
          url: "https://temporary.example/download",
        },
      ]),
    ]);
    const registry = registryWith({ fetchFn: fetch.call });

    const result = await registry.execute({
      input: { deviceId: "cam-1" },
      toolCallId: "call-1",
      toolName: "soracom_list_soracam_events",
    });

    expect(result.output).toMatchObject({
      events: [
        {
          deviceId: "cam-1",
          event: "motion",
          eventId: "event-1",
          time: 1770000000000,
        },
      ],
      ok: true,
    });
    expect(JSON.stringify(result.output)).not.toContain("temporary.example");
  });
});

function registryWith(
  input: {
    credentialResolver?: ProviderCredentialResolver;
    fetchFn?: typeof fetch;
  } = {},
): AgentToolRegistry {
  return new AgentToolRegistry(
    createSoracomAgentTools({
      context: { teamId: "T1" },
      credentialResolver:
        "credentialResolver" in input ? input.credentialResolver : new FakeCredentialResolver(),
      fetchFn: input.fetchFn,
    }),
  );
}

class FakeCredentialResolver implements ProviderCredentialResolver {
  async resolveProviderCredential() {
    return {
      apiKey: "secret-1",
      payload: {
        auth_key_id: "keyId-1",
        coverage_type: "global",
      },
    };
  }
}

class RecordingFetch {
  readonly calls: Array<{ init: RequestInit; url: string }> = [];

  constructor(private readonly responses: Response[]) {}

  readonly call = async (input: string | URL | Request, init: RequestInit = {}) => {
    this.calls.push({ init, url: input.toString() });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected fetch call.");
    }
    return response;
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}
