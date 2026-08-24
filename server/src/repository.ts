import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db/database.js";
import { auditEvents, conversations, machineEnrollments, machines, user } from "./db/schema.js";

const queryDb = db as any;

export interface MachineRecord {
  id: string;
  ownerUserId: string;
  name: string;
  kind: string;
  agentVersion: string | null;
  codexVersion: string | null;
  capabilities: string[];
  lastSeenAt: Date | null;
  revokedAt: Date | null;
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
  const [existing] = await queryDb.select().from(machines).where(eq(machines.kind, "local")).limit(1);
  if (existing) return existing.ownerUserId === userId && !existing.revokedAt ? existing : null;
  const [created] = await queryDb.insert(machines).values({ ownerUserId: userId, name: "本机 Codex", kind: "local", capabilities: ["local-app-server", "file-preview"] }).returning();
  return created;
}

export async function listMachines(userId: string): Promise<MachineRecord[]> {
  return queryDb.select().from(machines).where(and(eq(machines.ownerUserId, userId), isNull(machines.revokedAt))).orderBy(machines.createdAt);
}

export async function createMachineEnrollment(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = formatEnrollmentCode(randomBytes(9).toString("base64url").toUpperCase());
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await queryDb.insert(machineEnrollments).values({ userId, codeHash: digest(normalizeEnrollmentCode(code)), expiresAt });
  await recordAudit({ userId, action: "machine.enrollment.created" });
  return { code, expiresAt };
}

export async function redeemMachineEnrollment(code: string, name: string): Promise<{ machine: MachineRecord; credential: string }> {
  const codeHash = digest(normalizeEnrollmentCode(code));
  const result = await queryDb.transaction(async (tx: any) => {
    const [enrollment] = await tx.select().from(machineEnrollments).where(and(eq(machineEnrollments.codeHash, codeHash), isNull(machineEnrollments.usedAt))).for("update").limit(1);
    if (!enrollment || enrollment.expiresAt.getTime() <= Date.now()) throw new Error("配对码无效或已过期");
    const credential = randomBytes(32).toString("base64url");
    const [machine] = await tx.insert(machines).values({
      ownerUserId: enrollment.userId,
      name: name.trim() || "Codex Machine",
      credentialHash: digest(credential),
      kind: "agent",
      capabilities: [],
    }).returning();
    await tx.update(machineEnrollments).set({ usedAt: new Date() }).where(eq(machineEnrollments.id, enrollment.id));
    await tx.insert(auditEvents).values({ userId: enrollment.userId, machineId: machine.id, action: "machine.paired" });
    return { machine, credential };
  });
  return result;
}

export async function authenticateMachine(machineId: string, credential: string): Promise<MachineRecord | null> {
  const [machine] = await queryDb.select().from(machines).where(and(eq(machines.id, machineId), isNull(machines.revokedAt))).limit(1);
  if (!machine?.credentialHash) return null;
  const actual = Buffer.from(digest(credential));
  const expected = Buffer.from(machine.credentialHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? machine : null;
}

export async function updateMachinePresence(machineId: string, details: { agentVersion?: string; codexVersion?: string; capabilities?: string[] } = {}): Promise<void> {
  await queryDb.update(machines).set({ ...details, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(machines.id, machineId));
}

export async function revokeMachine(userId: string, machineId: string): Promise<boolean> {
  const rows = await queryDb.update(machines).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(machines.id, machineId), eq(machines.ownerUserId, userId), eq(machines.kind, "agent"))).returning({ id: machines.id });
  if (rows.length) await recordAudit({ userId, machineId, action: "machine.revoked" });
  return rows.length > 0;
}

export async function machineBelongsToUser(machineId: string, userId: string): Promise<boolean> {
  const [machine] = await queryDb.select({ id: machines.id }).from(machines).where(and(eq(machines.id, machineId), eq(machines.ownerUserId, userId), isNull(machines.revokedAt))).limit(1);
  return Boolean(machine);
}

export async function upsertConversation(userId: string, machineId: string, thread: Record<string, unknown>, metadata?: ConversationMetadata): Promise<Record<string, unknown>> {
  if (typeof thread.id !== "string") return thread;
  const effectiveMetadata = metadata ?? (typeof thread.name === "string" && thread.name.endsWith(" · 侧聊") ? { kind: "side" as const } : undefined);
  const [conversation] = await queryDb.insert(conversations).values({
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
  await queryDb.insert(auditEvents).values({ ...input, metadata: input.metadata ?? {} });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEnrollmentCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function formatEnrollmentCode(value: string): string {
  return value.match(/.{1,4}/g)?.join("-") ?? value;
}
