import { EventEmitter } from "node:events";
import { AppServerClient } from "./app-server-client.js";

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
