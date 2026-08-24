# hevy-mcp-server

MCP server for the [Hevy](https://hevy.com) workout tracking API. Gives an LLM read and write access to workouts, routines, exercise templates, per-exercise history, and body measurements.

Covers all 15 endpoints of the Hevy public API (v0.0.1) across 23 tools.

## Requirements

- Node.js 18+
- A **Hevy Pro** subscription — API access is Pro-only
- An API key from https://hevy.com/settings?developer

## Install

```bash
pnpm install
pnpm run build
```

## Configure

Set `HEVY_API_KEY` in your MCP client config. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hevy": {
      "command": "node",
      "args": ["/absolute/path/to/hevy-mcp-server/dist/index.js"],
      "env": { "HEVY_API_KEY": "your-key-here" }
    }
  }
}
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HEVY_API_KEY` | yes | — | Your Hevy API key |
| `HEVY_API_BASE_URL` | no | `https://api.hevyapp.com` | Override the API host |
| `HEVY_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `PORT` / `HOST` | no | `3000` / `127.0.0.1` | HTTP transport bind address |
| `MCP_PATH_SECRET` | when hosted | — | Serves the endpoint at `/mcp/<secret>`. **Required** when `HOST` is not loopback |
| `ALLOWED_ORIGINS` | no | localhost + claude.ai | Comma-separated origin allowlist |

Remote/HTTP mode, locally:

```bash
TRANSPORT=http PORT=3000 pnpm start   # POST JSON-RPC to http://127.0.0.1:3000/mcp
```

Inspect the tools interactively:

```bash
HEVY_API_KEY=your-key pnpm run inspect
```

## Deploying (for Claude mobile / claude.ai connectors)

Claude connects to custom connectors from Anthropic's cloud, not from your device, so mobile and claude.ai need this reachable over public HTTPS. Claude Code and Claude Desktop don't — use stdio there instead.

### 1. Generate a path secret

```bash
openssl rand -hex 32
```

The server refuses to start on a non-loopback interface without `MCP_PATH_SECRET` set, because a public endpoint holding your Hevy key is an open proxy to your account. With it set, the endpoint moves to `/mcp/<secret>` and every other path returns 404 — including a wrong secret, so probing the host doesn't reveal that an MCP server lives there.

### 2. Deploy

The included `Dockerfile` and `railway.json` work as-is on Railway, Render, or Fly. The image sets `TRANSPORT=http` and `HOST=0.0.0.0` and runs as a non-root user. Set two variables in the platform's dashboard:

| Variable | Value |
|---|---|
| `HEVY_API_KEY` | your key from https://hevy.com/settings?developer |
| `MCP_PATH_SECRET` | the value from step 1 |

`PORT` is injected by the platform. `/healthz` is an unauthenticated liveness probe.

### 3. Verify

```bash
curl -s https://your-app.up.railway.app/healthz
# {"status":"ok","server":"hevy-mcp-server","version":"1.0.0"}
```

### 4. Add the connector

On claude.ai **in a browser** — connectors can't be added from the mobile app:

1. **Customize → Connectors → Add custom connector**
2. URL: `https://your-app.up.railway.app/mcp/<secret>`
3. On your phone, open a chat and enable it under **+ → Connectors**

Treat that URL like a password: it's the only thing standing between the internet and your training log. If it leaks, rotate `MCP_PATH_SECRET` and re-add the connector.


## Tools

**Workouts** — `hevy_list_workouts`, `hevy_get_workout`, `hevy_count_workouts`, `hevy_list_workout_events`, `hevy_create_workout`, `hevy_update_workout`

**Routines** — `hevy_list_routines`, `hevy_get_routine`, `hevy_create_routine`, `hevy_update_routine`

**Routine folders** — `hevy_list_routine_folders`, `hevy_get_routine_folder`, `hevy_create_routine_folder`

**Exercise templates** — `hevy_search_exercise_templates`, `hevy_list_exercise_templates`, `hevy_get_exercise_template`, `hevy_create_exercise_template`

