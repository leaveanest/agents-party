import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

export type RssUrlHostnameResolver = (hostname: string) => Promise<readonly string[]>;

export class UnsafeRssFeedUrlError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Unsafe RSS feed URL '${url}': ${reason}`);
    this.name = "UnsafeRssFeedUrlError";
  }
}

export async function fetchSafeRssUrl(input: {
  fetchFn?: typeof fetch;
  init?: RequestInit;
  maxRedirects?: number;
  resolveHostname?: RssUrlHostnameResolver;
  url: string;
}): Promise<Response> {
  const fetchFn = input.fetchFn ?? (undiciFetch as typeof fetch);
  const maxRedirects = input.maxRedirects ?? 5;
  const dispatcher =
    input.fetchFn === undefined ? safeDispatcher(input.resolveHostname) : undefined;
  let url = input.url;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafeRssUrl(url, input.resolveHostname);
    const response = await fetchFn(url, {
      ...input.init,
      ...(dispatcher === undefined ? {} : { dispatcher }),
      redirect: "manual",
    } as RequestInit);
    if (!isRedirectResponse(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null || location.trim().length === 0) {
      throw new UnsafeRssFeedUrlError(url, "redirect_missing_location");
    }
    url = new URL(location, url).toString();
  }
  throw new UnsafeRssFeedUrlError(url, "too_many_redirects");
}

export async function assertSafeRssUrl(
  url: string,
  resolveHostname: RssUrlHostnameResolver = defaultResolveHostname,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeRssFeedUrlError(url, "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeRssFeedUrlError(url, "unsupported_protocol");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new UnsafeRssFeedUrlError(url, "credentials_not_allowed");
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (isLocalHostname(hostname)) {
    throw new UnsafeRssFeedUrlError(url, "local_hostname");
  }
  await resolveSafeHostname(hostname, url, resolveHostname);
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((address) => address.address);
}

async function resolveSafeHostname(
  hostname: string,
  url: string,
  resolveHostname: RssUrlHostnameResolver,
): Promise<readonly string[]> {
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) === 0 ? await resolveHostname(hostname) : [hostname];
  } catch {
    throw new UnsafeRssFeedUrlError(url, "hostname_unresolved");
  }
  if (addresses.length === 0) {
    throw new UnsafeRssFeedUrlError(url, "hostname_unresolved");
  }
  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new UnsafeRssFeedUrlError(url, "non_public_address");
    }
  }
  return addresses;
}

let defaultSafeDispatcher: Agent | undefined;

function safeDispatcher(resolveHostname: RssUrlHostnameResolver = defaultResolveHostname): Agent {
  if (resolveHostname === defaultResolveHostname) {
    defaultSafeDispatcher ??= createSafeDispatcher(resolveHostname);
    return defaultSafeDispatcher;
  }
  return createSafeDispatcher(resolveHostname);
}

function createSafeDispatcher(resolveHostname: RssUrlHostnameResolver): Agent {
  const connect = buildConnector({});
  return new Agent({
    connect(options, callback) {
      const hostname = normalizeHostname(options.hostname);
      const url = `${options.protocol}//${options.host ?? options.hostname}`;
      resolveSafeHostname(hostname, url, resolveHostname)
        .then((addresses) => {
          connect(
            {
              ...options,
              hostname: addresses[0],
              servername: options.servername ?? hostname,
            },
            callback,
          );
        })
        .catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)), null);
        });
    },
  });
}

function isRedirectResponse(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPublicIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPublicIpv6(normalized);
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && (b === 0 || b === 168)) {
    return false;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  ) {
    return false;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return true;
}
