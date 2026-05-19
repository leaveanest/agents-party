import type {
  SlackMcpTokenLookup,
  SlackMcpTokenResolution,
  SlackMcpTokenResolver,
} from "../agents/slackMcp/index.js";
import type { SlackInstallationLookup, SlackInstallationRepository } from "./installationStore.js";

export function createSlackInstallationMcpTokenResolver(
  repository: SlackInstallationRepository,
): SlackMcpTokenResolver {
  return {
    async resolve(input: SlackMcpTokenLookup): Promise<SlackMcpTokenResolution | undefined> {
      const teamInstallation = await repository.findInstallation(teamScopedLookupFromInput(input));
      const installation =
        teamInstallation?.userToken !== undefined || input.isEnterpriseInstall !== true
          ? teamInstallation
          : await repository.findInstallation(enterpriseScopedLookupFromInput(input));
      if (installation?.userToken === undefined || installation.userId !== input.userId) {
        return undefined;
      }
      return {
        scopes: splitScopes(installation.userScopes),
        token: installation.userToken,
      };
    },
  };
}

function teamScopedLookupFromInput(input: SlackMcpTokenLookup): SlackInstallationLookup {
  return {
    enterpriseId: input.enterpriseId,
    isEnterpriseInstall: false,
    teamId: input.teamId,
    userId: input.userId,
  };
}

function enterpriseScopedLookupFromInput(input: SlackMcpTokenLookup): SlackInstallationLookup {
  return {
    enterpriseId: input.enterpriseId,
    isEnterpriseInstall: true,
    teamId: input.teamId,
    userId: input.userId,
  };
}

function splitScopes(scopes: string | undefined): string[] | undefined {
  return scopes === undefined || scopes.length === 0 ? undefined : scopes.split(",");
}
