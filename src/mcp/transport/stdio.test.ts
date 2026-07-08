import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connectStdio } from './stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function fakeServer(): McpServer {
  return { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
}

function fakeStdin(): NodeJS.ReadStream {
  return new EventEmitter() as unknown as NodeJS.ReadStream;
}

describe('connectStdio', () => {
  it('exits the process when the client closes stdin', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdin = fakeStdin();
    await connectStdio(fakeServer(), stdin);
    stdin.emit('close');
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it('does not exit before stdin closes', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await connectStdio(fakeServer(), fakeStdin());
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
