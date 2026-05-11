import type { AppSettings } from "../config.js";

export type HealthPayload = {
  service: string;
  status: "ok";
};

/**
 * Build the health-check response payload.
 *
 * @param settings - Runtime settings for the current application process.
 * @returns JSON-serializable health status.
 */
export function buildHealthPayload(settings: AppSettings): HealthPayload {
  return {
    service: settings.appName,
    status: "ok",
  };
}
