import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { posix as pathPosix } from "node:path";
import type { Duplex } from "node:stream";
import ssh2, { type Client as SshClient, type ClientChannel } from "ssh2";
import type { MachineTransport } from "./machine-registry.js";
import type { AppServerMessage, RpcRequest, RpcResponse } from "./protocol.js";

const { Client } = ssh2;

export interface SshCredential {
  privateKey: string;
  passphrase?: string;
}

export interface SshHostConfig extends SshCredential {
  host: string;
  port: number;
  username: string;
  hostKeySha256: string;
  codexCommand: string;
  createSocket?: () => Promise<Duplex>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class SshMachineTransport extends EventEmitter implements MachineTransport {
  private client?: SshClient;
  private channel?: ClientChannel;
  private starting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private remoteStderr = "";

  constructor(private readonly config: SshHostConfig) { super(); }

  async start(): Promise<void> {
    if (this.channel) return;
    if (this.starting) return this.starting;
    this.starting = this.connect();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async request(method: string, params?: unknown, timeoutMs = 90_000): Promise<unknown> {
    await this.start();
    if (method === "bridge/session/start") {
      const input = (params ?? {}) as Record<string, unknown>;
      const cwd = (await this.execText("mktemp -d /tmp/codex-mesh-chat-XXXXXXXX")).trim();
      return this.requestRaw("thread/start", {
        cwd,
        approvalPolicy: input.approvalPolicy ?? "on-request",
        sandbox: input.sandbox ?? "workspace-write",
        ...(typeof input.model === "string" ? { model: input.model } : {}),
      }, timeoutMs);
    }
    if (["bridge/fs/readDirectory", "bridge/fs/readFile", "bridge/fs/writeFile", "bridge/fs/downloadFile"].includes(method)) return this.fileRequest(method, params);
    if (method === "bridge/git/worktree/create") return this.createWorktree(params);
    return this.requestRaw(method, params, timeoutMs);
  }

  private requestRaw(method: string, params?: unknown, timeoutMs = 90_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SSH Codex RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params: params ?? {} });
    });
  }

  respond(id: number | string, result?: unknown, error?: { message: string }): void {
    this.write(error ? { id, error: { code: -32000, message: error.message } } : { id, result: result ?? null });
  }

  close(): void {
    this.channel?.close();
    this.client?.end();
    this.channel = undefined;
    this.client = undefined;
    this.failAll(new Error("SSH connection closed"));
  }

  private async connect(): Promise<void> {
    this.remoteStderr = "";
    const client = new Client();
    this.client = client;
    const socket = this.config.createSocket ? await this.config.createSocket() : undefined;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(safeSshError(error));
      client.once("ready", () => resolve());
      client.once("error", fail);
      client.connect({
        ...(socket ? { sock: socket } : { host: this.config.host, port: this.config.port }),
        username: this.config.username,
        privateKey: this.config.privateKey,
        ...(this.config.passphrase ? { passphrase: this.config.passphrase } : {}),
        readyTimeout: 15_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => fingerprintHostKey(key) === this.config.hostKeySha256,
      });
    });

    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(`sh -lc ${shellQuote(`exec ${this.config.codexCommand}`)}`, { pty: false }, (error, stream) => error ? reject(error) : resolve(stream));
    });
    this.channel = channel;
    createInterface({ input: channel }).on("line", (line) => this.handleLine(line));
    channel.stderr.on("data", (chunk) => {
      const value = String(chunk);
      this.remoteStderr = `${this.remoteStderr}${value}`.slice(-8_192);
      this.emit("stderr", value);
    });
    channel.once("close", (code: number | null, signal: string | null) => {
      const details = this.remoteStderr.trim();
      const error = new Error(`Remote Codex app-server exited (code=${code ?? "none"}, signal=${signal ?? "none"})${details ? `: ${details}` : ""}`);
      this.channel = undefined;
      this.failAll(error);
      this.emit("exit", error);
      client.end();
    });
    client.on("error", (error) => this.emit("stderr", `${safeSshError(error).message}\n`));

    await this.requestWithoutStart("initialize", {
      clientInfo: { name: "codex-mesh-ssh", title: "Codex Mesh SSH", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: "initialized" });
  }

  private requestWithoutStart(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    return this.requestRaw(method, params, timeoutMs);
  }

  private execText(command: string, limit = 1024 * 1024): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("SSH connection is not ready");
    return new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (error: Error | undefined, stream: ClientChannel) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        const errors: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); else stream.close(); });
        stream.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
        stream.on("close", (code: number | null) => {
          if (size > limit) return reject(new Error("Remote command output exceeded limit"));
          if (code && code !== 0) return reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `Remote command failed (${code})`));
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    });
  }

  private async threadRoot(threadId: string): Promise<string> {
    const result = await this.requestRaw("thread/read", { threadId, includeTurns: false }) as { thread?: { cwd?: string } };
    if (!result.thread?.cwd) throw new Error("Thread working directory is unavailable");
    return result.thread.cwd;
  }

  private async fileRequest(method: string, params: unknown): Promise<unknown> {
    const input = (params ?? {}) as { threadId?: unknown; path?: unknown; dataBase64?: unknown; overwrite?: unknown };
    if (typeof input.threadId !== "string") throw new Error("threadId is required");
    if (input.path !== undefined && typeof input.path !== "string") throw new Error("path must be a string");
    const root = await this.threadRoot(input.threadId);
    const requested = input.path || ".";
    if (pathPosix.isAbsolute(requested) || requested.split("/").includes("..")) throw new Error("File path is outside the thread working directory");
    if (method === "bridge/fs/writeFile") {
      const data = decodeUpload(input.dataBase64);
      if (!requested || requested === ".") throw new Error("Invalid upload path");
      const canonicalRoot = (await this.execText(`realpath -- ${shellQuote(root)}`)).trim();
      if (pathPosix.dirname(requested) === ".codex-mesh-uploads") await this.execText(`[ ! -L ${shellQuote(`${canonicalRoot}/.codex-mesh-uploads`)} ] && mkdir -p -m 700 -- ${shellQuote(`${canonicalRoot}/.codex-mesh-uploads`)}`);
      const parent = (await this.execText(`realpath -- ${shellQuote(pathPosix.resolve(root, pathPosix.dirname(requested)))}`)).trim();
      if (parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}/`)) throw new Error("File path is outside the thread working directory");
      const target = `${parent}/${pathPosix.basename(requested)}`;
      await this.sftpWrite(target, data, input.overwrite === true);
      return { path: pathPosix.relative(canonicalRoot, target), absolutePath: target, size: data.length };
    }
    const target = pathPosix.resolve(root, requested);
    const canonicalRoot = (await this.execText(`realpath -- ${shellQuote(root)}`)).trim();
    const canonicalTarget = (await this.execText(`realpath -- ${shellQuote(target)}`)).trim();
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}/`)) {
      this.emit("stderr", `[fs-scope] rejected target=${JSON.stringify(canonicalTarget)} threadRoot=${JSON.stringify(canonicalRoot)}\n`);
      throw new Error("File path is outside the thread working directory");
    }
    const relativePath = pathPosix.relative(canonicalRoot, canonicalTarget) || ".";
    if (method === "bridge/fs/readDirectory") {
      const encoded = await this.execText(`find ${shellQuote(canonicalTarget)} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0' | base64 -w0`, 4 * 1024 * 1024);
      const fields = Buffer.from(encoded.trim(), "base64").toString("utf8").split("\0");
      const entries = [];
      for (let index = 0; index + 3 < fields.length && entries.length < 500; index += 4) {
        const [name, type, size, modified] = fields.slice(index, index + 4);
        if (!name) continue;
        entries.push({ name, path: relativePath === "." ? name : `${relativePath}/${name}`, type: type === "d" ? "directory" : type === "f" ? "file" : "other", size: Number(size), modifiedAt: Math.floor(Number(modified)) });
      }
      return { path: relativePath, entries };
    }
    const size = Number((await this.execText(`stat -c %s -- ${shellQuote(canonicalTarget)}`)).trim());
    if (!Number.isFinite(size) || size > 8 * 1024 * 1024) throw new Error(`File exceeds ${method === "bridge/fs/downloadFile" ? "download" : "preview"} limit (8 MB)`);
    const encoded = await this.execText(`base64 -w0 -- ${shellQuote(canonicalTarget)}`, 12 * 1024 * 1024);
    const data = Buffer.from(encoded.trim(), "base64");
    const mimeType = imageMimeType(pathPosix.extname(canonicalTarget).toLowerCase());
    if (method === "bridge/fs/downloadFile") return { path: relativePath, size, dataBase64: data.toString("base64"), mimeType: mimeType ?? "application/octet-stream" };
    if (mimeType) return { path: relativePath, kind: "image", mimeType, size, dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
    if (data.includes(0)) return { path: relativePath, kind: "binary", size };
    return { path: relativePath, kind: "text", size, content: data.toString("utf8") };
  }

  private sftpWrite(path: string, data: Buffer, overwrite: boolean): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("SSH connection is not ready");
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) return reject(error);
        sftp.writeFile(path, data, { flag: overwrite ? "w" : "wx", mode: 0o600 }, (writeError) => {
          sftp.end();
          if (writeError) reject(new Error(`Remote upload failed: ${writeError.message}`)); else resolve();
        });
      });
    });
  }

  private async createWorktree(params: unknown): Promise<unknown> {
    const input = (params ?? {}) as { threadId?: unknown; branch?: unknown };
    if (typeof input.threadId !== "string") throw new Error("threadId is required");
    if (typeof input.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(input.branch) || input.branch.includes("..") || input.branch.includes("@{")) throw new Error("分支名无效");
    const cwd = await this.threadRoot(input.threadId);
    const sourceRoot = (await this.execText(`git -C ${shellQuote(cwd)} rev-parse --show-toplevel`)).trim();
    const mainRoot = (await this.execText(`git -C ${shellQuote(sourceRoot)} worktree list --porcelain | sed -n 's/^worktree //p' | head -n1`)).trim() || sourceRoot;
    const worktreePath = `${pathPosix.dirname(mainRoot)}/.codex-mesh-worktrees/${pathPosix.basename(mainRoot)}/${input.branch.replaceAll(/[/.]/g, "-")}`;
    await this.execText(`mkdir -p -- ${shellQuote(pathPosix.dirname(worktreePath))} && git -C ${shellQuote(sourceRoot)} worktree add -b ${shellQuote(input.branch)} ${shellQuote(worktreePath)} HEAD`);
    return { sourceRoot, mainRoot, worktreePath, branch: input.branch };
  }

  private write(message: AppServerMessage): void {
    if (!this.channel?.writable) throw new Error("SSH Codex channel is not connected");
    this.channel.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: AppServerMessage;
    try { message = JSON.parse(line) as AppServerMessage; }
    catch { this.emit("stderr", `Ignoring remote non-JSON output: ${line}\n`); return; }
    if ("id" in message && "method" in message) { this.emit("serverRequest", message as RpcRequest); return; }
    if ("id" in message) {
      const response = message as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result);
      return;
    }
    this.emit("notification", message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export async function probeSshHost(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint: string | undefined;
    const timer = setTimeout(() => { client.end(); reject(new Error("SSH host-key probe timed out")); }, 12_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      client.end();
      if (fingerprint) resolve(fingerprint); else reject(safeSshError(error ?? new Error("SSH host did not present a host key")));
    };
    client.on("error", (error) => finish(error));
    client.on("close", () => { if (fingerprint) finish(); });
    client.connect({
      host,
      port,
      username: "codex-mesh-host-key-probe",
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer) => { fingerprint = fingerprintHostKey(key); return false; },
    });
  });
}

export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function decodeUpload(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("dataBase64 must be valid base64");
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.length > 8 * 1024 * 1024) throw new Error("Upload must be between 1 byte and 8 MB");
  return data;
}

function safeSshError(error: Error): Error {
  const message = error.message.replaceAll(/(?:passphrase|private key|password)\s*[:=]\s*\S+/gi, "credential=<redacted>");
  return new Error(message);
}

function imageMimeType(extension: string): string | undefined {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" } as Record<string, string>)[extension];
}
