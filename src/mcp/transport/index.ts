import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TransportConfig } from '../../config.js';
import { connectStdio } from './stdio.js';
import { connectHttp, type HttpTransportHandle } from './http.js';

export interface TransportHandle {
  close(): Promise<void>;
}

export async function connectTransport(
  server: McpServer,
  config: TransportConfig,
): Promise<TransportHandle> {
  if (config.kind === 'stdio') {
    await connectStdio(server);
    return { async close() {} };
  }
  const handle: HttpTransportHandle = await connectHttp(server, {
    host: config.host,
    port: config.port,
    authToken: config.authToken,
  });
  return handle;
}