**Progress** — `hevy_get_exercise_history`, `hevy_list_body_measurements`, `hevy_get_body_measurement`, `hevy_create_body_measurement`, `hevy_update_body_measurement`

**Account** — `hevy_get_user_info`

Every read tool takes `response_format: "markdown" | "json"`. Markdown is the default and is optimized for an LLM reading it; JSON is the full structured payload. `structuredContent` is always populated regardless of format.

## Examples

**"What did I train this week?"**
→ `hevy_list_workouts` with `page_size=5`. Returns titles, duration, exercise list, and total volume per session.

**"Log today's bench: 3x8 at 60kg"**
→ `hevy_search_exercise_templates` with `query="bench press"` to get the id, then `hevy_create_workout` with three sets of `{ weight_kg: 60, reps: 8 }`.

**"Am I getting stronger on squats?"**
→ `hevy_search_exercise_templates` with `query="squat"`, then `hevy_get_exercise_history` with a `start_date`. Returns every logged set newest-first, plus the best set by estimated 1RM.

## Design notes

**Search before writing.** Hevy has no server-side exercise search, but every write needs an `exercise_template_id`. `hevy_search_exercise_templates` pages through the catalogue (up to 30 pages of 100) and filters locally on title, muscle group, equipment, and custom-only. Point the model at this tool first — ids cannot be guessed.

**Updates are replacements, not patches.** `hevy_update_workout`, `hevy_update_routine`, and `hevy_update_body_measurement` overwrite the entire resource; anything omitted is deleted or nulled. All three carry `destructiveHint: true`, and their descriptions tell the model to read the current state first. These are the only three destructive tools — the Hevy API has no delete endpoints.

**Everything is kilograms.** The API has no unit field. Input fields are named `weight_kg` so there's no ambiguity about what the model is sending, and markdown output renders both (`60 kg (132.3 lb)`) so a US-based reader doesn't have to convert mentally.

**Page-size caps are enforced client-side.** Hevy returns a bare 400 for an oversized page. The Zod schemas cap each endpoint at its documented limit (10 for most, 100 for exercise templates), so the model gets a precise message instead of a failed request.

**Errors resolve to next actions.** A 404 names the tool that produces valid ids for that resource. A 409 on a body measurement points at the update tool. A 403 explains that API access requires Pro.

**Permissive output schemas.** Hevy's docs warn that this 0.0.1 API may change structure without notice. Output schemas use `passthrough()` with optional fields so an upstream field addition doesn't turn into a hard tool failure.

## Project layout

```
src/
├── index.ts               # entry point, transport selection
├── constants.ts           # API limits, enums, character limit
├── types.ts               # interfaces for every Hevy entity
├── services/
│   └── hevy-client.ts     # fetch wrapper, auth, error → guidance mapping
├── schemas/
│   ├── inputs.ts          # Zod input schemas
│   └── outputs.ts         # structuredContent schemas
├── formatters/
│   ├── response.ts        # pagination, truncation, format dispatch
│   └── entities.ts        # per-entity markdown rendering
└── tools/
    ├── workouts.ts
    ├── routines.ts
    ├── exercise-templates.ts
    └── progress.ts
```

## Caveats

- The Hevy API is officially version 0.0.1 and its own docs warn the structure may change or be abandoned.
- A routine's folder can't be changed after creation — the update endpoint doesn't accept `folder_id`.
- Equipment filtering in search matches against the exercise title, since the API doesn't expose equipment as a field on templates.
- `hevy_create_exercise_template` returns a numeric id, unlike the string ids used everywhere else in the API.

## Tests

```bash
pnpm run build
pnpm test         # 31 checks: MCP handshake, tools, formatting, errors (mocked API)
pnpm run test:http  # 13 checks: path-secret gating, health check, origin allowlist
```

Both suites run against a local mock, so no API key or network access is needed.
