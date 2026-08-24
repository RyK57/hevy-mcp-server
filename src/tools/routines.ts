/**
 * Routine and routine-folder tools — the planning side of Hevy.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatRoutine, formatRoutineFolder } from "../formatters/entities.js";
import {
  buildPagination,
  emptyResult,
  paginationFooter,
  toolResult,
  withErrorHandling,
} from "../formatters/response.js";
import {
  createRoutineFolderSchema,
  createRoutineSchema,
  getRoutineFolderSchema,
  getRoutineSchema,
  listRoutineFoldersSchema,
  listRoutinesSchema,
  updateRoutineSchema,
} from "../schemas/inputs.js";
import { listOutput, singleOutput } from "../schemas/outputs.js";
import type { HevyClientConfig } from "../services/hevy-client.js";
import { request } from "../services/hevy-client.js";
import type { Routine, RoutineFolder } from "../types.js";

interface RoutineListResponse {
  page: number;
  page_count: number;
  routines: Routine[];
}

interface RoutineFolderListResponse {
  page: number;
  page_count: number;
  routine_folders: RoutineFolder[];
}

type RoutineExerciseInput = z.infer<typeof createRoutineSchema>["exercises"][number];

/** Shared exercise mapping — POST and PUT accept the same exercise shape. */
const toRoutineExercises = (exercises: RoutineExerciseInput[]) =>
  exercises.map((exercise) => ({
    exercise_template_id: exercise.exercise_template_id,
    superset_id: exercise.superset_id ?? null,
    rest_seconds: exercise.rest_seconds ?? null,
    notes: exercise.notes ?? null,
    sets: exercise.sets.map((set) => ({
      type: set.type,
      weight_kg: set.weight_kg ?? null,
      reps: set.reps ?? null,
      distance_meters: set.distance_meters ?? null,
      duration_seconds: set.duration_seconds ?? null,
      custom_metric: set.custom_metric ?? null,
      rep_range: set.rep_range ?? null,
    })),
  }));

/** Hevy returns routines inconsistently: bare, wrapped in `routine`, or in an array. */
const unwrapRoutine = (payload: unknown): Routine | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.routine && typeof record.routine === "object") return record.routine as Routine;
  if (Array.isArray(record.routines) && record.routines.length > 0) {
    return record.routines[0] as Routine;
  }
  if (typeof record.id === "string") return record as unknown as Routine;
  return null;
};

