import crypto from "node:crypto";
import Config from "./config";

const ALGORITHM = "aes-256-ctr";
const KEY_LENGTH = 32; // 32 bytes for AES-256
const IV_LENGTH = 16; // 16 bytes for AES
const SALT_LENGTH = 32; // 32 bytes for salt

function deriveKey(password: string, salt: Buffer): Buffer {
  // Use scryptSync for key derivation - more secure than pbkdf2
  return crypto.scryptSync(password, salt, KEY_LENGTH);
}

function encrypt(text: string | null): string {
  if (!text) {
    return "";
  }

  const password = Config.encryptionPassword;

  // Generate random salt and IV for each encryption
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key from password and salt
  const key = deriveKey(password, salt);

  // Create cipher with derived key and IV
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  // Prepend salt and IV to encrypted data (all in hex)
  return salt.toString("hex") + iv.toString("hex") + encrypted;
}

export { encrypt };
