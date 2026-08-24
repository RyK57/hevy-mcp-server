/**
 * Session tools — tracking a workout while it is still being performed.
 *
 * Hevy's API has no "start workout" endpoint and cannot drive the in-app timer,
 * so an open session is modelled as a real workout created at the start and
 * rewritten at the end. Its title carries SESSION_TITLE_PREFIX, which is the
 * only handle that survives between calls: this server keeps no state, so any
 * chat on any device can find the open session by looking for that prefix.
 *
 * The trade-off is deliberate — an unfinished session stays visible in the
 * training log until it is closed or abandoned, because Hevy exposes no delete.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  RPE_VALUES,
  SESSION_LOOKUP_PAGE_SIZE,
  SESSION_TITLE_PREFIX,
  SET_TYPES,
} from "../constants.js";
import { formatWorkout } from "../formatters/entities.js";
import { formatDuration, formatTimestamp, toolResult, withErrorHandling } from "../formatters/response.js";
import {
  cancelSessionSchema,
  finishSessionSchema,
  getActiveSessionSchema,
  startSessionSchema,
} from "../schemas/inputs.js";
import { singleOutput } from "../schemas/outputs.js";
import type { HevyClientConfig } from "../services/hevy-client.js";
import { isHevyApiError, request } from "../services/hevy-client.js";
import type { Workout } from "../types.js";
import { toWorkoutBody, type WorkoutBodyInput } from "./workouts.js";

type WorkoutExercises = WorkoutBodyInput["exercises"];

const now = (): string => new Date().toISOString();

const withPrefix = (title: string): string => `${SESSION_TITLE_PREFIX} — ${title}`;

/** Recovers the user-facing title from a prefixed one. */
const stripPrefix = (title: string | undefined): string => {
  const trimmed = (title ?? "").trim();
  if (!trimmed.startsWith(SESSION_TITLE_PREFIX)) return trimmed || "Workout";
  return trimmed.slice(SESSION_TITLE_PREFIX.length).replace(/^\s*—\s*/, "").trim() || "Workout";
};

const isOpenSession = (workout: Workout): boolean =>
  (workout.title ?? "").trim().startsWith(SESSION_TITLE_PREFIX);

/**
 * Finds the open session by scanning the most recent workouts. Hevy returns
 * them newest-first, so an open session is near the top unless several
 * workouts were logged after it was started.
 */
const findOpenSession = async (config: HevyClientConfig): Promise<Workout | null> => {
  const data = await request<{ workouts: Workout[] }>(config, "/v1/workouts", {
    query: { page: 1, pageSize: SESSION_LOOKUP_PAGE_SIZE },
  });
  return (data?.workouts ?? []).find(isOpenSession) ?? null;
};

/** Resolves the session to act on: an explicit id, else whichever one is open. */
const resolveSession = async (
  config: HevyClientConfig,
  workoutId: string | undefined,
): Promise<Workout | null> => {
  if (!workoutId) return findOpenSession(config);
  return request<Workout>(config, `/v1/workouts/${encodeURIComponent(workoutId)}`);
};

const toRpe = (value: number | null | undefined): WorkoutExercises[number]["sets"][number]["rpe"] =>
  (RPE_VALUES as readonly number[]).includes(value ?? Number.NaN)
    ? (value as (typeof RPE_VALUES)[number])
    : null;

/**
 * Converts a workout as Hevy returns it back into the shape Hevy accepts on
 * write. The round trip is lossy in two places: the read model names supersets
 * `supersets_id` where the write model expects `superset_id`, and set types are
 * untyped strings on read, so anything unrecognised falls back to 'normal'.
 */
const toInputExercises = (workout: Workout | null): WorkoutExercises =>
  (workout?.exercises ?? [])
    .filter((exercise) => Boolean(exercise.exercise_template_id))
    .map((exercise) => ({
      exercise_template_id: exercise.exercise_template_id as string,
      superset_id: exercise.supersets_id ?? null,
      notes: exercise.notes ?? null,
      sets: (exercise.sets ?? []).map((set) => ({
        type: (SET_TYPES as readonly string[]).includes(set.type ?? "")
          ? (set.type as (typeof SET_TYPES)[number])
          : ("normal" as const),
        weight_kg: set.weight_kg ?? null,
        reps: set.reps ?? null,
        distance_meters: set.distance_meters ?? null,
        duration_seconds: set.duration_seconds ?? null,
        custom_metric: set.custom_metric ?? null,
        rpe: toRpe(set.rpe),
      })),
    }))
    .filter((exercise) => exercise.sets.length > 0);