export const registerRoutineTools = (server: McpServer, config: HevyClientConfig): void => {
  server.registerTool(
    "hevy_list_routines",
    {
      title: "List Hevy Routines",
      description: `List saved routines (planned workout templates), with their exercises and target sets.

Routines are plans, not history. Use hevy_list_workouts for what was actually performed.

Args:
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-10 (default: 5)
  - detailed (boolean): include every planned set and rep range (default: false)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number, "page_count": number, "count": number, "has_more": boolean,
    "routines": [ { "id": string, "title": string, "folder_id": number | null,
                    "exercises": [ { "title": string, "exercise_template_id": string,
                                     "rest_seconds": number | null, "sets": [...] } ] } ]
  }

Examples:
  - "What's in my Upper A routine?" -> list with detailed=true, or get the id then hevy_get_routine
  - "Which routines do I have?" -> detailed=false for a compact list
  - Don't use when: you want performed sets (use hevy_list_workouts)`,
      inputSchema: listRoutinesSchema,
      outputSchema: listOutput("routines"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listRoutinesSchema>) => {
      const data = await request<RoutineListResponse>(config, "/v1/routines", {
        query: { page: params.page, pageSize: params.page_size },
      });

      const routines = data?.routines ?? [];
      const meta = buildPagination(data?.page ?? params.page, data?.page_count ?? 1, routines.length);
      const structured = { ...meta, routines };

      if (routines.length === 0) {
        return emptyResult(
          `No routines on page ${params.page}. Create one with hevy_create_routine, or try page=1.`,
          structured,
        );
      }

      return toolResult(
        params.response_format,
        structured,
        () =>
          [
            `# Routines (page ${meta.page} of ${meta.page_count})`,
            "",
            routines.map((routine) => formatRoutine(routine, params.detailed)).join("\n\n"),
            paginationFooter(meta, "hevy_list_routines"),
          ].join("\n"),
        "Set detailed=false or lower page_size.",
      );
    }),
  );

  server.registerTool(
    "hevy_get_routine",
    {
      title: "Get Hevy Routine",
      description: `Fetch one routine in full, including planned sets, target rep ranges and rest times.

Args:
  - routine_id (string): routine UUID, from hevy_list_routines
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "routine": { "id": string, "title": string, "folder_id": number | null,
                 "notes": string | null, "exercises": [...] } }

Examples:
  - "Show me exactly what Lower B prescribes" -> routine_id from hevy_list_routines
  - Call this before hevy_update_routine so you can send back the full structure

Error Handling:
  - Returns a 404 message if the routine id does not exist`,
      inputSchema: getRoutineSchema,
      outputSchema: singleOutput("routine"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getRoutineSchema>) => {
      const payload = await request<unknown>(
        config,
        `/v1/routines/${encodeURIComponent(params.routine_id)}`,
      );
      const routine = unwrapRoutine(payload);

      if (!routine) {
        return emptyResult(
          `No routine found with id ${params.routine_id}. Check the id with hevy_list_routines.`,
          { routine: null },
        );
      }

      return toolResult(params.response_format, { routine }, () => formatRoutine(routine, true));
    }),
  );

  server.registerTool(
    "hevy_create_routine",
    {
      title: "Create Hevy Routine",
      description: `Create a new routine (a reusable workout template).

This WRITES to the user's account. Weights are KILOGRAMS. Every exercise needs a valid exercise_template_id from hevy_search_exercise_templates.

Routine sets support rep_range (e.g. 8-12) in addition to fixed reps — use it when the plan prescribes a range rather than a number.

Args:
  - title (string): routine title, e.g. 'Upper A'
  - folder_id (number | null): folder from hevy_list_routine_folders; null uses 'My Routines'
  - notes (string | null): notes for the routine
  - exercises (array): each { exercise_template_id, superset_id?, rest_seconds?, notes?, sets: [...] }
      where each set is { type, weight_kg?, reps?, rep_range?: { start, end },
                          distance_meters?, duration_seconds?, custom_metric? }

Returns:
  { "routine": { "id": string, ... } }  // the created routine

Examples:
  - "Build me a push day with bench 4x6-8 and rest 120s" -> one exercise, four sets with rep_range {start:6,end:8}, rest_seconds=120
  - Don't use when: recording a session that already happened (use hevy_create_workout)

Error Handling:
  - Returns 403 if the account has hit its routine limit
  - Returns 400 for unknown exercise_template_id values`,
      inputSchema: createRoutineSchema,
      outputSchema: singleOutput("routine"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof createRoutineSchema>) => {
      const payload = await request<unknown>(config, "/v1/routines", {
        method: "POST",
        body: {
          routine: {
            title: params.title,
            folder_id: params.folder_id ?? null,
            notes: params.notes ?? null,
            exercises: toRoutineExercises(params.exercises),
          },
        },
      });

      const routine = unwrapRoutine(payload);
      return toolResult(
        "markdown",
        { routine },
        () =>
          `Created routine **${params.title}**${routine?.id ? ` (id: ${routine.id})` : ""}.` +
          (routine ? `\n\n${formatRoutine(routine, true)}` : ""),
      );
    }),
  );

  server.registerTool(
    "hevy_update_routine",
    {
      title: "Update Hevy Routine",
      description: `Overwrite an existing routine.

DESTRUCTIVE: full replacement, not a patch. Omitted exercises and sets are deleted. Fetch the routine with hevy_get_routine first, modify that structure, then send it back complete.

Note: the update endpoint does not accept folder_id — a routine's folder cannot be changed through the API.

Args:
  - routine_id (string): UUID of the routine to overwrite
  - title (string): routine title
  - notes (string | null): notes for the routine
  - exercises (array): the routine's complete desired exercise list, same shape as hevy_create_routine

Returns:
  { "routine": { "id": string, ... } }  // the routine after the update

Examples:
  - "Add a fourth set to squats in Lower A" -> get_routine, append the set, send everything back
  - "Bump the target reps on rows to 10-12" -> change rep_range on those sets, resend the full routine

Error Handling:
  - Returns 404 if the routine id does not exist`,
      inputSchema: updateRoutineSchema,
      outputSchema: singleOutput("routine"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof updateRoutineSchema>) => {
      const payload = await request<unknown>(
        config,
        `/v1/routines/${encodeURIComponent(params.routine_id)}`,
        {
          method: "PUT",
          body: {
            routine: {
              title: params.title,
              notes: params.notes ?? null,
              exercises: toRoutineExercises(params.exercises),
            },
          },
        },
      );

      const routine = unwrapRoutine(payload);
      return toolResult(
        "markdown",
        { routine },
        () =>
          `Updated routine **${params.title}** (id: ${params.routine_id}).` +
          (routine ? `\n\n${formatRoutine(routine, true)}` : ""),
      );
    }),
  );

  server.registerTool(
    "hevy_list_routine_folders",
    {
      title: "List Hevy Routine Folders",
      description: `List routine folders, in display order.

Use this to resolve a folder name to the numeric folder_id that hevy_create_routine expects.

Args:
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-10 (default: 10)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number, "page_count": number, "count": number, "has_more": boolean,
    "routine_folders": [ { "id": number, "index": number, "title": string,
                           "created_at": string, "updated_at": string } ]
  }

Examples:
  - "Which folders do I have?" -> call with defaults
  - Call before hevy_create_routine when the user names a folder to file the routine under`,
      inputSchema: listRoutineFoldersSchema,
      outputSchema: listOutput("routine_folders"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listRoutineFoldersSchema>) => {
      const data = await request<RoutineFolderListResponse>(config, "/v1/routine_folders", {
        query: { page: params.page, pageSize: params.page_size },
      });

      const folders = data?.routine_folders ?? [];
      const meta = buildPagination(data?.page ?? params.page, data?.page_count ?? 1, folders.length);
      const structured = { ...meta, routine_folders: folders };

      if (folders.length === 0) {
        return emptyResult(
          "No routine folders exist. Routines without a folder live in the default 'My Routines'. " +
            "Create a folder with hevy_create_routine_folder.",
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Routine folders (page ${meta.page} of ${meta.page_count})`,
          "",
          folders.map(formatRoutineFolder).join("\n"),
          paginationFooter(meta, "hevy_list_routine_folders"),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hevy_get_routine_folder",
    {
      title: "Get Hevy Routine Folder",
      description: `Fetch one routine folder by its numeric id.

Args:
  - folder_id (number): numeric folder id, from hevy_list_routine_folders
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "routine_folder": { "id": number, "index": number, "title": string,
                        "created_at": string, "updated_at": string } }

Examples:
  - "What is folder 42 called?" -> folder_id=42
  - Note: this returns the folder itself, not the routines inside it — for those, list routines and filter on folder_id

Error Handling:
  - Returns a 404 message if the folder does not exist`,
      inputSchema: getRoutineFolderSchema,
      outputSchema: singleOutput("routine_folder"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getRoutineFolderSchema>) => {
      const folder = await request<RoutineFolder>(
        config,
        `/v1/routine_folders/${params.folder_id}`,
      );

      return toolResult(
        params.response_format,
        { routine_folder: folder },
        () => `# Routine folder\n\n${formatRoutineFolder(folder)}`,
      );
    }),
  );

  server.registerTool(
    "hevy_create_routine_folder",
    {
      title: "Create Hevy Routine Folder",
      description: `Create a new routine folder.

This WRITES to the user's account. The new folder is inserted at position 0 and every existing folder's index shifts down by one — the ordering of the user's folder list will change.

Args:
  - title (string): folder title, e.g. 'Upper/Lower'

Returns:
  { "routine_folder": { "id": number, "index": number, "title": string } }

Examples:
  - "Make a folder for my new mesocycle" -> title='Meso 2'
  - Create the folder first, then pass its id as folder_id to hevy_create_routine`,
      inputSchema: createRoutineFolderSchema,
      outputSchema: singleOutput("routine_folder"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof createRoutineFolderSchema>) => {
      const folder = await request<RoutineFolder>(config, "/v1/routine_folders", {
        method: "POST",
        body: { routine_folder: { title: params.title } },
      });

      return toolResult(
        "markdown",
        { routine_folder: folder },
        () =>
          `Created folder **${params.title}** (id: ${folder?.id ?? "unknown"}). ` +
          "Existing folders shifted down one position.",
      );
    }),
  );
};
