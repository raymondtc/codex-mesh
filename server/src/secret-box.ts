import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CONTEXT = "codex-mesh:ssh-private-key:v1";

function encryptionKey(): Buffer {
  if (process.env.NODE_ENV === "production" && !process.env.SSH_KEY_ENCRYPTION_KEY) {
    throw new Error("SSH_KEY_ENCRYPTION_KEY is required in production");
  }
  const source = process.env.SSH_KEY_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!source || source.length < 32) {
    throw new Error("SSH_KEY_ENCRYPTION_KEY must be configured with at least 32 random characters");
  }
  return createHash("sha256").update(CONTEXT).update("\0").update(source).digest();
}

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret<T>(sealed: string): T {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted SSH credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(CONTEXT));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
