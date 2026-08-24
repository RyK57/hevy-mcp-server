/**
 * Progress tools: per-exercise history, body measurements, and account info.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MEASUREMENT_FIELDS } from "../constants.js";
import { formatBodyMeasurement, formatHistoryEntry } from "../formatters/entities.js";
import {
  buildPagination,
  emptyResult,
  formatWeight,
  paginationFooter,
  round,
  toolResult,
  withErrorHandling,
} from "../formatters/response.js";
import {
  createBodyMeasurementSchema,
  getBodyMeasurementSchema,
  getExerciseHistorySchema,
  getUserInfoSchema,
  listBodyMeasurementsSchema,
  updateBodyMeasurementSchema,
} from "../schemas/inputs.js";
import {
  historyOutput,
  listOutput,
  mutationOutput,
  singleOutput,
  userInfoOutput,
} from "../schemas/outputs.js";
import type { HevyClientConfig } from "../services/hevy-client.js";
import { request } from "../services/hevy-client.js";
import type { BodyMeasurement, ExerciseHistoryEntry, UserInfo } from "../types.js";

interface MeasurementListResponse {
  page: number;
  page_count: number;
  body_measurements: BodyMeasurement[];
}

/** Strips undefined so omitted optional fields are not sent as explicit nulls on create. */
const measurementValues = (
  params: Record<string, unknown>,
): Record<string, number | null> => {
  const values: Record<string, number | null> = {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = params[field];
    if (value !== undefined) values[field] = value as number | null;
  }
  return values;
};

/** Best set of a history entry list, by estimated one-rep max (Epley). */
const bestSet = (entries: ExerciseHistoryEntry[]): { entry: ExerciseHistoryEntry; e1rm: number } | null => {
  let best: { entry: ExerciseHistoryEntry; e1rm: number } | null = null;
  for (const entry of entries) {
    if (entry.weight_kg == null || entry.reps == null || entry.reps < 1) continue;
    const e1rm = entry.weight_kg * (1 + entry.reps / 30);
    if (!best || e1rm > best.e1rm) best = { entry, e1rm };
  }
  return best;
};

