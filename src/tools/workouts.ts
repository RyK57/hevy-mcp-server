/**
 * Workout tools — reading the training log and writing new sessions to it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatWorkout, formatWorkoutEvent } from "../formatters/entities.js";
import {
  buildPagination,
  emptyResult,
  paginationFooter,
  toolResult,
  withErrorHandling,
} from "../formatters/response.js";
import {
  countWorkoutsSchema,
  createWorkoutSchema,
  getWorkoutSchema,
  listWorkoutEventsSchema,
  listWorkoutsSchema,
  updateWorkoutSchema,
  workoutExerciseSchema,
} from "../schemas/inputs.js";
import { listOutput, singleOutput, workoutCountOutput } from "../schemas/outputs.js";
import type { HevyClientConfig } from "../services/hevy-client.js";
import { request } from "../services/hevy-client.js";
import type { Workout, WorkoutEvent } from "../types.js";

interface WorkoutListResponse {
  page: number;
  page_count: number;
  workouts: Workout[];
}

interface WorkoutEventsResponse {
  page: number;
  page_count: number;
  events: WorkoutEvent[];
}

/**
 * The workout fields Hevy accepts on both create and update. Declared
 * structurally rather than as a schema inference so the session tools, which
 * assemble a body from a stored workout rather than from tool input, can reuse
 * this without inheriting `createWorkoutSchema`'s minimum-one-exercise rule.
 */
export interface WorkoutBodyInput {
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
  is_private: boolean;
  exercises: z.infer<typeof workoutExerciseSchema>[];
}

/** Maps validated tool input to the request body Hevy expects. */
export const toWorkoutBody = (params: WorkoutBodyInput) => ({
  workout: {
    title: params.title,
    description: params.description ?? null,
    start_time: params.start_time,
    end_time: params.end_time,
    is_private: params.is_private,
    exercises: params.exercises.map((exercise) => ({
      exercise_template_id: exercise.exercise_template_id,
      superset_id: exercise.superset_id ?? null,
      notes: exercise.notes ?? null,
      sets: exercise.sets.map((set) => ({
        type: set.type,
        weight_kg: set.weight_kg ?? null,
        reps: set.reps ?? null,
        distance_meters: set.distance_meters ?? null,
        duration_seconds: set.duration_seconds ?? null,
        custom_metric: set.custom_metric ?? null,
        rpe: set.rpe ?? null,
      })),
    })),
  },
});

