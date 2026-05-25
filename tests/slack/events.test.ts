import { describe, expect, it } from "vite-plus/test";

import {
  registerSlackEventHandlers,
  type SlackEventFeatureHandlers,
} from "../../src/slack/events.js";
import type { SlackEventDeduplicator } from "../../src/slack/idempotency.js";

type RegisteredListener = (args: Record<string, unknown>) => Promise<void>;
type RegisteredMiddleware = (args: {
  body: unknown;
  context: { retryNum?: number; retryReason?: string };
  logger: { info: (...args: unknown[]) => void };
  next: () => Promise<void>;
}) => Promise<void>;

class StubSlackApp {
  readonly actions = new Map<string, RegisteredListener>();
  readonly events = new Map<string, RegisteredListener>();
  readonly middlewares: RegisteredMiddleware[] = [];
  readonly views = new Map<string, RegisteredListener>();

  action(name: string, listener: RegisteredListener): void {
    this.actions.set(name, listener);
  }

  event(name: string, listener: RegisteredListener): void {
    this.events.set(name, listener);
  }

  use(middleware: RegisteredMiddleware): void {
    this.middlewares.push(middleware);
  }

  view(name: string, listener: RegisteredListener): void {
    this.views.set(name, listener);
  }
}

class StubDeduplicator implements SlackEventDeduplicator {
  constructor(private readonly accept: boolean) {}

  markProcessing(): boolean {
    return this.accept;
  }
}

const handlers: SlackEventFeatureHandlers = {
  async handleAppHomeOpened() {},
  async handleAppMention() {},
  async handleAssistantThreadContextChanged() {},
  async handleAssistantThreadStarted() {},
  async handleMessage() {},
  async handleReactionAdded() {},
  async handleModelRoutingConfigureAction() {},
  async handleModelRoutingDefaultModelSelectAction() {},
  async handleModelRoutingModalSubmission() {},
  async handleFeatureSettingsConfigureAction() {},
  async handleFeatureSettingsModalSubmission() {},
  async handleRssFeedConfigureAction() {},
  async handleRssFeedModalSubmission() {},
  async handleSalesforcePdfWorkflowConfigureAction() {},
  async handleSalesforcePdfWorkflowModalSubmission() {},
  async handleWorkspaceCredentialConfigureAction() {},
  async handleWorkspaceCredentialProviderSelectAction() {},
  async handleWorkspaceCredentialModalSubmission() {},
};

describe("registerSlackEventHandlers", () => {
  it("registers the Slack event categories owned by OSA-8", () => {
    const app = new StubSlackApp();

    registerSlackEventHandlers(app as never, handlers, new StubDeduplicator(true));

    expect([...app.events.keys()].sort()).toEqual([
      "app_home_opened",
      "app_mention",
      "assistant_thread_context_changed",
      "assistant_thread_started",
      "message",
      "reaction_added",
    ]);
    expect([...app.actions.keys()].sort()).toEqual([
      "default_model",
      "feature_settings_configure",
      "model_routing_channel_configure",
      "model_routing_configure",
      "model_routing_thread_configure",
      "provider_kind",
      "rss_feed_configure",
      "salesforce_pdf_workflow_configure",
      "workspace_credential_configure",
    ]);
    expect([...app.views.keys()].sort()).toEqual([
      "feature_settings_modal",
      "model_routing_modal",
      "rss_feed_modal",
      "salesforce_pdf_workflow_modal",
      "workspace_credential_modal",
    ]);
    expect(app.middlewares).toHaveLength(1);
  });

  it("continues first event deliveries through the middleware", async () => {
    const app = new StubSlackApp();
    let nextCalled = false;

    registerSlackEventHandlers(app as never, handlers, new StubDeduplicator(true));
    await app.middlewares[0]?.({
      body: { event_id: "Ev1" },
      context: {},
      logger: { info() {} },
      next: async () => {
        nextCalled = true;
      },
    });

    expect(nextCalled).toBe(true);
  });

  it("suppresses duplicate event deliveries before feature handlers run", async () => {
    const app = new StubSlackApp();
    let nextCalled = false;
    const logs: unknown[] = [];

    registerSlackEventHandlers(app as never, handlers, new StubDeduplicator(false));
    await app.middlewares[0]?.({
      body: { event_id: "Ev1" },
      context: { retryNum: 1, retryReason: "http_timeout" },
      logger: { info: (...args: unknown[]) => logs.push(args) },
      next: async () => {
        nextCalled = true;
      },
    });

    expect(nextCalled).toBe(false);
    expect(logs).toEqual([
      [
        "Skipping duplicate Slack event delivery.",
        {
          eventId: "Ev1",
          retryNum: 1,
          retryReason: "http_timeout",
        },
      ],
    ]);
  });
});
