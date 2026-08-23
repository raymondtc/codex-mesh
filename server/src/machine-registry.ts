import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { AppServerClient } from "./app-server-client.js";
import type { RpcRequest } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface MachineTransport extends EventEmitter {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  respond(id: number | string, result?: unknown, error?: { message: string }): void;
  close(): void;
}

export class LocalMachineTransport extends EventEmitter implements MachineTransport {
  constructor(private readonly client: AppServerClient, private readonly requestHandler: (method: string, params?: unknown) => Promise<unknown>) {
    super();
    client.on("notification", (notification) => this.emit("notification", notification));
    client.on("serverRequest", (request) => this.emit("serverRequest", request));
    client.on("exit", (error) => this.emit("exit", error));
  }

  request(method: string, params?: unknown): Promise<unknown> { return this.requestHandler(method, params); }
  respond(id: number | string, result?: unknown, error?: { message: string }): void { this.client.respond(id, result, error); }
  close(): void { /* The process lifecycle owns the shared local app-server. */ }
}

export class AgentMachineTransport extends EventEmitter implements MachineTransport {
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly socket: WebSocket) {
    super();
    socket.on("message", (raw) => this.handleMessage(String(raw)));
    socket.on("close", () => this.failAll(new Error("Machine agent disconnected")));
    socket.on("error", (error) => this.failAll(error));
  }

  request(method: string, params?: unknown, timeoutMs = 90_000): Promise<unknown> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Machine RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "rpc", id, method, params });
    });
  }

  respond(id: number | string, result?: unknown, error?: { message: string }): void {
    this.send({ type: "serverResponse", id, result, error });
  }

  close(): void { this.socket.close(1000, "Machine removed"); }

  private handleMessage(raw: string): void {
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === "rpcResult") {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? "Machine RPC failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === "event") this.emit("notification", { method: message.method, params: message.params });
    if (message.type === "serverRequest") this.emit("serverRequest", message as RpcRequest);
    if (message.type === "hello") this.emit("hello", message);
  }

  private send(message: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Machine agent is offline");
    this.socket.send(JSON.stringify(message));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }
}

export class MachineRegistry {
  private connections = new Map<string, MachineTransport>();

  register(machineId: string, transport: MachineTransport): void {
    this.connections.get(machineId)?.close();
    this.connections.set(machineId, transport);
    transport.once("exit", () => {
      if (this.connections.get(machineId) === transport) this.connections.delete(machineId);
    });
  }

  get(machineId: string): MachineTransport | undefined { return this.connections.get(machineId); }
  isOnline(machineId: string): boolean { return this.connections.has(machineId); }
  unregister(machineId: string): void { this.connections.get(machineId)?.close(); this.connections.delete(machineId); }
  closeAll(): void { for (const connection of this.connections.values()) connection.close(); this.connections.clear(); }
}
