/**
 * Exercise template tools.
 *
 * `hevy_search_exercise_templates` is the key workflow tool here: Hevy has
 * hundreds of built-in templates and every write operation needs a template id,
 * but the API offers no server-side search. This tool pages through the
 * catalogue and filters locally so the agent can resolve "incline dumbbell
 * press" to an id in one call instead of ten.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_SEARCH_PAGES, PAGE_SIZE_LIMITS } from "../constants.js";
import { formatExerciseTemplate } from "../formatters/entities.js";
import {
  buildPagination,
  emptyResult,
  paginationFooter,
  toolResult,
  withErrorHandling,
} from "../formatters/response.js";
import {
  createExerciseTemplateSchema,
  getExerciseTemplateSchema,
  listExerciseTemplatesSchema,
  searchExerciseTemplatesSchema,
} from "../schemas/inputs.js";
import { listOutput, searchOutput, singleOutput } from "../schemas/outputs.js";
import type { HevyClientConfig } from "../services/hevy-client.js";
import { request } from "../services/hevy-client.js";
import type { ExerciseTemplate } from "../types.js";

interface TemplateListResponse {
  page: number;
  page_count: number;
  exercise_templates: ExerciseTemplate[];
}

const fetchTemplatePage = async (
  config: HevyClientConfig,
  page: number,
  pageSize: number,
): Promise<TemplateListResponse> => {
  const data = await request<TemplateListResponse>(config, "/v1/exercise_templates", {
    query: { page, pageSize },
  });
  return {
    page: data?.page ?? page,
    page_count: data?.page_count ?? 1,
    exercise_templates: data?.exercise_templates ?? [],
  };
};

type SearchParams = z.infer<typeof searchExerciseTemplatesSchema>;

const matchesFilters = (template: ExerciseTemplate, params: SearchParams): boolean => {
  const title = (template.title ?? "").toLowerCase();

  if (params.query && !title.includes(params.query.toLowerCase())) return false;
  if (params.custom_only && !template.is_custom) return false;
  if (params.muscle_group && template.primary_muscle_group !== params.muscle_group) return false;
  // Equipment is not a field on the template response, so it is matched against
  // the title, where Hevy encodes it as e.g. "Bench Press (Barbell)".
  if (params.equipment && params.equipment !== "none" && !title.includes(params.equipment.replace(/_/g, " "))) {
    return false;
  }
  return true;
};

export const registerExerciseTemplateTools = (
  server: McpServer,
  config: HevyClientConfig,
): void => {
  server.registerTool(
    "hevy_search_exercise_templates",
    {
      title: "Search Hevy Exercise Templates",
      description: `Find exercise templates by name, muscle group, or equipment, and return their ids.

START HERE before creating or updating any workout or routine: those tools require an exercise_template_id, and ids cannot be guessed. Hevy has no server-side search, so this tool pages through the catalogue and filters locally, scanning up to ${MAX_SEARCH_PAGES} pages of ${PAGE_SIZE_LIMITS.exerciseTemplates}.

At least one filter is required.

Args:
  - query (string): case-insensitive substring of the title, e.g. 'incline dumbbell'
  - muscle_group (string): exact primary muscle group, e.g. 'chest', 'quadriceps', 'lats'
  - equipment (string): 'barbell' | 'dumbbell' | 'machine' | 'kettlebell' | 'plate' |
      'resistance_band' | 'suspension' | 'other' | 'none' — matched against the title,
      since the API does not expose equipment as a field
  - custom_only (boolean): only exercises you created yourself (default: false)
  - limit (number): maximum matches to return, 1-50 (default: 20)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "query": string,
    "count": number,           // matches returned
    "pages_scanned": number,   // catalogue pages fetched
    "scan_complete": boolean,  // false if the scan cap was hit before the end
    "exercise_templates": [ { "id": string, "title": string, "type": string,
                              "primary_muscle_group": string,
                              "secondary_muscle_groups": string[],
                              "is_custom": boolean } ]
  }

Examples:
  - "Log bench press" -> query='bench press', take the id whose title matches the equipment the user meant
  - "What chest exercises can I log?" -> muscle_group='chest', limit=50
  - "Find my custom exercises" -> custom_only=true

Error Handling:
  - Returns a no-matches message listing the filters used, so you can broaden the query
  - Broad single-letter queries are rejected; use at least 2 characters`,
      inputSchema: searchExerciseTemplatesSchema,
      outputSchema: searchOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: SearchParams) => {
      const matches: ExerciseTemplate[] = [];
      let pagesScanned = 0;
      let scanComplete = false;

      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        const data = await fetchTemplatePage(config, page, PAGE_SIZE_LIMITS.exerciseTemplates);
        pagesScanned = page;

        for (const template of data.exercise_templates) {
          if (matchesFilters(template, params)) matches.push(template);
        }

        if (page >= data.page_count || data.exercise_templates.length === 0) {
          scanComplete = true;
          break;
        }
        if (matches.length >= params.limit) break;
      }

      const limited = matches.slice(0, params.limit);
      const describeFilters = [
        params.query ? `query='${params.query}'` : null,
        params.muscle_group ? `muscle_group='${params.muscle_group}'` : null,
        params.equipment ? `equipment='${params.equipment}'` : null,
        params.custom_only ? "custom_only=true" : null,
      ]
        .filter(Boolean)
        .join(", ");

      const structured = {
        ...(params.query ? { query: params.query } : {}),
        count: limited.length,
        pages_scanned: pagesScanned,
        scan_complete: scanComplete,
        exercise_templates: limited,
      };

      if (limited.length === 0) {
        return emptyResult(
          `No exercise templates matched ${describeFilters}. ` +
            "Try a shorter query (Hevy titles look like 'Bench Press (Barbell)'), drop the " +
            "equipment filter, or search by muscle_group instead.",
          structured,
        );
      }

      return toolResult(
        params.response_format,
        structured,
        () =>
          [
            `# Exercise templates matching ${describeFilters}`,
            "",
            `Found ${limited.length}${matches.length > limited.length ? ` of ${matches.length}` : ""} match(es) across ${pagesScanned} page(s)${scanComplete ? "" : " — scan cap reached, more may exist"}.`,
            "",
            limited.map(formatExerciseTemplate).join("\n"),
          ].join("\n"),
        "Lower 'limit' or narrow the query.",
      );
    }),
  );

  server.registerTool(
    "hevy_list_exercise_templates",
    {
      title: "List Hevy Exercise Templates",
      description: `Page through the raw exercise template catalogue.

Prefer hevy_search_exercise_templates when you are looking for a specific exercise — this tool is for browsing or exporting the full catalogue.

Args:
  - page (number): 1-indexed page number (default: 1)
  - page_size (number): items per page, 1-100 (default: 50)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "page": number, "page_count": number, "count": number, "has_more": boolean,
    "exercise_templates": [ { "id": string, "title": string, "type": string,
                              "primary_muscle_group": string,
                              "secondary_muscle_groups": string[], "is_custom": boolean } ]
  }

Examples:
  - "Export every exercise Hevy supports" -> page through with page_size=100
  - Don't use when: resolving one exercise name to an id (use hevy_search_exercise_templates)`,
      inputSchema: listExerciseTemplatesSchema,
      outputSchema: listOutput("exercise_templates"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof listExerciseTemplatesSchema>) => {
      const data = await fetchTemplatePage(config, params.page, params.page_size);
      const templates = data.exercise_templates;
      const meta = buildPagination(data.page, data.page_count, templates.length);
      const structured = { ...meta, exercise_templates: templates };

      if (templates.length === 0) {
        return emptyResult(
          `No exercise templates on page ${params.page} (${meta.page_count} page(s) exist).`,
          structured,
        );
      }

      return toolResult(params.response_format, structured, () =>
        [
          `# Exercise templates (page ${meta.page} of ${meta.page_count})`,
          "",
          templates.map(formatExerciseTemplate).join("\n"),
          paginationFooter(meta, "hevy_list_exercise_templates"),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hevy_get_exercise_template",
    {
      title: "Get Hevy Exercise Template",
      description: `Fetch a single exercise template by id.

Useful for confirming what a template id refers to before writing a workout that uses it, or for reading the muscle groups an exercise targets.

Args:
  - exercise_template_id (string): template id, e.g. 'D04AC939'
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "exercise_template": { "id": string, "title": string, "type": string,
                           "primary_muscle_group": string,
                           "secondary_muscle_groups": string[], "is_custom": boolean } }

Examples:
  - "What muscles does D04AC939 hit?" -> exercise_template_id='D04AC939'
  - Verify an id before hevy_create_workout if the search returned several similar titles

Error Handling:
  - Returns a 404 message if the id does not exist`,
      inputSchema: getExerciseTemplateSchema,
      outputSchema: singleOutput("exercise_template"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof getExerciseTemplateSchema>) => {
      const template = await request<ExerciseTemplate>(
        config,
        `/v1/exercise_templates/${encodeURIComponent(params.exercise_template_id)}`,
      );

      return toolResult(
        params.response_format,
        { exercise_template: template },
        () => `# Exercise template\n\n${formatExerciseTemplate(template)}`,
      );
    }),
  );

  server.registerTool(
    "hevy_create_exercise_template",
    {
      title: "Create Custom Hevy Exercise",
      description: `Create a custom exercise template on the account.

This WRITES to the user's account. Search first — Hevy's built-in catalogue is large and a duplicate custom exercise fragments the user's history for that movement.

Accounts have a cap on custom exercises; exceeding it returns 403.

Args:
  - title (string): exercise name, e.g. 'Reverse Nordic Curl'
  - exercise_type (string): how it is measured — 'weight_reps' | 'reps_only' | 'bodyweight_reps' |
      'bodyweight_assisted_reps' | 'duration' | 'weight_duration' | 'distance_duration' |
      'short_distance_weight'
  - equipment_category (string): 'none' | 'barbell' | 'dumbbell' | 'kettlebell' | 'machine' |
      'plate' | 'resistance_band' | 'suspension' | 'other'
  - muscle_group (string): primary muscle group, e.g. 'quadriceps'
  - other_muscles (string[]): secondary muscle groups (default: [])

Returns:
  { "exercise_template": { "id": number } }  // note: creation returns a numeric id, unlike the
                                             // string ids used elsewhere in the API

Examples:
  - "Add sissy squats as a custom exercise" -> title='Sissy Squat', exercise_type='bodyweight_reps',
    equipment_category='none', muscle_group='quadriceps'
  - Don't use when: the exercise already exists (search first)

Error Handling:
  - Returns 403 with 'exceeds-custom-exercise-limit' when the account cap is reached`,
      inputSchema: createExerciseTemplateSchema,
      outputSchema: singleOutput("exercise_template"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: z.infer<typeof createExerciseTemplateSchema>) => {
      const created = await request<{ id: number | string }>(config, "/v1/exercise_templates", {
        method: "POST",
        body: {
          exercise: {
            title: params.title,
            exercise_type: params.exercise_type,
            equipment_category: params.equipment_category,
            muscle_group: params.muscle_group,
            other_muscles: params.other_muscles,
          },
        },
      });

      return toolResult(
        "markdown",
        { exercise_template: created },
        () =>
          `Created custom exercise **${params.title}** (id: ${created?.id ?? "unknown"}), ` +
          `type ${params.exercise_type}, primary muscle ${params.muscle_group}.`,
      );
    }),
  );
};
