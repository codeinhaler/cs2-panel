import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Encrypts small secrets (GSLT tokens, passwords) at rest with AES-256-GCM. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) throw new Error("secret key must be 32 bytes");
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("malformed secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }

  sealOptional(plain: string | null | undefined): string | null {
    return plain ? this.seal(plain) : null;
  }

  openOptional(sealed: string | null | undefined): string | null {
    return sealed ? this.open(sealed) : null;
  }
}

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Random password using only characters that are safe inside CS2 cfg strings and launch args. */
export function randomPassword(length = 24): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
