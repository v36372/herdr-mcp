#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHerdrServer } from "./server.js";
import { createHerdrHttpServer } from "./http.js";

async function main() {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      session: { type: "string" },
      "allow-writes": { type: "boolean", default: false },
      "http-port": { type: "string" },
      "allowed-peer": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write("Usage: herdr-sdk-mcp [--socket /absolute/path | --session name] [--allow-writes]\nHTTP behind exe.dev only: --http-port PORT --allowed-peer VM\nRead-only by default. Writes grant shell-equivalent access.\n");
    return;
  }
  if (values.socket !== undefined && values.session !== undefined) {
    throw new Error("Select either --socket or --session, not both.");
  }
  const options = {
    config: {
      ...(values.socket === undefined ? {} : { socketPath: values.socket }),
      ...(values.session === undefined ? {} : { session: values.session }),
    },
    allowWrites: values["allow-writes"],
  };
  if (values["http-port"] !== undefined) {
    const port = Number(values["http-port"]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !values["allowed-peer"]) {
      throw new Error("HTTP requires a valid port and an explicit exe.dev peer VM.");
    }
    const app = createHerdrHttpServer({ ...options, allowedPeer: values["allowed-peer"] });
    let stop: Promise<void> | undefined;
    const shutdown = () => stop ??= Promise.resolve().then(() => app.close()).catch(() => {
      process.stderr.write("Herdr MCP shutdown failed.\n");
      process.exitCode = 1;
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", resolve);
    });
    return;
  }
  if (values["allowed-peer"] !== undefined) throw new Error("Peer authorization requires HTTP mode.");
  const app = createHerdrServer(options);
  let stop: Promise<void> | undefined;
  const shutdown = () => {
    stop ??= Promise.resolve().then(() => app.close()).catch(() => {
      process.stderr.write("Herdr MCP shutdown failed.\n");
      process.exitCode = 1;
    });
    return stop;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdout.once("error", shutdown);
  app.server.server.onclose = shutdown;
  try {
    await app.server.connect(new StdioServerTransport());
  } catch {
    await shutdown();
    throw new Error("MCP stdio transport failed.");
  }
}

main().catch(() => {
  process.stderr.write("Herdr MCP could not start. Check arguments with --help.\n");
  process.exitCode = 1;
});
