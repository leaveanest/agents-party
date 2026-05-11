import { describe, expect, it } from "vite-plus/test";

import { createWorkManagerCalendarTools } from "../../src/agents/workManagerCalendarTools.js";
import { AgentToolRegistry } from "../../src/agents/toolContracts.js";
import type { WorkItemCalendarLinkRepository } from "../../src/repositories/workItemCalendarLinks.js";

describe("createWorkManagerCalendarTools", () => {
  it("links Google Calendar events without applying time fields by default", async () => {
    const repository = new RecordingCalendarRepository();
    const registry = new AgentToolRegistry(createWorkManagerCalendarTools(repository));

    const result = await registry.execute({
      input: {
        actorUserId: "U1",
        googleCalendarId: "primary",
        googleEventId: "event-1",
        linkId: "link-1",
        startsAt: "2026-05-12T10:00:00.000Z",
        teamId: "T1",
        workItemId: "W1",
      },
      toolCallId: "call-1",
      toolName: "link_google_calendar_event",
    });

    expect(repository.linkInputs[0]).toMatchObject({
      actorUserId: "U1",
      applyStartsAtToDueAt: false,
      calendarLink: {
        external_calendar_id: "primary",
        external_event_id: "event-1",
        link_id: "link-1",
        provider_kind: "google_calendar",
        starts_at: "2026-05-12T10:00:00.000Z",
        sync_status: "active",
      },
      teamId: "T1",
      workItemId: "W1",
    });
    expect(repository.linkInputs[0]).not.toHaveProperty("applyStartsAtToNextAttentionAtForUserId");
    expect(result.output).toMatchObject({
      action: "linked",
      linkId: "link-1",
      workItemId: "W1",
    });
  });

  it("unlinks Google Calendar events through the repository boundary", async () => {
    const repository = new RecordingCalendarRepository();
    const registry = new AgentToolRegistry(createWorkManagerCalendarTools(repository));

    const result = await registry.execute({
      input: {
        actorUserId: "U1",
        linkId: "link-1",
        teamId: "T1",
        workItemId: "W1",
      },
      toolCallId: "call-1",
      toolName: "unlink_google_calendar_event",
    });

    expect(repository.unlinkInputs[0]).toEqual({
      actorUserId: "U1",
      linkId: "link-1",
      teamId: "T1",
      workItemId: "W1",
    });
    expect(result.output).toMatchObject({
      action: "unlinked",
      linkId: "link-1",
      workItemId: "W1",
    });
  });
});

class RecordingCalendarRepository implements WorkItemCalendarLinkRepository {
  readonly linkInputs: Parameters<WorkItemCalendarLinkRepository["linkCalendarEvent"]>[0][] = [];
  readonly unlinkInputs: Parameters<WorkItemCalendarLinkRepository["unlinkCalendarEvent"]>[0][] =
    [];

  async linkCalendarEvent(
    input: Parameters<WorkItemCalendarLinkRepository["linkCalendarEvent"]>[0],
  ) {
    this.linkInputs.push(input);
    return emptyAggregate(input.workItemId);
  }

  async unlinkCalendarEvent(
    input: Parameters<WorkItemCalendarLinkRepository["unlinkCalendarEvent"]>[0],
  ) {
    this.unlinkInputs.push(input);
    return emptyAggregate(input.workItemId);
  }
}

function emptyAggregate(workItemId: string) {
  return {
    attentionIndexes: [],
    calendarLinks: [],
    item: { work_item_id: workItemId },
    participants: [],
    recentEvents: [],
  };
}
