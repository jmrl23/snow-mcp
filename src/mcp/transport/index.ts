import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TransportConfig } from '../../config.js';
import { connectStdio } from './stdio.js';
import { connectHttp, type HttpTransportHandle } from './http.js';

export interface TransportHandle {
  close(): Promise<void>;
}

export async function connectTransport(
  serverFactory: () => McpServer,
  config: TransportConfig,
): Promise<TransportHandle> {
  if (config.kind === 'stdio') {
    // stdio is single-client: resolve the factory once at connection time.
    await connectStdio(serverFactory());
    return { async close() {} };
  }
  const handle: HttpTransportHandle = await connectHttp(serverFactory, {
    host: config.host,
    port: config.port,
    authToken: config.authToken,
  });
  return handle;
}
