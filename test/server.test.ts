import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Duration } from "effect";
import fixtures from "./fixtures.json" with { type: "json" };
import { createHerdrServer } from "../src/server.js";

const requestSchema = z.object({ id: z.string(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
type Request = z.infer<typeof requestSchema>;
const results = new Map<string, unknown>(Object.entries(fixtures));

async function setup(t: TestContext, options: {
  allowWrites?: boolean;
  protocol?: number;
  timeout?: number;
  stdio?: "flags" | "environment";
  respond?: (request: Request, socket: Socket) => unknown;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hmcp-"));
  const socketPath = join(directory, "api.sock");
  const requests: Request[] = [];
  const sockets = new Set<Socket>();
  const events = new EventEmitter();
  const errors: unknown[] = [];
  const fixture = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); events.emit("close"); });
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const request = requestSchema.parse(JSON.parse(line));
          requests.push(request);
          events.emit("request", request);
          const response = request.method === "ping"
            ? { id: request.id, result: { ...fixtures.ping, protocol: options.protocol ?? 22 } }
            : options.respond ? options.respond(request, socket)
            : { id: request.id, result: results.get(request.method) };
          if (response !== undefined) socket.write(JSON.stringify(response) + "\n");
        } catch (error) {
          errors.push(error);
          socket.destroy();
        }
      }
    });
  });
  const app = createHerdrServer({ config: { socketPath, requestTimeout: Duration.millis(options.timeout ?? 1000) }, allowWrites: options.allowWrites });
  const client = new Client({ name: "test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await app.close();
    for (const socket of sockets) socket.destroy();
    if (fixture.listening) await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  fixture.listen(socketPath);
  await once(fixture, "listening", { signal: AbortSignal.timeout(2000) });
  if (options.stdio) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        ...(options.stdio === "flags" ? ["--socket", socketPath] : []),
        ...(options.allowWrites ? ["--allow-writes"] : [])],
      env: options.stdio === "environment" ? { HERDR_SOCKET_PATH: socketPath } : {},
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk; });
    t.after(() => assert.equal(stderr, ""));
    await client.connect(transport);
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  return {
    client, requests, app,
    async waitForRequest(method: string) {
      while (!requests.some((request) => request.method === method)) {
        await once(events, "request", { signal: AbortSignal.timeout(2000) });
      }
    },
    async waitForClose() {
      while (sockets.size > 0) await once(events, "close", { signal: AbortSignal.timeout(2000) });
    },
  };
}

function text(result: unknown): string {
  return z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1) }).parse(result).content[0].text;
}

function body(result: unknown): unknown {
  return JSON.parse(text(result));
}

const cases = [
  ["herdr_session_snapshot", "session.snapshot", {}],
  ["herdr_workspace_list", "workspace.list", {}],
  ["herdr_tab_list", "tab.list", { workspaceId: "workspace-1" }],
  ["herdr_pane_list", "pane.list", { workspaceId: "workspace-1" }],
  ["herdr_pane_read", "pane.read", { paneId: "pane-1" }],
  ["herdr_agent_list", "agent.list", {}],
  ["herdr_agent_wait", "agent.wait", { paneId: "pane-1", timeoutMs: 6000 }],
  ["herdr_workspace_create", "workspace.create", { cwd: "/tmp", label: "test" }],
  ["herdr_pane_split", "pane.split", { paneId: "pane-1", direction: "right" }],
  ["herdr_pane_send_text", "pane.send_text", { paneId: "pane-1", text: "hello\n" }],
  ["herdr_pane_send_keys", "pane.send_keys", { paneId: "pane-1", keys: ["Enter"] }],
  ["herdr_agent_prompt", "agent.prompt", { paneId: "pane-1", text: "inspect" }],
] satisfies [string, string, Record<string, unknown>][];

