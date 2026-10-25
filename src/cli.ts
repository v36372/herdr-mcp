#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHerdrServer } from "./server.js";

async function main() {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      session: { type: "string" },
      "allow-writes": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write("Usage: herdr-sdk-mcp [--socket /absolute/path | --session name] [--allow-writes]\nLocal stdio MCP. Read-only by default. Writes grant shell-equivalent access.\n");
    return;
  }
  if (values.socket !== undefined && values.session !== undefined) {
    throw new Error("Select either --socket or --session, not both.");
  }
  const app = createHerdrServer({
    config: {
      ...(values.socket === undefined ? {} : { socketPath: values.socket }),
      ...(values.session === undefined ? {} : { session: values.session }),
    },
    allowWrites: values["allow-writes"],
  });
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
