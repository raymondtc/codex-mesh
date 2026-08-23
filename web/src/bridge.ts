import type { ConnectionState, ServerRequest } from "./types";

type EventHandler = (method: string, params: unknown) => void;
type StateHandler = (state: ConnectionState, message?: string) => void;
type RequestHandler = (request: ServerRequest) => void;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class BridgeClient {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private token = "";
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: number;
  onEvent?: EventHandler;
  onState?: StateHandler;
  onServerRequest?: RequestHandler;

  connect(token: string): void {
    this.disconnect();
    this.token = token;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.shouldReconnect) return;
    window.clearTimeout(this.reconnectTimer);
    this.onState?.("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: this.token }));
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "ready") {
        this.reconnectAttempts = 0;
        this.onState?.("ready");
        return;
      }
      if (message.type === "rpcResult") {
        const id = String(message.id);
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        const error = message.error as { message?: string } | undefined;
        if (error) call.reject(new Error(error.message ?? "Unknown bridge error"));
        else call.resolve(message.result);
        return;
      }
      if (message.type === "event") {
        this.onEvent?.(String(message.method), message.params);
        return;
      }
      if (message.type === "serverRequest") {
        this.onServerRequest?.({
          id: message.id as string | number,
          method: String(message.method),
          params: (message.params ?? {}) as Record<string, unknown>,
        });
        return;
      }
      if (message.type === "fatal") this.onState?.("error", String(message.message));
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const call of this.pending.values()) call.reject(new Error("Bridge connection closed"));
      this.pending.clear();
      if (event.code === 4401) {
        this.shouldReconnect = false;
        this.onState?.("closed", "Token 错误");
        return;
      }
      if (this.shouldReconnect) {
        const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 10_000);
        this.reconnectAttempts += 1;
        this.onState?.("connecting", `连接已断开，${Math.ceil(delay / 1000)} 秒后重试…`);
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
      } else {
        this.onState?.("closed", event.reason || undefined);
      }
    });
    socket.addEventListener("error", () => {
      // A following close event owns retry scheduling and user-visible state.
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Bridge is not connected"));
    const id = String(this.nextId++);
    this.socket.send(JSON.stringify({ type: "rpc", id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
  }

  respond(id: string | number, result?: unknown, error?: { message: string }): void {
    this.socket?.send(JSON.stringify({ type: "serverResponse", id, result, error }));
  }
}
