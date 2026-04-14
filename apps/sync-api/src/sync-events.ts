import type { FastifyReply } from "fastify";

export interface SyncCheckpointEvent {
  vaultId: string;
  checkpoint: string;
  changesetId: string;
  authorDeviceId: string;
  ts: string;
}

interface SyncEventClient {
  readonly id: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly write: (event: string, data: unknown) => void;
  readonly close: () => void;
}

const clientsByVault = new Map<string, Map<string, SyncEventClient>>();
let nextClientId = 0;

export function subscribeToSyncEvents(
  reply: FastifyReply,
  vaultId: string,
  deviceId: string,
  initialCheckpoint: string
): void {
  const clientId = `sync-stream-${Date.now()}-${nextClientId++}`;
  reply.hijack();
  reply.raw.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });

  const write = (event: string, data: unknown) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    write("ping", { ts: new Date().toISOString() });
  }, 25_000);
  heartbeat.unref?.();

  const client: SyncEventClient = {
    id: clientId,
    vaultId,
    deviceId,
    write,
    close: () => {
      clearInterval(heartbeat);
      const vaultClients = clientsByVault.get(vaultId);
      vaultClients?.delete(clientId);
      if (vaultClients && vaultClients.size === 0) {
        clientsByVault.delete(vaultId);
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  };

  const vaultClients = clientsByVault.get(vaultId) ?? new Map<string, SyncEventClient>();
  vaultClients.set(clientId, client);
  clientsByVault.set(vaultId, vaultClients);

  reply.raw.on("close", client.close);
  write("hello", {
    vaultId,
    deviceId,
    checkpoint: initialCheckpoint,
    serverTime: new Date().toISOString()
  });
}

export function publishSyncCheckpoint(event: SyncCheckpointEvent): void {
  const vaultClients = clientsByVault.get(event.vaultId);
  if (!vaultClients) {
    return;
  }

  for (const client of vaultClients.values()) {
    client.write("checkpoint", event);
  }
}

