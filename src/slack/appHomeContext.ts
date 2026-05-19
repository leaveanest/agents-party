import type { StringIndexed } from "@slack/bolt";

export type SlackAppHomeMode = "enterprise_grid" | "standalone" | "unknown";

export type SlackAppHomeContext = {
  authorizationTeamId?: string;
  enterpriseId?: string;
  eventTeamId?: string;
  isEnterpriseInstall?: boolean;
  mode: SlackAppHomeMode;
  sourceTeamId?: string;
  userTeamId?: string;
};

export function resolveSlackAppHomeContext(input: {
  body: unknown;
  event: StringIndexed;
}): SlackAppHomeContext {
  const sourceTeamId = readTeamId(input.body, input.event);
  const enterpriseId = readSlackEnterpriseId(input.body);
  const isEnterpriseInstall = readSlackEnterpriseInstall(input.body);
  const mode =
    enterpriseId !== undefined || isEnterpriseInstall === true
      ? "enterprise_grid"
      : sourceTeamId !== undefined
        ? "standalone"
        : "unknown";
  return {
    authorizationTeamId: readFirstAuthorizationString(input.body, "team_id"),
    enterpriseId,
    eventTeamId: readString(input.event, "team"),
    isEnterpriseInstall,
    mode,
    sourceTeamId,
    userTeamId: readUserTeamId(input.body),
  };
}

export function readTeamId(body: unknown, event: StringIndexed): string | undefined {
  if (isRecord(body)) {
    if (typeof body.team_id === "string" && body.team_id.length > 0) {
      return body.team_id;
    }
    if (typeof body.team === "string" && body.team.length > 0) {
      return body.team;
    }
    if (isRecord(body.team) && typeof body.team.id === "string" && body.team.id.length > 0) {
      return body.team.id;
    }
    const userTeamId = readUserTeamId(body);
    if (userTeamId !== undefined) {
      return userTeamId;
    }
    const authorizationTeamId = readFirstAuthorizationString(body, "team_id");
    if (authorizationTeamId !== undefined) {
      return authorizationTeamId;
    }
  }
  return readString(event, "team");
}

export function readSlackEnterpriseId(body: unknown): string | undefined {
  return (
    readBodyString(body, "enterprise_id") ??
    readNestedString(body, "enterprise", "id") ??
    readFirstAuthorizationString(body, "enterprise_id")
  );
}

export function readSlackEnterpriseInstall(body: unknown): boolean | undefined {
  return (
    readBodyBoolean(body, "is_enterprise_install") ??
    readFirstAuthorizationBoolean(body, "is_enterprise_install")
  );
}

function readUserTeamId(body: unknown): string | undefined {
  return isRecord(body) && isRecord(body.user) && typeof body.user.team_id === "string"
    ? body.user.team_id
    : undefined;
}

function readString(value: StringIndexed, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readBodyString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readBodyBoolean(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[field] === "boolean" ? value[field] : undefined;
}

function readNestedString(
  value: unknown,
  parentField: string,
  childField: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parent = value[parentField];
  return isRecord(parent) ? readString(parent, childField) : undefined;
}

function readFirstAuthorizationString(body: unknown, field: string): string | undefined {
  const authorization = readFirstAuthorization(body);
  const fieldValue = authorization?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readFirstAuthorizationBoolean(body: unknown, field: string): boolean | undefined {
  const authorization = readFirstAuthorization(body);
  return typeof authorization?.[field] === "boolean" ? authorization[field] : undefined;
}

function readFirstAuthorization(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.authorizations)) {
    return undefined;
  }
  const [authorization] = body.authorizations;
  return isRecord(authorization) ? authorization : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