const noOpenSession = (action: string) => ({
  content: [
    {
      type: "text" as const,
      text:
        `No open session found in the last ${SESSION_LOOKUP_PAGE_SIZE} workouts, so there is nothing to ${action}. ` +
        "Start one with hevy_start_session, or pass workout_id explicitly if the session is older than that.",
    },
  ],
  isError: true,
});

export const registerSessionTools = (server: McpServer, config: HevyClientConfig): void => {
  server.registerTool(
    "hevy_start_session",
    {
      title: "Start Hevy Session",
      description: `Open a workout session now, to be filled in and closed when training ends.

This WRITES to the training log immediately: it creates a real workout titled '${SESSION_TITLE_PREFIX} — <title>' with start_time set to the current time by the server. That placeholder is visible in Hevy until hevy_finish_session closes it or hevy_cancel_session abandons it, and Hevy has no delete endpoint, so it cannot be removed afterwards — only relabelled.

This does NOT start the timer in the Hevy app; the API exposes no such action. What it buys you is an accurate start_time and a session that any chat on any device can find later, rather than a timestamp held in one conversation.

Refuses to open a second session while one is already open.

Args:
  - title (string): what the session will be called once finished (default: 'Workout')
  - description (string | null): notes for the session
  - is_private (boolean): hide from your public profile (default: false)
  - exercises (array): exercises already known, same shape as hevy_create_workout (default: none)

Returns:
  { "workout": { "id": string, "title": string, "start_time": string, ... } }

Examples:
  - "I'm starting legs now" -> title='Leg Day', no exercises
  - "Starting upper A, first up is bench" -> title='Upper A' with that one exercise
  - Don't use when: the workout is already over (use hevy_create_workout, which takes both times)

Error Handling:
  - Returns an error if a session is already open — finish or cancel it first
  - If Hevy rejects a session with no exercises, re-run with the first exercise you plan to do`,
      inputSchema: startSessionSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof startSessionSchema>) => {
      const existing = await findOpenSession(config);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `A session is already open: **${stripPrefix(existing.title)}** (id: ${existing.id}), ` +
                `started ${formatTimestamp(existing.start_time)} ` +
                `(${formatDuration(existing.start_time, now())} ago). ` +
                "Close it with hevy_finish_session or abandon it with hevy_cancel_session before starting another.",
            },
          ],
          isError: true,
        };
      }

      const startedAt = now();
      const body = toWorkoutBody({
        title: withPrefix(params.title),
        description: params.description ?? null,
        start_time: startedAt,
        // Hevy requires an end_time on every workout; it is rewritten on finish.
        end_time: startedAt,
        is_private: params.is_private,
        exercises: params.exercises,
      });

      let workout: Workout | null;
      try {
        workout = await request<Workout>(config, "/v1/workouts", { method: "POST", body });
      } catch (error) {
        if (params.exercises.length === 0 && isHevyApiError(error) && error.status === 400) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Hevy rejected a session with no exercises. Re-run hevy_start_session with at least " +
                  "the first exercise you plan to do — resolve its id with hevy_search_exercise_templates first.",
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      return toolResult(
        "markdown",
        { workout },
        () =>
          `Session **${params.title}** started at ${formatTimestamp(startedAt)} (id: ${workout?.id ?? "unknown"}).\n\n` +
          "It is showing in Hevy as in-progress. Call hevy_finish_session with what you performed to close it out " +
          "with the real duration, or hevy_cancel_session to abandon it.",
      );
    }),
  );

  server.registerTool(
    "hevy_get_active_session",
    {
      title: "Get Active Hevy Session",
      description: `Find the workout session currently open, if any.

Use this to pick a session back up — in a new chat, on another device, or after losing the thread. It scans the ${SESSION_LOOKUP_PAGE_SIZE} most recent workouts for one still marked in-progress and reports how long it has been running.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "session": { "id": string, "title": string, "start_time": string, ... } | null,
    "is_active": boolean,
    "elapsed": string        // e.g. '48m', absent when nothing is open
  }

Examples:
  - "Am I still in a workout?" -> call with no arguments
  - "How long have I been training?" -> read 'elapsed'
  - Don't use when: you want finished workouts (use hevy_list_workouts)`,
      inputSchema: getActiveSessionSchema,
      outputSchema: singleOutput("session"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getActiveSessionSchema>) => {
      const session = await findOpenSession(config);

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No session is currently open. Start one with hevy_start_session.`,
            },
          ],
          structuredContent: { session: null, is_active: false },
        };
      }

      const elapsed = formatDuration(session.start_time, now());
      const structured = { session, is_active: true, elapsed };

      return toolResult(params.response_format, structured, () =>
        [
          `# Session in progress: ${stripPrefix(session.title)}`,
          "",
          `Started ${formatTimestamp(session.start_time)} — running for **${elapsed}**.`,
          "",
          formatWorkout(session, true),
          "",
          "_Close it with hevy_finish_session, or abandon it with hevy_cancel_session._",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hevy_finish_session",
    {
      title: "Finish Hevy Session",
      description: `Close an open session, writing what was performed and the real duration.

Keeps the original start_time, sets end_time to the current server time, strips the in-progress marker from the title, and replaces the exercises with what you pass.

DESTRUCTIVE: this is a full replacement of the session workout. Whatever exercises you send become the entire workout — anything logged into that placeholder earlier and omitted here is discarded. If exercises were added at the start, call hevy_get_active_session first and send back the complete list.

Weights are KILOGRAMS. Convert pounds first: kg = lb / 2.20462. Resolve exercise ids with hevy_search_exercise_templates.

Args:
  - workout_id (string): session to close; omit to close whichever session is open
  - title (string): final title; defaults to the one given at start
  - description (string | null): defaults to the description the session was opened with
  - is_private (boolean): defaults to false — Hevy omits this field when reading a workout,
    so a session opened as private must be marked private again here
  - exercises (array): everything performed, same shape as hevy_create_workout

Returns:
  { "workout": { "id": string, "start_time": string, "end_time": string, ... } }

Examples:
  - "Done — squats 3x5 at 100, RDLs 3x8 at 80" -> exercises for both, no workout_id
  - Don't use when: no session was ever started (use hevy_create_workout with both timestamps)

Error Handling:
  - Returns an error when no session is open and no workout_id was given
  - An unknown exercise_template_id returns a 400 — resolve ids first`,
      inputSchema: finishSessionSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof finishSessionSchema>) => {
      const session = await resolveSession(config, params.workout_id);
      if (!session) return noOpenSession("finish");

      const endedAt = now();
      const startedAt = session.start_time ?? endedAt;
      const finalTitle = params.title ?? stripPrefix(session.title);

      const workout = await request<Workout>(
        config,
        `/v1/workouts/${encodeURIComponent(session.id)}`,
        {
          method: "PUT",
          body: toWorkoutBody({
            title: finalTitle,
            description: params.description ?? session.description ?? null,
            start_time: startedAt,
            end_time: endedAt,
            is_private: params.is_private ?? false,
            exercises: params.exercises,
          }),
        },
      );

      return toolResult(
        "markdown",
        { workout },
        () =>
          `Finished **${finalTitle}** — ${formatDuration(startedAt, endedAt)} ` +
          `(${formatTimestamp(startedAt)} to ${formatTimestamp(endedAt)}).\n\n` +
          formatWorkout(workout ?? { id: session.id }, true),
      );
    }),
  );

  server.registerTool(
    "hevy_cancel_session",
    {
      title: "Cancel Hevy Session",
      description: `Abandon an open session without logging it as training.

Hevy has no delete endpoint, so this CANNOT remove the workout. It relabels it 'Abandoned session' and clears the in-progress marker so it stops being picked up as active. The entry stays in the training log and still counts toward workout totals — say so before calling, since users generally expect cancel to delete.

If the session has exercises logged against it, they are preserved; only the title changes.

Args:
  - workout_id (string): session to abandon; omit to use whichever session is open

Returns:
  { "workout": { "id": string, "title": string, ... } }

Examples:
  - "Never mind, I'm not training today" -> call with no arguments
  - Don't use when: the workout happened and you want it logged (use hevy_finish_session)

Error Handling:
  - Returns an error when no session is open and no workout_id was given
  - A session with no exercises logged may be rejected by Hevy on update; edit it in the app instead`,
      inputSchema: cancelSessionSchema,
      outputSchema: singleOutput("workout"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof cancelSessionSchema>) => {
      const session = await resolveSession(config, params.workout_id);
      if (!session) return noOpenSession("cancel");

      const exercises = toInputExercises(session);
      const startedAt = session.start_time ?? now();

      const workout = await request<Workout>(
        config,
        `/v1/workouts/${encodeURIComponent(session.id)}`,
        {
          method: "PUT",
          body: toWorkoutBody({
            title: `Abandoned session — ${stripPrefix(session.title)}`,
            description: session.description ?? null,
            start_time: startedAt,
            end_time: session.end_time ?? startedAt,
            is_private: false,
            exercises,
          }),
        },
      );

      return toolResult(
        "markdown",
        { workout },
        () =>
          `Session abandoned (id: ${session.id}). It is no longer marked in progress.\n\n` +
          "Note that Hevy has no delete endpoint, so the entry remains in the training log " +
          "and still counts toward workout totals. Remove it in the Hevy app if you want it gone.",
      );
    }),
  );
};
