/**
 * Tests the hosted HTTP transport: path-secret gating, health check, origin
 * allowlist, and the refusal to start publicly bound without a secret.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the repo root from this file so the test runs from any working directory. */
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

const SECRET = "a".repeat(64);
const PORT = 8899;
const results = [];

const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const startServer = (env) =>
  new Promise((resolve) => {
    const child = spawn("node", ["dist/index.js"], {
      cwd: REPO_ROOT,
      env: { ...process.env, HEVY_API_KEY: "11111111-2222-3333-4444-555555555555", TRANSPORT: "http", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ child, exited: true, code, stderr: () => stderr }));
    setTimeout(() => resolve({ child, exited: false, code: null, stderr: () => stderr }), 1200);
  });

// 1. Refuses to start bound publicly with no secret.
const unguarded = await startServer({ HOST: "0.0.0.0", PORT: String(PORT + 1) });
check(
  "refuses public bind without MCP_PATH_SECRET",
  unguarded.exited && unguarded.code === 1 && unguarded.stderr().includes("REFUSING TO START"),
  `exit ${unguarded.code}`,
);
if (!unguarded.exited) unguarded.child.kill();

// 2. Start a properly configured hosted server.
const server = await startServer({ HOST: "0.0.0.0", PORT: String(PORT), MCP_PATH_SECRET: SECRET });
check("starts with a secret configured", !server.exited);

const rpcBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

const post = (path, headers = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: rpcBody,
  });

const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
check("health check is open and returns ok", health.status === 200 && (await health.json()).status === "ok");

const correct = await post(`/mcp/${SECRET}`);
const correctBody = await correct.json();
check("correct secret reaches the MCP server", correct.status === 200 && correctBody.result?.serverInfo?.name === "hevy-mcp-server");

const wrong = await post(`/mcp/${"b".repeat(64)}`);
check("wrong secret is rejected", wrong.status === 404);

const bare = await post("/mcp");
check("bare /mcp path is rejected when secret is set", bare.status === 404);

const short = await post(`/mcp/${"a".repeat(10)}`);
check("truncated secret is rejected", short.status === 404);

const wrongIndistinguishable = await post("/definitely-not-a-real-path");
check("wrong secret is indistinguishable from unknown path", wrong.status === wrongIndistinguishable.status, `both ${wrong.status}`);

const claudeOrigin = await post(`/mcp/${SECRET}`, { origin: "https://claude.ai" });
check("claude.ai origin allowed", claudeOrigin.status === 200);

const evilOrigin = await post(`/mcp/${SECRET}`, { origin: "https://evil.example.com" });
check("unknown origin blocked", evilOrigin.status === 403);

const noOrigin = await post(`/mcp/${SECRET}`);
check("no-origin server-to-server request allowed", noOrigin.status === 200);

server.child.kill();

// 3. Local stdio-adjacent default: loopback bind needs no secret.
const local = await startServer({ HOST: "127.0.0.1", PORT: String(PORT + 2) });
check("loopback bind starts without a secret", !local.exited);
const localOk = await fetch(`http://127.0.0.1:${PORT + 2}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: rpcBody,
});
check("loopback serves bare /mcp", localOk.status === 200);
local.child.kill();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
