export interface SyncCheckpointEvent {
  vaultId: string;
  checkpoint: string;
  changesetId: string;
  authorDeviceId: string;
  ts: string;
}

type RealtimeStatus = "connecting" | "connected" | "disconnected" | "error";

interface RealtimeSyncClientOptions {
  baseUrl: string;
  vaultId: string;
  getAccessToken: () => Promise<string>;
  getDeviceId: () => string | null;
  onCheckpoint: (event: SyncCheckpointEvent) => void;
  onStatusChange?: (status: RealtimeStatus, detail?: string) => void;
}

interface ServerSentEvent {
  event: string;
  data: string;
}

export class RealtimeSyncClient {
  private abortController: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private stopped = true;
  private reconnectAttempt = 0;

  constructor(private readonly options: RealtimeSyncClientOptions) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.options.onStatusChange?.("disconnected");
  }


  private async connectLoop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.options.onStatusChange?.("connecting");

    try {
      const accessToken = await this.options.getAccessToken();
      const response = await fetch(this.streamUrl(), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${accessToken}`
        },
        signal: abortController.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`sync stream failed with status ${response.status}`);
      }

      this.reconnectAttempt = 0;
      this.options.onStatusChange?.("connected");
      await this.readEventStream(response.body, abortController.signal);
    } catch (error) {
      if (this.stopped || abortController.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatusChange?.("error", message);
    }

    if (!this.stopped) {
      this.scheduleReconnect();
    }
  }

  private streamUrl(): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    return `${base}/vaults/${encodeURIComponent(this.options.vaultId)}/sync/stream`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.options.onStatusChange?.("disconnected", `reconnect in ${delay}ms`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectLoop();
    }, delay);
  }

  private async readEventStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        this.handleServerSentEvent(parseServerSentEvent(part));
      }
    }
  }

  private handleServerSentEvent(message: ServerSentEvent): void {
    if (message.event !== "checkpoint") {
      return;
    }

    const parsed = parseCheckpointEvent(message.data);
    if (!parsed) {
      return;
    }

    if (parsed.authorDeviceId === this.options.getDeviceId()) {
      return;
    }

    this.options.onCheckpoint(parsed);
  }
}

export function parseServerSentEvent(raw: string): ServerSentEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

function parseCheckpointEvent(data: string): SyncCheckpointEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<SyncCheckpointEvent>;
    if (
      typeof parsed.vaultId !== "string" ||
      typeof parsed.checkpoint !== "string" ||
      typeof parsed.changesetId !== "string" ||
      typeof parsed.authorDeviceId !== "string" ||
      typeof parsed.ts !== "string"
    ) {
      return null;
    }
    return {
      vaultId: parsed.vaultId,
      checkpoint: parsed.checkpoint,
      changesetId: parsed.changesetId,
      authorDeviceId: parsed.authorDeviceId,
      ts: parsed.ts
    };
  } catch {
    return null;
  }
}
