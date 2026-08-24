/**
 * Thin functional wrapper over the Hevy REST API.
 *
 * Uses the global fetch available in Node 18+ so the server ships with no HTTP
 * dependency. Every request carries the `api-key` header Hevy requires and an
 * AbortController-based timeout.
 */

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
} from "../constants.js";

export interface HevyClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

type HttpMethod = "GET" | "POST" | "PUT";

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Error carrying the HTTP status so callers can produce status-specific,
 * actionable guidance instead of a generic failure string.
 *
 * Built with a factory rather than a subclass: it is a real Error (so stack
 * traces and `instanceof Error` still work) with the extra fields attached.
 */
export interface HevyApiError extends Error {
  readonly isHevyApiError: true;
  readonly status: number;
  readonly endpoint: string;
  readonly detail: string | undefined;
}

export const hevyApiError = (
  status: number,
  endpoint: string,
  detail?: string,
): HevyApiError =>
  Object.assign(new Error(`Hevy API ${status} on ${endpoint}${detail ? `: ${detail}` : ""}`), {
    name: "HevyApiError",
    isHevyApiError: true as const,
    status,
    endpoint,
    detail,
  });

export const isHevyApiError = (error: unknown): error is HevyApiError =>
  typeof error === "object" &&
  error !== null &&
  (error as Partial<HevyApiError>).isHevyApiError === true;

/**
 * Reads configuration from the environment and fails fast with setup
 * instructions when the API key is missing or malformed.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): HevyClientConfig => {
  const apiKey = env.HEVY_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "HEVY_API_KEY is not set. Create a key at https://hevy.com/settings?developer " +
        "(requires a Hevy Pro subscription) and expose it to this server, e.g. " +
        'via the "env" block of your MCP client config.',
    );
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(apiKey)) {
    // Warn rather than throw: Hevy documents the key as a UUID, but the format
    // is not guaranteed to stay that way for a 0.0.1 API.
    console.error(
      "[hevy-mcp-server] Warning: HEVY_API_KEY does not look like a UUID. " +
        "If requests fail with 401, re-copy the key from https://hevy.com/settings?developer",
    );
  }

  const timeoutRaw = Number(env.HEVY_REQUEST_TIMEOUT_MS);

  return {
    apiKey,
    baseUrl: (env.HEVY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string => {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
};

/** Pulls the most useful message out of Hevy's inconsistent error bodies. */
const extractErrorDetail = (raw: string): string | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const message = record.error ?? record.message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Body was not JSON — fall through to the raw text.
  }
  return raw.slice(0, 300);
};

/**
 * Performs an authenticated request and returns the parsed JSON body.
 * Endpoints that return an empty body resolve to `undefined`.
 */
export const request = async <T>(
  config: HevyClientConfig,
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  const { method = "GET", query, body } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(buildUrl(config.baseUrl, path, query), {
      method,
      signal: controller.signal,
      headers: {
        "api-key": config.apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();

    if (!response.ok) {
      throw hevyApiError(response.status, `${method} ${path}`, extractErrorDetail(text));
    }

    if (!text.trim()) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw hevyApiError(response.status, `${method} ${path}`, "Response was not valid JSON");
    }
  } catch (error) {
    if (isHevyApiError(error)) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw hevyApiError(408, `${method} ${path}`, `Request timed out after ${config.timeoutMs}ms`);
    }
    throw hevyApiError(
      0,
      `${method} ${path}`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Maps an endpoint to the tool that can resolve a valid id for it, so a 404
 * tells the agent exactly which lookup to run rather than "check the id".
 */
const lookupHint = (endpoint: string): string => {
  if (endpoint.includes("/v1/workouts")) {
    return "No workout with that id. Get valid ids from hevy_list_workouts.";
  }
  if (endpoint.includes("/v1/routine_folders")) {
    return "No routine folder with that id. Get valid ids from hevy_list_routine_folders.";
  }
  if (endpoint.includes("/v1/routines")) {
    return "No routine with that id. Get valid ids from hevy_list_routines.";
  }
  if (endpoint.includes("/v1/exercise_templates") || endpoint.includes("/v1/exercise_history")) {
    return "No exercise template with that id. Resolve ids by name with hevy_search_exercise_templates.";
  }
  if (endpoint.includes("/v1/body_measurements")) {
    return (
      "No body measurement recorded for that date. Dates must be YYYY-MM-DD; " +
      "list recorded dates with hevy_list_body_measurements, or create the entry " +
      "with hevy_create_body_measurement."
    );
  }
  if (endpoint.includes("/v1/user/info")) {
    return "The account could not be resolved — check that HEVY_API_KEY belongs to an active account.";
  }
  return "Verify the id or date exists on this account.";
};

/**
 * Converts any thrown error into a message that tells the agent what to do
 * next, rather than just what went wrong.
 */
export const describeError = (error: unknown): string => {
  if (isHevyApiError(error)) {
    switch (error.status) {
      case 400:
        return (
          `Error: Hevy rejected the request (400) on ${error.endpoint}. ` +
          `${error.detail ?? "Invalid parameters."} ` +
          "Common causes: page_size above the endpoint's cap, a page number beyond page_count, " +
          "an unknown exercise_template_id, or a malformed ISO 8601 timestamp."
        );
      case 401:
      case 403:
        return (
          `Error: Hevy denied access (${error.status}) on ${error.endpoint}. ` +
          `${error.detail ?? ""} ` +
          "Check that HEVY_API_KEY is valid and that the account still has an active " +
          "Hevy Pro subscription — API access requires Pro. Regenerate the key at " +
          "https://hevy.com/settings?developer if needed."
        ).trim();
      case 404:
        return `Error: Not found (404) on ${error.endpoint}. ${lookupHint(error.endpoint)}`;
      case 408:
        return `Error: ${error.detail ?? "Request timed out."} Retry, or lower page_size to reduce the response size.`;
      case 409:
        return (
          `Error: Conflict (409) on ${error.endpoint}. ` +
          "A body measurement already exists for that date. Use hevy_update_body_measurement " +
          "to overwrite it instead."
        );
      case 429:
        return `Error: Rate limited (429) on ${error.endpoint}. Wait a few seconds before retrying, and avoid tight pagination loops.`;
      case 0:
        return (
          `Error: Could not reach the Hevy API (${error.detail ?? "network error"}). ` +
          "Check network connectivity and that HEVY_API_BASE_URL, if set, points at https://api.hevyapp.com."
        );
      default:
        if (error.status >= 500) {
          return `Error: Hevy server error (${error.status}) on ${error.endpoint}. This is on Hevy's side — retry shortly.`;
        }
        return `Error: Request failed (${error.status}) on ${error.endpoint}. ${error.detail ?? ""}`.trim();
    }
  }
  return `Error: Unexpected failure — ${error instanceof Error ? error.message : String(error)}`;
};