export const registerWorkoutTools = (server: McpServer, config: HevyClientConfig): void => {
  server.registerTool(
    "hevy_list_workouts",
    {
      title: "List Hevy Workouts",
      description: `List completed workouts from the Hevy training log, newest first.

Use this to review recent training, compute weekly volume, or find the id of a workout to fetch in full. It reads only completed workouts — for planned templates use hevy_list_routines instead.

Args:
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-10 — Hevy rejects anything larger (default: 5)
  - detailed (boolean): include every set of every exercise (default: false)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number,          // current page
    "page_count": number,    // total pages available
    "count": number,         // workouts in this response
    "has_more": boolean,
    "next_page": number,     // present only when has_more is true
    "workouts": [ { "id": string, "title": string, "start_time": string,
                    "end_time": string, "exercises": [...] } ]
  }

Examples:
  - "What did I train this week?" -> page_size=5, detailed=false
  - "Show every set from my last session" -> page_size=1, detailed=true
  - Don't use when: you want one specific workout you already have the id for (use hevy_get_workout)

Error Handling:
  - page_size above 10 is rejected before the request is sent
  - A page beyond page_count returns an empty list, not an error`,
      inputSchema: listWorkoutsSchema,
      outputSchema: listOutput("workouts"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listWorkoutsSchema>) => {
      const data = await request<WorkoutListResponse>(config, "/v1/workouts", {
        query: { page: params.page, pageSize: params.page_size },
      });

      const workouts = data?.workouts ?? [];
      const meta = buildPagination(data?.page ?? params.page, data?.page_count ?? 1, workouts.length);
      const structured = { ...meta, workouts };

      if (workouts.length === 0) {
        return emptyResult(
          `No workouts on page ${params.page} (${meta.page_count} page(s) exist). ` +
            "Try page=1, or call hevy_count_workouts to check the account has any logged workouts.",
          structured,
        );
      }

      return toolResult(
        params.response_format,
        structured,
        () =>
          [
            `# Workouts (page ${meta.page} of ${meta.page_count})`,
            "",
            workouts.map((workout) => formatWorkout(workout, params.detailed)).join("\n\n"),
            paginationFooter(meta, "hevy_list_workouts"),
          ].join("\n"),
        "Set detailed=false or lower page_size to fit more workouts per call.",
      );
    }),
  );

  server.registerTool(
    "hevy_get_workout",
    {
      title: "Get Hevy Workout",
      description: `Fetch one completed workout in full, including every exercise, set, weight, rep count and RPE.

Args:
  - workout_id (string): the workout UUID, as returned by hevy_list_workouts
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "workout": { "id": string, "title": string, "description": string | null,
                 "start_time": string, "end_time": string, "routine_id": string | null,
                 "exercises": [ { "title": string, "exercise_template_id": string,
                                  "sets": [ { "type": string, "weight_kg": number | null,
                                              "reps": number | null, "rpe": number | null } ] } ] } }

Examples:
  - "Break down my Monday session set by set" -> workout_id from hevy_list_workouts
  - Don't use when: you want history for one exercise across many sessions (use hevy_get_exercise_history)

Error Handling:
  - Returns a 404 message if the id does not exist or belongs to another account`,
      inputSchema: getWorkoutSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getWorkoutSchema>) => {
      const workout = await request<Workout>(
        config,
        `/v1/workouts/${encodeURIComponent(params.workout_id)}`,
      );

      return toolResult(params.response_format, { workout }, () => formatWorkout(workout, true));
    }),
  );

  server.registerTool(
    "hevy_count_workouts",
    {
      title: "Count Hevy Workouts",
      description: `Return the total number of workouts logged on the account.

Cheap way to size the log before paginating, or to answer "how many sessions have I done".

Args: none

Returns:
  { "workout_count": number }

Examples:
  - "How many workouts have I logged?" -> call with no arguments
  - Use before hevy_list_workouts when you need to know how deep the history goes`,
      inputSchema: countWorkoutsSchema,
      outputSchema: workoutCountOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      const data = await request<{ workout_count: number }>(config, "/v1/workouts/count");
      const structured = { workout_count: data?.workout_count ?? 0 };
      return toolResult(
        "markdown",
        structured,
        () => `**${structured.workout_count}** workouts logged on this account.`,
      );
    }),
  );

  server.registerTool(
    "hevy_list_workout_events",
    {
      title: "List Hevy Workout Events",
      description: `List workout updates and deletions since a timestamp, newest first.

Built for incremental sync: instead of re-fetching the whole log, ask what changed since your last sync and apply only those events. Deleted workouts appear here and nowhere else.

Args:
  - since (string): ISO 8601 timestamp, e.g. '2026-08-01T00:00:00Z' (default: '1970-01-01T00:00:00Z')
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-10 (default: 10)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number, "page_count": number, "count": number, "has_more": boolean,
    "events": [ { "type": "updated", "workout": {...} }
              | { "type": "deleted", "id": string, "deleted_at": string } ]
  }

Examples:
  - "What changed in my log since last Monday?" -> since='2026-08-17T00:00:00Z'
  - "Were any workouts deleted recently?" -> scan events for type='deleted'
  - Don't use when: you want the current state of the log (use hevy_list_workouts)

Error Handling:
  - A malformed 'since' value is rejected before the request is sent`,
      inputSchema: listWorkoutEventsSchema,
      outputSchema: listOutput("events"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listWorkoutEventsSchema>) => {
      const data = await request<WorkoutEventsResponse>(config, "/v1/workouts/events", {
        query: { since: params.since, page: params.page, pageSize: params.page_size },
      });

      const events = data?.events ?? [];
      const meta = buildPagination(data?.page ?? params.page, data?.page_count ?? 1, events.length);
      const structured = { ...meta, events };

      if (events.length === 0) {
        return emptyResult(`No workout changes since ${params.since}.`, structured);
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Workout events since ${params.since}`,
          "",
          events.map(formatWorkoutEvent).join("\n"),
          paginationFooter(meta, "hevy_list_workout_events"),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hevy_create_workout",
    {
      title: "Create Hevy Workout",
      description: `Log a new completed workout to Hevy.

This WRITES to the user's training log and the entry appears in their history immediately. Confirm the exercises, weights and reps with the user before calling.

Weights are KILOGRAMS. Convert pounds first: kg = lb / 2.20462. Every exercise needs a valid exercise_template_id — look it up with hevy_search_exercise_templates rather than guessing.

Args:
  - title (string): workout title, e.g. 'Upper A'
  - description (string | null): optional notes for the session
  - start_time (string): ISO 8601 start, e.g. '2026-08-24T18:00:00Z'
  - end_time (string): ISO 8601 end
  - is_private (boolean): hide from public profile (default: false)
  - exercises (array): each { exercise_template_id, superset_id?, notes?, sets: [...] }
      where each set is { type: 'warmup'|'normal'|'failure'|'dropset',
                          weight_kg?, reps?, distance_meters?, duration_seconds?,
                          custom_metric?, rpe?: 6|7|7.5|8|8.5|9|9.5|10 }

Returns:
  { "workout": { "id": string, ... } }  // the created workout, including its new id

Examples:
  - "Log today's bench: 3x8 at 60kg" -> one exercise, three sets with weight_kg=60, reps=8
  - "Log a superset of curls and pushdowns" -> give both exercises the same superset_id, e.g. 0
  - Don't use when: you are planning future training (use hevy_create_routine)

Error Handling:
  - An unknown exercise_template_id returns a 400 — resolve ids first
  - Set types outside the four allowed values are rejected before sending`,
      inputSchema: createWorkoutSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof createWorkoutSchema>) => {
      const workout = await request<Workout>(config, "/v1/workouts", {
        method: "POST",
        body: toWorkoutBody(params),
      });

      return toolResult(
        "markdown",
        { workout },
        () => `Created workout **${params.title}** (id: ${workout?.id ?? "unknown"}).\n\n${formatWorkout(workout ?? { id: "unknown" }, true)}`,
      );
    }),
  );

  server.registerTool(
    "hevy_update_workout",
    {
      title: "Update Hevy Workout",
      description: `Overwrite an existing workout.

DESTRUCTIVE: this is a full replacement, not a patch. Any exercise or set you omit is removed from the workout. Fetch the current state with hevy_get_workout first, apply your changes to that full structure, then send the complete result.

Args:
  - workout_id (string): UUID of the workout to overwrite
  - title, description, start_time, end_time, is_private, exercises: same shape as hevy_create_workout,
    representing the workout's complete desired end state

Returns:
  { "workout": { "id": string, ... } }  // the workout after the update

Examples:
  - "Fix the weight on set 2 of my last session" -> get_workout, change that set, send everything back
  - Don't use when: adding a brand new session (use hevy_create_workout)

Error Handling:
  - Returns 404 if the workout id does not exist
  - Returns 400 if any exercise_template_id is unknown`,
      inputSchema: updateWorkoutSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof updateWorkoutSchema>) => {
      const { workout_id: workoutId, ...rest } = params;
      const workout = await request<Workout>(
        config,
        `/v1/workouts/${encodeURIComponent(workoutId)}`,
        { method: "PUT", body: toWorkoutBody(rest) },
      );

      return toolResult(
        "markdown",
        { workout },
        () => `Updated workout **${params.title}** (id: ${workoutId}).\n\n${formatWorkout(workout ?? { id: workoutId }, true)}`,
      );
    }),
  );
};
