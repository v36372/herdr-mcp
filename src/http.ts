import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHerdrServer } from "./server.js";

/** Serves MCP behind exe.dev's authenticated proxy, never on a public interface directly. */
export function createHerdrHttpServer(options: NonNullable<Parameters<typeof createHerdrServer>[0]> & { allowedPeer: string }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.allowedPeer)) throw new Error("An explicit exe.dev peer VM name is required.");
  type Session = {
    transport: StreamableHTTPServerTransport;
    refresh: () => void;
    close: () => Promise<void>;
  };
  const sessions = new Map<string, Session>();
  const active = new Set<Session>();
  let shutdown: Promise<void> | undefined;

  function acquire(): { app: ReturnType<typeof createHerdrServer>; session: Session } {
    const app = createHerdrServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => { sessions.set(id, session); },
      enableJsonResponse: true,
      maxRequestBodySize: 256 * 1024,
    });
    let idle: NodeJS.Timeout | undefined;
    let cleanup: Promise<void> | undefined;
    const session: Session = {
      transport,
      refresh() {
        clearTimeout(idle);
        idle = setTimeout(() => { void session.close().catch(() => {}); }, 120_000);
        idle.unref();
      },
      close() {
        return cleanup ??= Promise.resolve().then(async () => {
          clearTimeout(idle);
          active.delete(session);
          if (transport.sessionId) sessions.delete(transport.sessionId);
          await app.close();
        });
      },
    };
    app.server.server.onclose = () => { void session.close().catch(() => {}); };
    session.refresh();
    active.add(session);
    return { app, session };
  }

  const server = createServer(async (request, response) => {
    // exe.dev strips spoofed identity headers and attests the source VM at its private HTTPS proxy.
    if (request.headers["x-exedev-source-vm"] !== options.allowedPeer || request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    if (shutdown) {
      response.writeHead(503).end();
      return;
    }
    if (request.url === "/healthz" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST" && request.method !== "DELETE") {
      response.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    const id = request.headers["mcp-session-id"];
    let session = typeof id === "string" ? sessions.get(id) : undefined;
    let acquired: ReturnType<typeof acquire> | undefined;
    if (!session) {
      if (id !== undefined || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      if (active.size >= 64) {
        response.writeHead(503).end();
        return;
      }
      acquired = acquire();
      session = acquired.session;
    }
    const current = session;
    current.refresh();
    response.once("close", () => {
      if (!response.writableFinished) void current.close().catch(() => {});
    });
    try {
      if (acquired) await acquired.app.server.connect(current.transport);
      await current.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
      await current.close().catch(() => {});
    } finally {
      if (!current.transport.sessionId || request.method === "DELETE") await current.close().catch(() => {});
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    close() {
      return shutdown ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await Promise.allSettled([...active].map((session) => session.close()));
        server.closeAllConnections();
        await closed;
      })();
    },
  };
}
