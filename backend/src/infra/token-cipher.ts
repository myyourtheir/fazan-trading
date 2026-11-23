import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenCipher {
  private readonly key: Buffer;

  constructor(hexKey: string | undefined) {
    if (!hexKey || !/^[0-9a-f]{64}$/i.test(hexKey)) {
      throw new Error(
        'SANDBOX_TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hexadecimal characters.',
      );
    }
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(token: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  decrypt(encryptedToken: string) {
    const data = Buffer.from(encryptedToken, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
}
