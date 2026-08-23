import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class AppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();

  constructor(private readonly codexBin: string, private readonly cwd?: string, private readonly endpoint?: string, private readonly fallbackToStdio = false) { super(); }

  async start(): Promise<void> {
    if (this.child || this.socket) return;
    if (this.endpoint && this.endpoint !== "stdio://") {
      try { await this.startSocket(this.endpoint); await this.initialize(); return; }
      catch (error) {
        this.terminateSocket();
        if (!this.fallbackToStdio) throw error;
        this.emit("stderr", `Could not connect to ${this.endpoint}; falling back to stdio.\n`);
      }
    }
    this.child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => { const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`); this.child = undefined; this.failAll(error); this.emit("exit", error); });
    await this.initialize();
  }

  request(method: string, params?: unknown, timeoutMs = 90_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`app-server request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  respond(id: string | number, result?: unknown, error?: { message: string }): void { this.write(error ? { id, error: { code: -32000, message: error.message } } : { id, result: result ?? null }); }
  stop(): void { this.child?.kill("SIGTERM"); this.socket?.close(1000, "Agent shutting down"); }

  private async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "codex-mesh-agent", title: "Codex Mesh Agent", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.write({ method: "initialized", params: {} });
  }

  private async startSocket(endpoint: string): Promise<void> {
    const address = endpoint.startsWith("unix://") ? `ws+unix://${endpoint.slice(7)}:/` : endpoint;
    if (!address.startsWith("ws://") && !address.startsWith("wss://") && !address.startsWith("ws+unix://")) throw new Error("CODEX_APP_SERVER_URL must use unix://, ws://, wss://, or stdio://");
    const socket = new WebSocket(address, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    this.socket = socket;
    socket.on("message", (raw) => this.handleLine(String(raw)));
    socket.on("error", (error) => this.emit("stderr", `${error.message}\n`));
    socket.on("close", () => { if (this.socket === socket) { this.socket = undefined; const error = new Error("Local app-server disconnected"); this.failAll(error); this.emit("exit", error); } });
  }

  private write(message: unknown): void {
    const payload = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) return void this.socket.send(payload);
    if (this.child?.stdin.writable) return void this.child.stdin.write(`${payload}\n`);
    throw new Error("codex app-server is not running");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { this.emit("stderr", `Ignoring non-JSON app-server output: ${line}\n`); return; }
    if ("id" in message && "method" in message) return void this.emit("serverRequest", message);
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      return;
    }
    this.emit("notification", message);
  }

  private failAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  private terminateSocket(): void { this.socket?.terminate(); this.socket = undefined; }
}
