import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import type { AppServerMessage, RpcRequest, RpcResponse } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private initializedResponse: unknown;

  constructor(
    private readonly codexBin: string,
    private readonly cwd?: string,
    private readonly endpoint?: string,
    private readonly fallbackToStdio = false,
  ) {
    super();
  }

  get initialized(): unknown {
    return this.initializedResponse;
  }

  async start(): Promise<void> {
    if (this.child || this.socket) return;

    if (this.endpoint && this.endpoint !== "stdio://") {
      try {
        await this.startSocket(this.endpoint);
        await this.initialize();
        return;
      } catch (error) {
        this.terminateSocket();
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        if (!this.fallbackToStdio) throw error;
        this.emit("stderr", `Could not connect to shared app-server at ${this.endpoint}; falling back to stdio.\n`);
      }
    }

    this.child = spawn(this.codexBin, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      const reason = new Error(`codex app-server exited (code=${code ?? "none"}, signal=${signal ?? "none"})`);
      this.failAll(reason);
      this.child = undefined;
      this.emit("exit", reason);
    });

    await this.initialize();
  }

  private async initialize(): Promise<void> {
    this.initializedResponse = await this.request("initialize", {
      clientInfo: {
        name: "codex-remote-web",
        title: "Codex Remote Web",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  private async startSocket(endpoint: string): Promise<void> {
    const address = socketAddress(endpoint);
    const socket = new WebSocket(address, { perMessageDeflate: false });

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        socket.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        socket.off("open", handleOpen);
        reject(error);
      };
      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });

    this.socket = socket;
    socket.on("message", (data) => this.handleLine(String(data)));
    socket.on("error", (error) => this.emit("stderr", `${error.message}\n`));
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      const detail = reason.length ? `, reason=${String(reason)}` : "";
      const error = new Error(`codex app-server connection closed (code=${code}${detail})`);
      this.failAll(error);
      this.socket = undefined;
      this.emit("exit", error);
    });
  }

  request(method: string, params?: unknown, timeoutMs = 90_000): Promise<unknown> {
    const id = this.nextId++;
    const payload: RpcRequest = { id, method, ...(params === undefined ? {} : { params }) };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result?: unknown, error?: { message: string }): void {
    if (error) {
      this.write({ id, error: { code: -32000, message: error.message } });
      return;
    }
    this.write({ id, result: result ?? null });
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.socket?.close(1000, "Client shutting down");
  }

  private terminateSocket(): void {
    this.socket?.terminate();
    this.socket = undefined;
  }

  private write(message: AppServerMessage): void {
    const payload = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
      return;
    }
    if (this.child?.stdin.writable) {
      this.child.stdin.write(`${payload}\n`);
      return;
    }
    throw new Error("codex app-server is not running");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      this.emit("stderr", `Ignoring non-JSON app-server output: ${line}\n`);
      return;
    }

    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message);
      return;
    }

    if ("id" in message) {
      const response = message as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
      return;
    }

    this.emit("notification", message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function socketAddress(endpoint: string): string {
  if (endpoint.startsWith("unix://")) {
    const socketPath = endpoint.slice("unix://".length);
    if (!socketPath.startsWith("/")) throw new Error("CODEX_APP_SERVER_URL unix socket path must be absolute");
    return `ws+unix://${socketPath}:/`;
  }
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) return endpoint;
  throw new Error("CODEX_APP_SERVER_URL must use unix://, ws://, wss://, or stdio://");
}