export const registerProgressTools = (server: McpServer, config: HevyClientConfig): void => {
  server.registerTool(
    "hevy_get_exercise_history",
    {
      title: "Get Hevy Exercise History",
      description: `Get every logged set of one exercise across all workouts, newest first.

This is the tool for progression questions — "am I getting stronger on squats", "what did I bench last time", "plot my overhead press over the last three months". It returns individual sets, each tagged with the workout it came from, so you can compute trends directly.

The markdown view also reports the best set by estimated 1RM (Epley formula: weight x (1 + reps/30)).

Args:
  - exercise_template_id (string): template id from hevy_search_exercise_templates
  - start_date (string): optional ISO 8601 lower bound, e.g. '2026-06-01T00:00:00Z'
  - end_date (string): optional ISO 8601 upper bound
  - limit (number): maximum set entries to return, 1-500 (default: 100)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "exercise_template_id": string,
    "count": number,          // entries returned after the limit
    "total_entries": number,  // entries the API returned before the limit
    "truncated": boolean,
    "exercise_history": [ { "workout_id": string, "workout_title": string,
                            "workout_start_time": string, "weight_kg": number | null,
                            "reps": number | null, "rpe": number | null,
                            "set_type": string } ]
  }

Examples:
  - "Has my bench gone up since June?" -> resolve the id, then start_date='2026-06-01T00:00:00Z'
  - "What did I squat last session?" -> limit=10 and read the newest entries
  - Don't use when: you want a whole session (use hevy_get_workout)

Error Handling:
  - Returns 400 for a malformed date or an unknown template id
  - An exercise never performed returns an empty history, not an error`,
      inputSchema: getExerciseHistorySchema,
      outputSchema: historyOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getExerciseHistorySchema>) => {
      const data = await request<{ exercise_history: ExerciseHistoryEntry[] }>(
        config,
        `/v1/exercise_history/${encodeURIComponent(params.exercise_template_id)}`,
        {
          query: {
            ...(params.start_date ? { start_date: params.start_date } : {}),
            ...(params.end_date ? { end_date: params.end_date } : {}),
          },
        },
      );

      const all = data?.exercise_history ?? [];
      const entries = all.slice(0, params.limit);
      const structured = {
        exercise_template_id: params.exercise_template_id,
        count: entries.length,
        total_entries: all.length,
        truncated: all.length > entries.length,
        exercise_history: entries,
      };

      if (entries.length === 0) {
        return emptyResult(
          `No logged sets for exercise ${params.exercise_template_id}` +
            (params.start_date || params.end_date ? " in that date range" : "") +
            ". Confirm the template id with hevy_search_exercise_templates, or widen the dates.",
          structured,
        );
      }

      return toolResult(
        params.response_format,
        structured,
        () => {
          const best = bestSet(entries);
          const lines = [
            `# History for exercise ${params.exercise_template_id}`,
            "",
            `${entries.length} set(s)${structured.truncated ? ` of ${all.length} (limited)` : ""}, newest first.`,
          ];
          if (best) {
            lines.push(
              `Best set: ${formatWeight(best.entry.weight_kg)} x ${best.entry.reps} ` +
                `(est. 1RM ${round(best.e1rm, 1)} kg) on ${best.entry.workout_start_time?.slice(0, 10) ?? "unknown date"}.`,
            );
          }
          lines.push("", entries.map(formatHistoryEntry).join("\n"));
          return lines.join("\n");
        },
        "Lower 'limit' or narrow the date range.",
      );
    }),
  );

  server.registerTool(
    "hevy_list_body_measurements",
    {
      title: "List Hevy Body Measurements",
      description: `List body measurement entries, newest first.

Covers body weight, lean mass, body fat percentage and circumference measurements. Use it for weight-trend questions.

Weights are stored in KILOGRAMS; the markdown view shows pounds alongside.

Args:
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-10 (default: 10)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number, "page_count": number, "count": number, "has_more": boolean,
    "body_measurements": [ { "date": "YYYY-MM-DD", "weight_kg": number | null,
                             "lean_mass_kg": number | null, "fat_percent": number | null,
                             "chest_cm": number | null, "waist": number | null, ... } ]
  }

Examples:
  - "How has my weight trended this month?" -> page through and compare weight_kg by date
  - "What was my last recorded body fat?" -> page=1, read the newest entry with fat_percent set`,
      inputSchema: listBodyMeasurementsSchema,
      outputSchema: listOutput("body_measurements"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listBodyMeasurementsSchema>) => {
      const data = await request<MeasurementListResponse>(config, "/v1/body_measurements", {
        query: { page: params.page, pageSize: params.page_size },
      });

      const measurements = data?.body_measurements ?? [];
      const meta = buildPagination(
        data?.page ?? params.page,
        data?.page_count ?? 1,
        measurements.length,
      );
      const structured = { ...meta, body_measurements: measurements };

      if (measurements.length === 0) {
        return emptyResult(
          `No body measurements on page ${params.page}. ` +
            "Add one with hevy_create_body_measurement, or try page=1.",
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Body measurements (page ${meta.page} of ${meta.page_count})`,
          "",
          measurements.map(formatBodyMeasurement).join("\n\n"),
          paginationFooter(meta, "hevy_list_body_measurements"),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hevy_get_body_measurement",
    {
      title: "Get Hevy Body Measurement",
      description: `Fetch the body measurement entry for one date.

Args:
  - date (string): the date, YYYY-MM-DD
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "body_measurement": { "date": string, "weight_kg": number | null,
                          "fat_percent": number | null, ... } }

Examples:
  - "What did I weigh on August 1st?" -> date='2026-08-01'
  - Call this before hevy_update_body_measurement so you can resend the fields you want to keep

Error Handling:
  - Returns a 404 message when no entry exists for that date`,
      inputSchema: getBodyMeasurementSchema,
      outputSchema: singleOutput("body_measurement"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getBodyMeasurementSchema>) => {
      const measurement = await request<BodyMeasurement>(
        config,
        `/v1/body_measurements/${encodeURIComponent(params.date)}`,
      );

      return toolResult(
        params.response_format,
        { body_measurement: measurement },
        () => formatBodyMeasurement(measurement),
      );
    }),
  );

  server.registerTool(
    "hevy_create_body_measurement",
    {
      title: "Create Hevy Body Measurement",
      description: `Record a new body measurement entry for a date.

This WRITES to the user's account. Only one entry can exist per date — creating a second returns 409, in which case use hevy_update_body_measurement instead.

Weights are KILOGRAMS. Convert pounds first: kg = lb / 2.20462. Circumferences are centimetres.

Args:
  - date (string): the date, YYYY-MM-DD
  - weight_kg, lean_mass_kg (number | null): mass in kilograms
  - fat_percent (number | null): body fat percentage, 0-100
  - neck_cm, shoulder_cm, chest_cm, left_bicep_cm, right_bicep_cm, left_forearm_cm,
    right_forearm_cm, abdomen, waist, hips, left_thigh, right_thigh, left_calf,
    right_calf (number | null): circumferences in centimetres

Returns:
  { "success": true, "message": string }

Examples:
  - "Log today's weigh-in at 66 kg" -> date=today, weight_kg=66
  - "I weighed 145.5 lb this morning" -> convert to kg (66.0) before sending

Error Handling:
  - Returns 409 when an entry already exists for that date — switch to the update tool`,
      inputSchema: createBodyMeasurementSchema,
      outputSchema: mutationOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof createBodyMeasurementSchema>) => {
      const values = measurementValues(params as unknown as Record<string, unknown>);
      await request<unknown>(config, "/v1/body_measurements", {
        method: "POST",
        body: { date: params.date, ...values },
      });

      const summary = Object.entries(values)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) =>
          key.endsWith("_kg") ? `${key}: ${formatWeight(value as number)}` : `${key}: ${value}`,
        )
        .join(", ");

      const structured = {
        success: true,
        message: `Recorded body measurement for ${params.date}`,
      };

      return toolResult(
        "markdown",
        structured,
        () => `Recorded body measurement for **${params.date}** — ${summary || "no values provided"}.`,
      );
    }),
  );

  server.registerTool(
    "hevy_update_body_measurement",
    {
      title: "Update Hevy Body Measurement",
      description: `Overwrite the body measurement entry for a date.

DESTRUCTIVE: every field is replaced. Fields you omit are set to null, wiping any value previously recorded for them. Fetch the entry with hevy_get_body_measurement first and resend everything you want to keep.

Weights are KILOGRAMS; circumferences are centimetres.

Args:
  - date (string): the date of the entry to overwrite, YYYY-MM-DD
  - weight_kg, lean_mass_kg, fat_percent, and the circumference fields: the entry's
    complete desired end state (same field list as hevy_create_body_measurement)

Returns:
  { "success": true, "message": string }

Examples:
  - "Correct yesterday's weight to 66.2" -> get the entry, resend all its fields with weight_kg=66.2
  - Don't use when: no entry exists yet for that date (use hevy_create_body_measurement)

Error Handling:
  - Returns 404 when there is no entry on that date to update`,
      inputSchema: updateBodyMeasurementSchema,
      outputSchema: mutationOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof updateBodyMeasurementSchema>) => {
      const values = measurementValues(params as unknown as Record<string, unknown>);
      await request<unknown>(
        config,
        `/v1/body_measurements/${encodeURIComponent(params.date)}`,
        { method: "PUT", body: values },
      );

      const structured = {
        success: true,
        message: `Updated body measurement for ${params.date}`,
      };

      return toolResult(
        "markdown",
        structured,
        () =>
          `Updated body measurement for **${params.date}**. ` +
          "Any field not included in this call is now null.",
      );
    }),
  );

  server.registerTool(
    "hevy_get_user_info",
    {
      title: "Get Hevy User Info",
      description: `Get the authenticated account's id, display name and public profile URL.

Also the cheapest way to verify the API key works before attempting writes.

Args: none

Returns:
  { "id": string, "name": string, "url": string }

Examples:
  - "Whose Hevy account is connected?" -> call with no arguments
  - Call first when a write fails with 401/403, to confirm whether the key itself is the problem`,
      inputSchema: getUserInfoSchema,
      outputSchema: userInfoOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      const data = await request<{ data?: UserInfo } & UserInfo>(config, "/v1/user/info");
      const user: UserInfo = data?.data ?? data ?? {};
      const structured: Record<string, unknown> = { ...user };

      return toolResult(
        "markdown",
        structured,
        () =>
          [
            `**${user.name ?? "Unknown user"}**`,
            `- id: ${user.id ?? "unknown"}`,
            `- profile: ${user.url ?? "not public"}`,
          ].join("\n"),
      );
    }),
  );
};
