import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
}

export interface HttpTransportHandle {
  port: number;
  close(): Promise<void>;
}

export async function connectHttp(
  server: McpServer,
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void transport.handleRequest(req, res);
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
      await transport.close();
    },
  };
}
