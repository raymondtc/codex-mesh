import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db/database.js";
import { auditEvents, conversations, machines, tenantMembers, tenants, user } from "./db/schema.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";

const queryDb = db as any;

export interface MachineRecord {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  kind: string;
  codexVersion: string | null;
  capabilities: string[];
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUsername: string | null;
  sshPublicKey: string | null;
  sshHostKeySha256: string | null;
  sshCodexCommand: string | null;
  connectionMode: string;
  tunnelPublicKey: string | null;
}

export interface SshCredentialRecord extends MachineRecord {
  credential: { privateKey: string; passphrase?: string };
}

export interface CreateSshHostInput {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  publicKey?: string;
  hostKeySha256: string;
  codexCommand: string;
}

export interface UserSettings {
  defaultPermission: "read-only" | "workspace-write" | "full-access";
  defaultModel: string | null;
  defaultReasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

export interface ConversationMetadata {
  kind: "standard" | "side" | "fork" | "worktree";
  parentRemoteThreadId?: string | null;
  mainRoot?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
}

export async function ensureFirstUserAdmin(userId: string): Promise<void> {
  await queryDb.execute(sql`update "user" set "role" = 'admin' where "id" = ${userId} and not exists (select 1 from "user" where "role" = 'admin')`);
}

export async function ensurePersonalTenant(userId: string): Promise<string> {
  const [membership] = await queryDb.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).where(eq(tenantMembers.userId, userId)).orderBy(tenantMembers.createdAt).limit(1);
  if (membership) return membership.tenantId;
  const [account] = await queryDb.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) throw new Error("User not found");
  const slug = `personal-${userId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 120);
  const [tenant] = await queryDb.insert(tenants).values({ name: `${account.name || "Personal"}`, slug }).onConflictDoUpdate({ target: tenants.slug, set: { updatedAt: new Date() } }).returning({ id: tenants.id });
  await queryDb.insert(tenantMembers).values({ tenantId: tenant.id, userId, role: "owner" }).onConflictDoNothing();
  return tenant.id;
}

export async function listUsers(): Promise<Array<{ id: string; name: string; email: string; role: string; banned: boolean; banReason: string | null; createdAt: Date }>> {
  return queryDb.select({ id: user.id, name: user.name, email: user.email, role: user.role, banned: user.banned, banReason: user.banReason, createdAt: user.createdAt }).from(user).orderBy(user.createdAt);
}

export async function getUserRole(userId: string): Promise<string | null> {
  const [record] = await queryDb.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  return record?.role ?? null;
}

export async function updateUserRole(userId: string, role: "admin" | "user"): Promise<boolean> {
  const rows = await queryDb.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, userId)).returning({ id: user.id });
  return rows.length > 0;
}

export async function getUserSettings(userId: string): Promise<UserSettings | null> {
  const [record] = await queryDb.select({
    defaultPermission: user.defaultPermission,
    defaultModel: user.defaultModel,
    defaultReasoningEffort: user.defaultReasoningEffort,
  }).from(user).where(eq(user.id, userId)).limit(1);
  return record as UserSettings | undefined ?? null;
}

export async function updateUserSettings(userId: string, settings: UserSettings): Promise<UserSettings | null> {
  const [record] = await queryDb.update(user).set({ ...settings, updatedAt: new Date() }).where(eq(user.id, userId)).returning({
    defaultPermission: user.defaultPermission,
    defaultModel: user.defaultModel,
    defaultReasoningEffort: user.defaultReasoningEffort,
  });
  return record as UserSettings | undefined ?? null;
}

export async function ensureLocalMachine(userId: string): Promise<MachineRecord | null> {
  const tenantId = await ensurePersonalTenant(userId);
  const [existing] = await queryDb.select().from(machines).where(eq(machines.kind, "local")).limit(1);
  if (existing) return existing.ownerUserId === userId && !existing.revokedAt ? existing : null;
  const [created] = await queryDb.insert(machines).values({ tenantId, ownerUserId: userId, name: "本机 Codex", kind: "local", capabilities: ["local-app-server", "file-preview"] }).returning();
  return created;
}

export async function listMachines(userId: string): Promise<MachineRecord[]> {
  await ensurePersonalTenant(userId);
  return queryDb.select(machinePublicColumns).from(machines).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, machines.tenantId), eq(tenantMembers.userId, userId))).where(isNull(machines.revokedAt)).orderBy(machines.createdAt);
}

export async function createSshHost(userId: string, input: CreateSshHostInput): Promise<MachineRecord> {
  const tenantId = await ensurePersonalTenant(userId);
  const [machine] = await queryDb.insert(machines).values({
    tenantId,
    ownerUserId: userId,
    name: input.name,
    kind: "ssh",
    capabilities: ["ssh", "codex-app-server"],
    sshHost: input.host,
    sshPort: input.port,
    sshUsername: input.username,
    sshPrivateKeyEncrypted: encryptSecret({ privateKey: input.privateKey, ...(input.passphrase ? { passphrase: input.passphrase } : {}) }),
    sshPublicKey: input.publicKey ?? null,
    sshHostKeySha256: input.hostKeySha256,
    sshCodexCommand: input.codexCommand,
  }).returning(machinePublicColumns);
  await recordAudit({ userId, machineId: machine.id, action: "ssh_host.created", metadata: { host: input.host, port: input.port, username: input.username, hostKeySha256: input.hostKeySha256 } });
  return machine;
}

export async function getSshHost(userId: string, machineId: string): Promise<SshCredentialRecord | null> {
  const [row] = await queryDb.select({ machine: machines }).from(machines).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, machines.tenantId), eq(tenantMembers.userId, userId))).where(and(eq(machines.id, machineId), eq(machines.kind, "ssh"), isNull(machines.revokedAt))).limit(1);
  const machine = row?.machine;
  if (!machine?.sshPrivateKeyEncrypted) return null;
  return { ...machine, credential: decryptSecret<{ privateKey: string; passphrase?: string }>(machine.sshPrivateKeyEncrypted) } as SshCredentialRecord;
}

export async function updateMachinePresence(machineId: string, details: { codexVersion?: string; capabilities?: string[] } = {}): Promise<void> {
  await queryDb.update(machines).set({ ...details, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(machines.id, machineId));
}

export async function enableMachineTunnel(userId: string, machineId: string, publicKey: string): Promise<boolean> {
  if (!await machineBelongsToUser(machineId, userId)) return false;
  const rows = await queryDb.update(machines).set({ connectionMode: "reverse-ssh", tunnelPublicKey: publicKey, updatedAt: new Date() }).where(and(eq(machines.id, machineId), eq(machines.kind, "ssh"), isNull(machines.revokedAt))).returning({ id: machines.id });
  if (rows.length) await recordAudit({ userId, machineId, action: "ssh_tunnel.enabled" });
  return rows.length > 0;
}

export async function disableMachineTunnel(userId: string, machineId: string): Promise<boolean> {
  if (!await machineBelongsToUser(machineId, userId)) return false;
  const rows = await queryDb.update(machines).set({ connectionMode: "direct", tunnelPublicKey: null, updatedAt: new Date() }).where(eq(machines.id, machineId)).returning({ id: machines.id });
  if (rows.length) await recordAudit({ userId, machineId, action: "ssh_tunnel.disabled" });
  return rows.length > 0;
}

export async function getTunnelMachine(machineId: string): Promise<Pick<MachineRecord, "id" | "tenantId" | "tunnelPublicKey" | "revokedAt"> | null> {
  const [machine] = await queryDb.select({ id: machines.id, tenantId: machines.tenantId, tunnelPublicKey: machines.tunnelPublicKey, revokedAt: machines.revokedAt }).from(machines).where(and(eq(machines.id, machineId), eq(machines.connectionMode, "reverse-ssh"), isNull(machines.revokedAt))).limit(1);
  return machine ?? null;
}

export async function revokeMachine(userId: string, machineId: string): Promise<boolean> {
  if (!await machineBelongsToUser(machineId, userId)) return false;
  const rows = await queryDb.update(machines).set({ revokedAt: new Date(), sshPrivateKeyEncrypted: null, tunnelPublicKey: null, updatedAt: new Date() }).where(eq(machines.id, machineId)).returning({ id: machines.id });
  if (rows.length) await recordAudit({ userId, machineId, action: "machine.revoked" });
  return rows.length > 0;
}

export async function machineBelongsToUser(machineId: string, userId: string): Promise<boolean> {
  const [machine] = await queryDb.select({ id: machines.id }).from(machines).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, machines.tenantId), eq(tenantMembers.userId, userId))).where(and(eq(machines.id, machineId), isNull(machines.revokedAt))).limit(1);
  return Boolean(machine);
}

export async function upsertConversation(userId: string, machineId: string, thread: Record<string, unknown>, metadata?: ConversationMetadata): Promise<Record<string, unknown>> {
  if (typeof thread.id !== "string") return thread;
  const [machine] = await queryDb.select({ tenantId: machines.tenantId }).from(machines).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, machines.tenantId), eq(tenantMembers.userId, userId))).where(eq(machines.id, machineId)).limit(1);
  if (!machine) throw new Error("Machine not found");
  const effectiveMetadata = metadata ?? (typeof thread.name === "string" && thread.name.endsWith(" · 侧聊") ? { kind: "side" as const } : undefined);
  const [conversation] = await queryDb.insert(conversations).values({
    tenantId: machine.tenantId,
    ownerUserId: userId,
    machineId,
    remoteThreadId: thread.id,
    remoteProjectId: typeof thread.projectId === "string" ? thread.projectId : null,
    title: typeof thread.name === "string" ? thread.name : typeof thread.preview === "string" ? thread.preview : null,
    ...(effectiveMetadata ?? {}),
  }).onConflictDoUpdate({
    target: [conversations.machineId, conversations.remoteThreadId],
    set: {
      ownerUserId: userId,
      remoteProjectId: typeof thread.projectId === "string" ? thread.projectId : null,
      title: typeof thread.name === "string" ? thread.name : typeof thread.preview === "string" ? thread.preview : null,
      updatedAt: new Date(),
      ...(effectiveMetadata ?? {}),
    },
  }).returning();
  return { ...thread, meshId: conversation.id, machineId, conversationKind: conversation.kind, parentRemoteThreadId: conversation.parentRemoteThreadId, mainRoot: conversation.mainRoot, worktreePath: conversation.worktreePath, branch: conversation.branch };
}

export async function updateConversationMetadata(userId: string, machineId: string, remoteThreadId: string, metadata: ConversationMetadata): Promise<boolean> {
  const rows = await queryDb.update(conversations).set({ ...metadata, updatedAt: new Date() }).where(and(eq(conversations.ownerUserId, userId), eq(conversations.machineId, machineId), eq(conversations.remoteThreadId, remoteThreadId))).returning({ id: conversations.id });
  return rows.length > 0;
}

export async function deleteConversation(userId: string, machineId: string, remoteThreadId: string): Promise<void> {
  await queryDb.delete(conversations).where(and(eq(conversations.ownerUserId, userId), eq(conversations.machineId, machineId), eq(conversations.remoteThreadId, remoteThreadId)));
}

export async function resolveConversation(userId: string, conversationId: string): Promise<{ machineId: string; remoteThreadId: string } | null> {
  const [conversation] = await queryDb.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.ownerUserId, userId))).limit(1);
  return conversation ? { machineId: conversation.machineId, remoteThreadId: conversation.remoteThreadId } : null;
}

export async function recordAudit(input: { userId?: string; machineId?: string; conversationId?: string; action: string; metadata?: Record<string, unknown> }): Promise<void> {
  let tenantId: string | undefined;
  if (input.machineId) {
    const [machine] = await queryDb.select({ tenantId: machines.tenantId }).from(machines).where(eq(machines.id, input.machineId)).limit(1);
    tenantId = machine?.tenantId;
  } else if (input.userId) tenantId = await ensurePersonalTenant(input.userId);
  await queryDb.insert(auditEvents).values({ ...input, tenantId, metadata: input.metadata ?? {} });
}

const machinePublicColumns = {
  id: machines.id,
  tenantId: machines.tenantId,
  ownerUserId: machines.ownerUserId,
  name: machines.name,
  kind: machines.kind,
  codexVersion: machines.codexVersion,
  capabilities: machines.capabilities,
  lastSeenAt: machines.lastSeenAt,
  revokedAt: machines.revokedAt,
  sshHost: machines.sshHost,
  sshPort: machines.sshPort,
  sshUsername: machines.sshUsername,
  sshPublicKey: machines.sshPublicKey,
  sshHostKeySha256: machines.sshHostKeySha256,
  sshCodexCommand: machines.sshCodexCommand,
  connectionMode: machines.connectionMode,
  tunnelPublicKey: machines.tunnelPublicKey,
};
