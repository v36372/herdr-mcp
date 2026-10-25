# Private deployment on v36372-agent

Use `herdr-mcp.service` for the MCP server and `herdr-agent.service` for the dedicated `mcp-agent` session.
Both run as `exedev`. MCP listens on `127.0.0.1:8788` with read-only tools.
The existing Durable Agent service keeps its root route and port 8787.

## Authentication

Executor calls `https://herdr-agent.int.exe.xyz/herdr-mcp/mcp` through an exe.dev peer integration.
The platform authenticates the source VM and strips spoofed `X-Exedev-Source-Vm` headers.
The MCP server accepts only the attested `v36372-executor` identity and rejects every browser `Origin`.
No API credential enters either repository or the Executor app source.

CAUTION: This header policy relies on exe.dev's authenticated proxy. Never expose port 8788 directly or copy it behind another proxy.
The VM must remain private. The integration must attach only to `v36372-executor`.
Anyone with execution access on that VM can use the integration.

## Install

1. Install pinned Herdr 0.9.0 at `/home/exedev/.local/bin/herdr`. Verify the release asset checksum before installation.

   ```sh
   curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.0/herdr-linux-x86_64 -o /tmp/herdr-0.9.0
   echo '4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f  /tmp/herdr-0.9.0' | sha256sum -c -
   install -m 755 /tmp/herdr-0.9.0 /home/exedev/.local/bin/herdr
   ```

2. Clone this repository into `/home/exedev/codes/herdr-mcp`. Run checks against isolated fixtures.

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm test
   ```

3. Install the units and start the dedicated session before MCP.

   ```sh
   sudo install -m 644 deploy/herdr-agent.service deploy/herdr-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now herdr-agent.service herdr-mcp.service
   ```

4. Install the nginx route and include it inside the existing agent server block.

   ```sh
   sudo install -m 644 deploy/herdr-mcp.nginx.conf /etc/nginx/snippets/herdr-mcp.conf
   # Inside /etc/nginx/conf.d/durable-agent.conf, before location /:
   # include /etc/nginx/snippets/herdr-mcp.conf;
   sudo nginx -t
   sudo systemctl reload nginx
   ```

5. Add the peer integration, then deploy `deploy/executor/` as a separate Executor app named `Herdr SDK`.

   ```sh
   # Run through the exe.dev management interface:
   integrations add http-proxy --name herdr-agent --target https://v36372-agent.exe.xyz/ --peer --attach vm:v36372-executor
   ```

Keep the existing `herdr` Executor app unchanged. The new app uses slug `herdr-sdk`.
The source pins Executor's installed `apps@0.0.1-beta.95` framework and imports eight read-only tools through `mcpRouter`.
It requires approval for any future tool without a read-only hint. Tool discovery does not call Herdr.
Use source deployment to route discovery through the app runtime, rather than Quick Add's separate endpoint probe.

Installed app: `app_8d577426-3660-4202-b825-da049254e628` in organization `IWiWEyVV4RN5tdxbhig8EUkJ9PhwpjRF`.
Its MCP namespace is `tools["herdr-sdk"]`. No provider account or credential is necessary.
The instance already permits private app fetches through `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`.

## Verification and maintenance

```sh
systemctl is-active herdr-agent.service herdr-mcp.service
systemctl is-enabled herdr-agent.service herdr-mcp.service
curl -fsS -H 'X-Exedev-Source-Vm: v36372-executor' http://127.0.0.1:8788/healthz
```

If `/healthz` refuses the connection immediately after startup, wait two seconds and repeat that read-only check.
The local identity header above checks process readiness only. It does not prove remote authentication.
Check the peer route from Executor with MCP initialization and tool discovery, not terminal mutations.
`/healthz` reports HTTP readiness, not Herdr socket health. Production tool calls do not form part of the test suite.

After a code update, run `npm ci --ignore-scripts`, `npm run check`, and `npm test`, then restart only `herdr-mcp.service`.
Do not restart Herdr for an MCP update. A Herdr restart can terminate its terminal processes.

MCP request bodies have a 256 KiB limit. Sessions expire after two idle minutes and share one SDK runtime each.
The server permits at most 64 sessions. MCP cancellation stays within its session and never retries a mutation.

WARNING: Add `--allow-writes` only after explicit authorization. It grants shell-equivalent access to Executor callers.
