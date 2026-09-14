import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

export async function runAcpStdio(args: string[]): Promise<void> {
  if (args.length) {
    process.stderr.write('Usage: peer acp (stdio; no options)\n');
    process.exitCode = 2;
    return;
  }
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    // Node and Bun declare incompatible BYOB overloads for the same web stream.
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const { createPeerAcpAgent } = await import('./agent.ts');
  let peer: ReturnType<typeof createPeerAcpAgent> | undefined;
  const connection = new AgentSideConnection((client) => {
    peer = createPeerAcpAgent(async (cwd, update, sessionId) => {
      const { createAcpRuntimeFactory } = await import('./runtime.ts');
      return createAcpRuntimeFactory((request) => client.requestPermission(request))(cwd, update, sessionId);
    }, (event) => client.sessionUpdate(event));
    return peer.agent;
  }, stream);
  try { await connection.closed; }
  finally { await peer?.close(); }
}
