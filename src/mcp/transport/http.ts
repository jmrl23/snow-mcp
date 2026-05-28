import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { redactSecrets } from '../../log-redact.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
  authToken: string;
}

export interface HttpTransportHandle {
  port: number;
  close(): Promise<void>;
}

export async function connectHttp(
  // Factory called once per request — stateless mode requires a fresh server+transport pair each time.
  serverFactory: () => McpServer,
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const expectedBuf = Buffer.from(opts.authToken);

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const authHeader = req.headers['authorization'] ?? '';
    const bearerMatch = /^Bearer (.*)$/i.exec(authHeader);
    const supplied = bearerMatch ? bearerMatch[1] : null;

    const isAuthorized =
      supplied !== null &&
      (() => {
        const suppliedBuf = Buffer.from(supplied);
        if (suppliedBuf.length !== expectedBuf.length) return false;
        return timingSafeEqual(suppliedBuf, expectedBuf);
      })();

    if (!isAuthorized) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer realm="snow-mcp"');
      res.end('Unauthorized');
      return;
    }

    // Per-request server + transport: StreamableHTTPServerTransport is single-use in stateless mode.
    // A shared transport clobbers internal req/res refs after the first call, causing silent 500s.
    // Wrap everything in an async IIFE so both sync throws (from factory()) and async rejections
    // (from server.connect / transport.handleRequest) are funnelled into the same error handler.
    void (async () => {
      let server: McpServer | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
        enableJsonResponse: true,
      });
      try {
        server = serverFactory();
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err: unknown) {
        // NOTE: we do not classify SDK errors here. On the normal error path the SDK has already
        // written the user-visible JSON-RPC error response; this catch only fires for transport-level
        // failures (factory throws, connect fails, etc.) where the response is still open.
        // Redact credential fragments that may appear in SDK or HTTP client error messages before logging.
        const raw = err instanceof Error ? err.message : String(err);
        console.error('[snow-mcp] MCP request error:', redactSecrets(raw));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      } finally {
        // Best-effort cleanup; ignore secondary errors during teardown.
        void transport.close().catch(() => {});
        void server?.close().catch(() => {});
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, resolve);
  });
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
