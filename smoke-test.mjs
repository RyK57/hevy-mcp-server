/**
 * Smoke test: drives the built server over stdio with a real JSON-RPC handshake,
 * pointed at a local mock of the Hevy API so no key or network is needed.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PORT = 8787;

// --- Mock Hevy API -----------------------------------------------------------
const templates = [
  { id: "D04AC939", title: "Bench Press (Barbell)", type: "weight_reps", primary_muscle_group: "chest", secondary_muscle_groups: ["triceps", "shoulders"], is_custom: false },
  { id: "05293BCA", title: "Incline Bench Press (Dumbbell)", type: "weight_reps", primary_muscle_group: "chest", secondary_muscle_groups: ["shoulders"], is_custom: false },
  { id: "AA11BB22", title: "Squat (Barbell)", type: "weight_reps", primary_muscle_group: "quadriceps", secondary_muscle_groups: ["glutes"], is_custom: false },
  { id: "CC33DD44", title: "Sissy Squat", type: "bodyweight_reps", primary_muscle_group: "quadriceps", secondary_muscle_groups: [], is_custom: true },
];

const workout = {
  id: "b459cba5-cd6d-463c-abd6-54f8eafcadcb",
  title: "Upper A",
  routine_id: null,
  description: "Felt strong",
  start_time: "2026-08-24T18:00:00Z",
  end_time: "2026-08-24T19:12:00Z",
  updated_at: "2026-08-24T19:12:00Z",
  created_at: "2026-08-24T19:12:00Z",
  exercises: [
    {
      index: 0, title: "Bench Press (Barbell)", notes: "form was clean",
      exercise_template_id: "D04AC939", supersets_id: null,
      sets: [
        { index: 0, type: "warmup", weight_kg: 40, reps: 10, rpe: null, distance_meters: null, duration_seconds: null, custom_metric: null },
        { index: 1, type: "normal", weight_kg: 60, reps: 8, rpe: 8, distance_meters: null, duration_seconds: null, custom_metric: null },
        { index: 2, type: "normal", weight_kg: 60, reps: 7, rpe: 9, distance_meters: null, duration_seconds: null, custom_metric: null },
      ],
    },
  ],
};

const requestLog = [];

const mock = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requestLog.push({ method: req.method, path: url.pathname, query: url.search, apiKey: req.headers["api-key"], body });
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/v1/workouts" && req.method === "GET") return send(200, { page: 1, page_count: 3, workouts: [workout] });
    if (url.pathname === "/v1/workouts" && req.method === "POST") return send(201, { ...workout, id: "new-workout-id" });
    if (url.pathname === "/v1/workouts/count") return send(200, { workout_count: 137 });
    if (url.pathname.startsWith("/v1/workouts/") && req.method === "GET") return send(200, workout);
    if (url.pathname === "/v1/exercise_templates") {
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(200, { page, page_count: 1, exercise_templates: templates });
    }
    if (url.pathname === "/v1/user/info") return send(200, { data: { id: "u-1", name: "Test User", url: "https://hevy.com/user/test" } });
    if (url.pathname.startsWith("/v1/exercise_history/")) {
      return send(200, { exercise_history: [
        { workout_id: "w1", workout_title: "Upper A", workout_start_time: "2026-08-24T18:00:00Z", exercise_template_id: "D04AC939", weight_kg: 60, reps: 8, rpe: 8, set_type: "normal", distance_meters: null, duration_seconds: null, custom_metric: null },
        { workout_id: "w0", workout_title: "Upper A", workout_start_time: "2026-08-17T18:00:00Z", exercise_template_id: "D04AC939", weight_kg: 57.5, reps: 8, rpe: 8.5, set_type: "normal", distance_meters: null, duration_seconds: null, custom_metric: null },
      ] });
    }
    if (url.pathname === "/v1/body_measurements" && req.method === "GET") {
      return send(200, { page: 1, page_count: 1, body_measurements: [{ date: "2026-08-24", weight_kg: 66, fat_percent: 14.2, chest_cm: 98, waist: 76 }] });
    }
    if (url.pathname === "/v1/body_measurements" && req.method === "POST") return send(409, { error: "Measurement already exists for this date" });
    if (url.pathname === "/v1/routines" && req.method === "GET") return send(200, { page: 1, page_count: 1, routines: [] });
    if (url.pathname === "/v1/routine_folders") return send(200, { page: 1, page_count: 1, routine_folders: [{ id: 42, index: 0, title: "Upper/Lower", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" }] });
    return send(404, { error: `No mock for ${req.method} ${url.pathname}` });
  });
});

await new Promise((r) => mock.listen(PORT, "127.0.0.1", r));

// --- Drive the server over stdio --------------------------------------------
const child = spawn("node", ["dist/index.js"], {
  cwd: "/home/claude/hevy-mcp-server",
  env: { ...process.env, HEVY_API_KEY: "11111111-2222-3333-4444-555555555555", HEVY_API_BASE_URL: `http://127.0.0.1:${PORT}` },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
  });

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "1.0.0" },
});
check("initialize handshake", init.result?.serverInfo?.name === "hevy-mcp-server", init.result?.serverInfo?.name);
check("server sends instructions", typeof init.result?.instructions === "string" && init.result.instructions.length > 50);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const list = await rpc("tools/list", {});
const tools = list.result?.tools ?? [];
check("tools/list returns tools", tools.length === 23, `${tools.length} tools`);
check("all tools prefixed hevy_", tools.every((t) => t.name.startsWith("hevy_")));
check("all tools have descriptions", tools.every((t) => (t.description ?? "").length > 100));
check("all tools have annotations", tools.every((t) => t.annotations && "readOnlyHint" in t.annotations));
check("all tools have input schemas", tools.every((t) => t.inputSchema?.type === "object"));
check("all tools have output schemas", tools.every((t) => t.outputSchema?.type === "object"));

const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort();
check("destructive tools flagged", destructive.length === 3, destructive.join(", "));

const call = async (name, args) => {
  const res = await rpc("tools/call", { name, arguments: args });
  return res.result ?? res.error;
};

const search = await call("hevy_search_exercise_templates", { query: "bench" });
check("search finds templates", search.content?.[0]?.text?.includes("D04AC939"), `${search.structuredContent?.count} matches`);

const searchMuscle = await call("hevy_search_exercise_templates", { muscle_group: "quadriceps" });
check("search by muscle group", searchMuscle.structuredContent?.count === 2);

const searchCustom = await call("hevy_search_exercise_templates", { custom_only: true });
check("search custom_only", searchCustom.structuredContent?.count === 1 && searchCustom.structuredContent.exercise_templates[0].id === "CC33DD44");

const noFilters = await call("hevy_search_exercise_templates", {});
check("search rejects no filters", JSON.stringify(noFilters).includes("at least one"), "validation fired");

const workouts = await call("hevy_list_workouts", { page_size: 5 });
check("list workouts renders", workouts.content?.[0]?.text?.includes("Upper A"));
check("pagination metadata correct", workouts.structuredContent?.has_more === true && workouts.structuredContent?.next_page === 2);

const detailed = await call("hevy_list_workouts", { detailed: true });
check("detailed shows sets + lb conversion", detailed.content[0].text.includes("60 kg (132.3 lb)") && detailed.content[0].text.includes("@RPE 9"));

const badPageSize = await call("hevy_list_workouts", { page_size: 50 });
check("page_size cap enforced client-side", JSON.stringify(badPageSize).includes("10"), "rejected before HTTP");

const count = await call("hevy_count_workouts", {});
check("count workouts", count.structuredContent?.workout_count === 137);

const user = await call("hevy_get_user_info", {});
check("user info unwraps data envelope", user.structuredContent?.name === "Test User");

const history = await call("hevy_get_exercise_history", { exercise_template_id: "D04AC939" });
check("history computes est. 1RM", history.content[0].text.includes("est. 1RM 76 kg"), "60kg x 8");

const measurements = await call("hevy_list_body_measurements", {});
check("measurements render", measurements.content[0].text.includes("66 kg (145.5 lb)"));

const conflict = await call("hevy_create_body_measurement", { date: "2026-08-24", weight_kg: 66 });
check("409 maps to actionable message", conflict.content[0].text.includes("hevy_update_body_measurement"), "suggests update tool");

const created = await call("hevy_create_workout", {
  title: "Test Session",
  start_time: "2026-08-24T18:00:00Z",
  end_time: "2026-08-24T19:00:00Z",
  exercises: [{ exercise_template_id: "D04AC939", sets: [{ type: "normal", weight_kg: 60, reps: 8, rpe: 8 }] }],
});
check("create workout succeeds", created.structuredContent?.workout?.id === "new-workout-id");
const postBody = JSON.parse(requestLog.find((r) => r.method === "POST" && r.path === "/v1/workouts").body);
check("create sends correct body shape", postBody.workout?.exercises?.[0]?.sets?.[0]?.weight_kg === 60 && postBody.workout.exercises[0].superset_id === null);

const badRpe = await call("hevy_create_workout", {
  title: "Bad", start_time: "2026-08-24T18:00:00Z", end_time: "2026-08-24T19:00:00Z",
  exercises: [{ exercise_template_id: "D04AC939", sets: [{ type: "normal", weight_kg: 60, reps: 8, rpe: 7.2 }] }],
});
check("invalid RPE rejected", JSON.stringify(badRpe).toLowerCase().includes("invalid") || badRpe.isError === true);

const badDate = await call("hevy_get_body_measurement", { date: "08/24/2026" });
check("bad date format rejected", JSON.stringify(badDate).includes("YYYY-MM-DD"));

const notFound = await call("hevy_get_routine", { routine_id: "does-not-exist" });
check("404 maps to guidance", notFound.content[0].text.includes("hevy_list_routines"));

const emptyRoutines = await call("hevy_list_routines", {});
check("empty list suggests next step", emptyRoutines.content[0].text.includes("hevy_create_routine"));

const folders = await call("hevy_list_routine_folders", {});
check("folders render with ids", folders.content[0].text.includes("id: 42"));

const jsonFormat = await call("hevy_list_workouts", { response_format: "json" });
check("json response_format works", jsonFormat.content[0].text.trim().startsWith("{"));

check("api-key header sent on every request", requestLog.every((r) => r.apiKey === "11111111-2222-3333-4444-555555555555"), `${requestLog.length} requests`);

child.kill();
mock.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
