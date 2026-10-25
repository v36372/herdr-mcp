import { defineApp, toolAnnotations, withApprovals } from "apps";
import { always } from "apps/operations/approval";
import { mcpRouter } from "apps/mcp";

export default defineApp({}, async ({ signal }) => ({
  tools: withApprovals(await mcpRouter({
    url: "https://herdr-agent.int.exe.xyz/herdr-mcp/mcp",
    signal,
  }), (tool) => toolAnnotations(tool)?.readOnlyHint === true ? undefined : always()),
}));
