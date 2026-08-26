import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import ssh2, { type Connection, type PublicKeyAuthContext, type Server as SshServer } from "ssh2";
import { getTunnelMachine } from "./repository.js";

interface OnlineTunnel {
  machineId: string;
  tenantId: string;
  connection: Connection;
  bindAddress: string;
  bindPort: number;
  activeStreams: number;
}

export interface ReverseSshRelayOptions {
  host: string;
  port: number;
  hostKeyPath?: string;
  publicHost?: string;
  maxStreamsPerMachine?: number;
}

/**
 * SSH reverse-forward relay. It never binds the requested remote forward to a
 * TCP listener. Instead, authenticated control-plane calls open an SSH channel
 * directly, so tunnel endpoints cannot be scanned or reached from the network.
 */
export class ReverseSshRelay {
  private readonly server: SshServer;
  private readonly tunnels = new Map<string, OnlineTunnel>();
  private readonly hostPrivateKey: string;
  readonly hostPublicKey: string;
  readonly hostKeySha256: string;

  constructor(private readonly options: ReverseSshRelayOptions) {
    const { Server, utils } = ssh2;
    this.hostPrivateKey = options.hostKeyPath
      ? readFileSync(options.hostKeyPath, "utf8")
      : generatedHostKey();
    const parsed = utils.parseKey(this.hostPrivateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("RELAY_HOST_KEY_PATH must contain one valid OpenSSH private key");
    this.hostPublicKey = `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
    this.hostKeySha256 = fingerprint(parsed.getPublicSSH());
    this.server = new Server({ hostKeys: [this.hostPrivateKey], ident: "SSH-2.0-CodexMeshRelay" });
    this.server.on("connection", (connection, info) => this.handleConnection(connection, info.ip));
    this.server.on("error", (error: Error) => console.error(`[relay] ${error.message}`));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        console.log(`Reverse SSH relay listening on ${this.options.host}:${this.options.port}; host key ${this.hostKeySha256}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const tunnel of this.tunnels.values()) tunnel.connection.end();
    this.tunnels.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  isOnline(machineId: string): boolean { return this.tunnels.has(machineId); }

  openStream(machineId: string): Promise<Duplex> {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return Promise.reject(new Error("Reverse SSH tunnel is offline"));
    const maximum = this.options.maxStreamsPerMachine ?? 8;
    if (tunnel.activeStreams >= maximum) return Promise.reject(new Error("Reverse SSH tunnel connection limit reached"));
    tunnel.activeStreams += 1;
    return new Promise((resolve, reject) => {
      tunnel.connection.forwardOut(tunnel.bindAddress, tunnel.bindPort, "127.0.0.1", 0, (error, stream) => {
        if (error) {
          tunnel.activeStreams -= 1;
          reject(new Error(`Reverse SSH channel failed: ${error.message}`));
          return;
        }
        let released = false;
        const release = () => { if (!released) { released = true; tunnel.activeStreams -= 1; } };
        stream.once("close", release);
        stream.once("error", release);
        resolve(stream);
      });
    });
  }

  private handleConnection(connection: Connection, sourceIp: string): void {
    let authenticated: { machineId: string; tenantId: string } | undefined;
    connection.on("error", () => {
      if (authenticated) this.remove(authenticated.machineId, connection);
    });
    connection.on("authentication", (context) => {
      if (context.method !== "publickey" || !isMachineId(context.username)) return context.reject(["publickey"]);
      void this.authenticate(context.username, context).then((identity) => {
        if (!identity) return context.reject(["publickey"]);
        authenticated = identity;
        context.accept();
      }).catch(() => context.reject(["publickey"]));
    });
    connection.on("ready", () => {
      if (!authenticated) return connection.end();
      const identity = authenticated;
      connection.on("session", (_accept, reject) => reject());
      connection.on("tcpip", (_accept, reject) => reject());
      connection.on("request", (accept, reject, name, info) => {
        if (name === "cancel-tcpip-forward") {
          this.remove(identity.machineId, connection);
          return accept?.();
        }
        if (name !== "tcpip-forward" || (info.bindAddr !== "127.0.0.1" && info.bindAddr !== "localhost") || info.bindPort !== 0) return reject?.();
        const existing = this.tunnels.get(identity.machineId);
        if (existing && existing.connection !== connection) existing.connection.end();
        const bindPort = assignedVirtualPort(identity.machineId);
        this.tunnels.set(identity.machineId, { ...identity, connection, bindAddress: info.bindAddr, bindPort, activeStreams: 0 });
        console.log(`[relay] machine=${identity.machineId} tenant=${identity.tenantId} connected from ${sourceIp}`);
        accept?.(bindPort);
      });
      connection.on("close", () => this.remove(identity.machineId, connection));
    });
  }

  private async authenticate(machineId: string, context: PublicKeyAuthContext): Promise<{ machineId: string; tenantId: string } | null> {
    const { utils } = ssh2;
    const machine = await getTunnelMachine(machineId);
    if (!machine?.tunnelPublicKey) return null;
    const parsed = utils.parseKey(machine.tunnelPublicKey);
    if (parsed instanceof Error || Array.isArray(parsed)) return null;
    const expected = parsed.getPublicSSH();
    if (expected.length !== context.key.data.length || !timingSafeEqual(expected, context.key.data)) return null;
    if (context.signature && (!context.blob || parsed.verify(context.blob, context.signature, context.hashAlgo) !== true)) return null;
    return { machineId, tenantId: machine.tenantId };
  }

  private remove(machineId: string, connection: Connection): void {
    if (this.tunnels.get(machineId)?.connection === connection) {
      this.tunnels.delete(machineId);
      console.log(`[relay] machine=${machineId} disconnected`);
    }
  }
}

function generatedHostKey(): string {
  if (process.env.NODE_ENV === "production") throw new Error("RELAY_HOST_KEY_PATH is required when the reverse SSH relay is enabled in production");
  return ssh2.utils.generateKeyPairSync("ed25519", { comment: "codex-mesh-relay" }).private;
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function assignedVirtualPort(machineId: string): number {
  return 20_000 + (createHash("sha256").update(machineId).digest().readUInt16BE(0) % 40_000);
}

function isMachineId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
