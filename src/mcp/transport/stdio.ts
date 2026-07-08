import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function connectStdio(
  server: McpServer,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Neither the SDK nor Node itself guarantees the process exits when the
  // client disconnects: a handle left open by an in-flight request (e.g. an
  // aborted-but-not-yet-torn-down socket) can keep the event loop alive
  // indefinitely after stdin closes. Force the exit so a disconnected
  // client always results in a dead process.
  stdin.on('close', () => process.exit(0));
}
