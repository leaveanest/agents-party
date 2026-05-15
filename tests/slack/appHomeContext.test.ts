import { describe, expect, it } from "vite-plus/test";

import { resolveSlackAppHomeContext } from "../../src/slack/appHomeContext.js";

describe("resolveSlackAppHomeContext", () => {
  it("resolves standalone workspace context", () => {
    expect(
      resolveSlackAppHomeContext({
        body: { team_id: "T1" },
        event: { user: "U1" },
      }),
    ).toEqual({
      authorizationTeamId: undefined,
      enterpriseId: undefined,
      eventTeamId: undefined,
      isEnterpriseInstall: undefined,
      mode: "standalone",
      sourceTeamId: "T1",
      userTeamId: undefined,
    });
  });

  it("resolves Enterprise Grid context from enterprise and authorization fields", () => {
    expect(
      resolveSlackAppHomeContext({
        body: {
          authorizations: [
            {
              enterprise_id: "E1",
              is_enterprise_install: true,
              team_id: "T2",
            },
          ],
          enterprise: { id: "E1" },
          user: { id: "U1", team_id: "T-random" },
        },
        event: { team: "T-event", user: "U1" },
      }),
    ).toEqual({
      authorizationTeamId: "T2",
      enterpriseId: "E1",
      eventTeamId: "T-event",
      isEnterpriseInstall: true,
      mode: "enterprise_grid",
      sourceTeamId: "T-random",
      userTeamId: "T-random",
    });
  });
});