test("read-only discovery opens no sockets and does not expose mutation handlers", { timeout: 5000 }, async (t) => {
  const { client, requests } = await setup(t);
  const list = await client.listTools();
  assert.equal(list.tools.length, 8);
  assert.ok(list.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  const denied = await client.callTool({ name: "herdr_pane_send_text", arguments: { paneId: "p", text: "x" } });
  assert.equal(denied.isError, true);
  assert.deepEqual(requests, []);
});

test("all tools cross MCP and SDK boundaries with one shared compatibility check", { timeout: 10_000 }, async (t) => {
  const { client, requests } = await setup(t, { allowWrites: true });
  assert.equal((await client.listTools()).tools.length, 13);
  for (const [name, method, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
    assert.equal(requests.at(-1)?.method, method);
    assert.deepEqual(result.structuredContent, body(result));
  }
  assert.equal(requests.filter((request) => request.method === "ping").length, 1);
  const read = requests.find((request) => request.method === "pane.read");
  assert.deepEqual(read?.params, { pane_id: "pane-1", source: "recent", lines: 100, format: "text", strip_ansi: true });
  assert.equal(requests.find((request) => request.method === "tab.list")?.params?.workspace_id, "workspace-1");
  assert.equal(requests.find((request) => request.method === "workspace.create")?.params?.focus, false);
  assert.equal(requests.find((request) => request.method === "pane.split")?.params?.focus, false);
  assert.equal(requests.find((request) => request.method === "agent.wait")?.params?.timeout_ms, 6000);
  assert.deepEqual(requests.find((request) => request.method === "pane.send_text")?.params, { pane_id: "pane-1", text: "hello\n" });
  assert.deepEqual(requests.find((request) => request.method === "pane.send_keys")?.params, { pane_id: "pane-1", keys: ["Enter"] });
  assert.equal(requests.find((request) => request.method === "agent.prompt")?.params?.text, "inspect");
});

test("pane output preserves text and normalizes optional SDK values to null", { timeout: 5000 }, async (t) => {
  const { client } = await setup(t);
  const output = body(await client.callTool({ name: "herdr_pane_read", arguments: { paneId: "p" } }));
  assert.deepEqual(output, { result: { paneId: "fixture", workspaceId: "fixture", tabId: "fixture", source: "visible", format: "text", text: "fixture", revision: 0, truncated: false } });
  const agent = body(await client.callTool({ name: "herdr_agent_wait", arguments: { paneId: "p" } }));
  assert.equal(z.object({ result: z.object({ name: z.null() }) }).safeParse(agent).success, true);
});

test("schema limits and unknown arguments fail before socket acquisition", { timeout: 5000 }, async (t) => {
  const { client, requests } = await setup(t, { allowWrites: true });
  for (const args of [{ paneId: "" }, { paneId: "p", lines: 1001 }, { paneId: "p", arbitrary: true }]) {
    assert.equal((await client.callTool({ name: "herdr_pane_read", arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: "herdr_agent_wait", arguments: { paneId: "p", timeoutMs: 90_001 } })).isError, true);
  assert.deepEqual(requests, []);
  assert.equal((await client.callTool({ name: "herdr_workspace_create", arguments: { cwd: "relative" } })).isError, true);
  assert.deepEqual(requests, []);
});

test("protocol mismatch prevents ordinary requests", { timeout: 5000 }, async (t) => {
  const { client, requests } = await setup(t, { protocol: 21 });
  const result = await client.callTool({ name: "herdr_workspace_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /HerdrUnsupportedProtocol/);
  assert.deepEqual(requests.map((request) => request.method), ["ping"]);
});

test("server failures never export messages, paths, or nested causes", { timeout: 5000 }, async (t) => {
  const { client } = await setup(t, { respond: (request) => ({ id: request.id, error: { code: "private-secret", message: "/private/secret password" } }) });
  const result = await client.callTool({ name: "herdr_workspace_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /HerdrServerError/);
  assert.doesNotMatch(text(result), /private|password|stack|cause/);
});

test("an explicit wait timeout remains distinct from a transport failure", { timeout: 5000 }, async (t) => {
  const { client } = await setup(t, { respond: (request) => ({ id: request.id, error: { code: "wait_timeout", message: "private detail" } }) });
  const result = await client.callTool({ name: "herdr_agent_wait", arguments: { paneId: "p" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /wait_timeout/);
  assert.doesNotMatch(text(result), /private detail/);
});

test("malformed wire responses produce a safe tool error", { timeout: 5000 }, async (t) => {
  const { client } = await setup(t, { respond: (request) => ({ id: request.id, result: { type: "workspace_list", workspaces: "secret" } }) });
  const result = await client.callTool({ name: "herdr_workspace_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(text(result), /secret/);
});

test("a lost mutation response times out without automatic retry and closes the socket", { timeout: 5000 }, async (t) => {
  const { client, requests, waitForClose } = await setup(t, { allowWrites: true, timeout: 250, respond: () => undefined });
  const result = await client.callTool({ name: "herdr_pane_send_text", arguments: { paneId: "p", text: "echo test\n" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /HerdrRequestTimeout/);
  assert.equal(requests.filter((request) => request.method === "pane.send_text").length, 1);
  await waitForClose();
});

test("MCP cancellation interrupts a pending SDK wait and releases its socket", { timeout: 5000 }, async (t) => {
  const { client, waitForRequest, waitForClose } = await setup(t, { respond: () => undefined });
  const controller = new AbortController();
  const pending = client.callTool({ name: "herdr_agent_wait", arguments: { paneId: "p", timeoutMs: 90_000 } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await waitForRequest("agent.wait");
  controller.abort();
  await rejected;
  await waitForClose();
});

test("oversized output fails explicitly rather than silently truncating a result", { timeout: 5000 }, async (t) => {
  const { client } = await setup(t, { respond: (request) => ({ id: request.id, result: { ...fixtures["pane.read"], read: { ...fixtures["pane.read"].read, text: "x".repeat(600_000) } } }) });
  const result = await client.callTool({ name: "herdr_pane_read", arguments: { paneId: "p" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /ResultTooLarge/);
});

for (const stdio of ["flags", "environment"] as const) {
  test(`stdio CLI uses ${stdio} configuration without stdout noise`, { timeout: 10_000 }, async (t) => {
    const { client, requests } = await setup(t, { stdio, allowWrites: stdio === "flags" });
    assert.equal((await client.listTools()).tools.length, stdio === "flags" ? 13 : 8);
    const ping = await client.callTool({ name: "herdr_ping", arguments: {} });
    assert.notEqual(ping.isError, true, text(ping));
    if (stdio === "flags") {
      const result = await client.callTool({ name: "herdr_workspace_create", arguments: { cwd: "/tmp" } });
      assert.notEqual(result.isError, true, text(result));
    }
    assert.ok(requests.some((request) => request.method === "ping"));
  });
}

test("server shutdown interrupts an active request and releases the SDK socket", { timeout: 5000 }, async (t) => {
  const { client, app, waitForRequest, waitForClose } = await setup(t, { respond: () => undefined });
  const pending = client.callTool({ name: "herdr_agent_wait", arguments: { paneId: "p", timeoutMs: 90_000 } });
  const rejected = assert.rejects(pending);
  await waitForRequest("agent.wait");
  await app.close();
  await rejected;
  await waitForClose();
});
