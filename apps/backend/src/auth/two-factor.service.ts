import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';

import { PrismaService } from '../prisma/prisma.service';

export interface TwoFactorSetupResult {
  otpauthUrl: string;
  secret: string;
}

export interface TwoFactorConfirmationResult {
  recoveryCodes: string[];
}

export interface TwoFactorVerificationResult {
  usingRecoveryCode: boolean;
}

type VerificationKind = 'totp' | 'recovery';

@Injectable()
export class TwoFactorService {
  private readonly issuer = process.env.TWO_FACTOR_ISSUER ?? 'AntiHunter Command Center';
  private readonly window = Number.parseInt(process.env.TWO_FACTOR_WINDOW ?? '1', 10);
  private readonly cryptoKey = this.deriveCryptoKey(process.env.TWO_FACTOR_SECRET_KEY ?? '');

  constructor(private readonly prisma: PrismaService) {
    authenticator.options = {
      window: this.window,
    };
  }

  async generateSecret(userId: string, email: string): Promise<TwoFactorSetupResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true },
    });

    if (user?.twoFactorEnabled) {
      throw new BadRequestException('TWO_FACTOR_ALREADY_ENABLED');
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(email, this.issuer, secret);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorTempSecret: secret,
      },
    });

    return { secret, otpauthUrl };
  }

  async confirmTwoFactor(userId: string, code: string): Promise<TwoFactorConfirmationResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorTempSecret: true,
      },
    });
    if (!user?.twoFactorTempSecret) {
      throw new BadRequestException('TWO_FACTOR_SETUP_REQUIRED');
    }

    const normalizedCode = this.normaliseCode(code);
    const isValid = this.isTotpValid(user.twoFactorTempSecret, normalizedCode);
    if (!isValid) {
      throw new BadRequestException('INVALID_TWO_FACTOR_CODE');
    }

    const recoveryCodes = this.generateRecoveryCodes();
    const hashedCodes = await Promise.all(recoveryCodes.map((value) => argon2.hash(value)));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: this.encryptSecret(user.twoFactorTempSecret),
        twoFactorTempSecret: null,
        twoFactorEnabled: true,
        twoFactorEnabledAt: new Date(),
        twoFactorRecoveryCodes: hashedCodes,
      },
    });

    return { recoveryCodes };
  }

  async disableTwoFactor(
    userId: string,
    options: { code?: string; password?: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        twoFactorSecret: true,
        twoFactorEnabled: true,
        twoFactorRecoveryCodes: true,
      },
    });

    if (!user) {
      throw new BadRequestException('ACCOUNT_NOT_FOUND');
    }

    if (!user.twoFactorEnabled) {
      throw new BadRequestException('TWO_FACTOR_NOT_ENABLED');
    }

    let verification: VerificationKind | null = null;
    if (options.code && user.twoFactorSecret) {
      const normalizedCode = this.normaliseCode(options.code);
      verification = await this.checkCode(
        userId,
        normalizedCode,
        user.twoFactorSecret,
        user.twoFactorRecoveryCodes,
        true,
      );
    }

    if (!verification && options.password) {
      const passwordValid = await argon2.verify(user.passwordHash, options.password);
      if (!passwordValid) {
        // fallthrough
      } else {
        verification = 'totp';
      }
    }

    if (!verification) {
      throw new BadRequestException('INVALID_TWO_FACTOR_CHALLENGE');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: null,
        twoFactorTempSecret: null,
        twoFactorRecoveryCodes: [],
        twoFactorEnabled: false,
        twoFactorEnabledAt: null,
      },
    });
  }

  async regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    const verification = await this.verifyLoginCode(userId, this.normaliseCode(code));
    if (verification.usingRecoveryCode) {
      throw new BadRequestException('RECOVERY_CODES_REQUIRE_TOTP');
    }

    const recoveryCodes = this.generateRecoveryCodes();
    const hashedCodes = await Promise.all(recoveryCodes.map((value) => argon2.hash(value)));
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorRecoveryCodes: hashedCodes,
      },
    });
    return recoveryCodes;
  }

  async verifyLoginCode(userId: string, code: string): Promise<TwoFactorVerificationResult> {
    const normalized = this.normaliseCode(code);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorSecret: true,
        twoFactorEnabled: true,
        twoFactorRecoveryCodes: true,
      },
    });
    if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('TWO_FACTOR_NOT_ENABLED');
    }

    const verification = await this.checkCode(
      userId,
      normalized,
      user.twoFactorSecret,
      user.twoFactorRecoveryCodes,
      true,
    );
    if (!verification) {
      throw new BadRequestException('INVALID_TWO_FACTOR_CODE');
    }

    return { usingRecoveryCode: verification === 'recovery' };
  }

  private async checkCode(
    userId: string,
    code: string,
    encryptedSecret: string,
    recoveryHashes: string[] | undefined,
    consumeRecovery: boolean,
  ): Promise<VerificationKind | null> {
    const normalized = this.normaliseCode(code);
    const secret = this.decryptSecret(encryptedSecret);
    if (this.isTotpValid(secret, normalized)) {
      return 'totp';
    }

    const hashes =
      recoveryHashes ??
      (
        await this.prisma.user.findUnique({
          where: { id: userId },
          select: { twoFactorRecoveryCodes: true },
        })
      )?.twoFactorRecoveryCodes ??
      [];

    const matchingIndex = await this.findMatchingRecoveryCodeIndex(hashes, normalized);
    if (matchingIndex === -1) {
      return null;
    }

    if (consumeRecovery) {
      const updatedCodes = hashes.filter((_, idx) => idx !== matchingIndex);
      await this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorRecoveryCodes: updatedCodes },
      });
    }

    return 'recovery';
  }

  private isTotpValid(secret: string, normalizedCode: string): boolean {
    if (!secret || !normalizedCode) {
      return false;
    }
    if (authenticator.check(normalizedCode, secret)) {
      return true;
    }
    const relaxedWindow = Math.max(this.window, 1) + 1;
    const originalOptions = authenticator.options;
    authenticator.options = { ...originalOptions, window: relaxedWindow };
    const result = authenticator.check(normalizedCode, secret);
    authenticator.options = { ...originalOptions, window: this.window };
    return result;
  }

  private async findMatchingRecoveryCodeIndex(hashes: string[], code: string): Promise<number> {
    for (let index = 0; index < hashes.length; index += 1) {
      const hash = hashes[index];
      if (await argon2.verify(hash, code)) {
        return index;
      }
    }
    return -1;
  }

  private generateRecoveryCodes(): string[] {
    return Array.from({ length: 10 }, () => this.createRecoveryCode());
  }

  private createRecoveryCode(): string {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  }

  private normaliseCode(code: string): string {
    return code.replace(/\s+/g, '').toUpperCase();
  }

  private deriveCryptoKey(rawKey: string): Buffer | null {
    if (!rawKey) {
      return null;
    }
    const key = crypto.createHash('sha256').update(rawKey, 'utf8').digest();
    return key;
  }

  private encryptSecret(secret: string): string {
    if (!this.cryptoKey) {
      return secret;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.cryptoKey, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  private decryptSecret(secret: string): string {
    if (!this.cryptoKey) {
      return secret;
    }
    try {
      const buffer = Buffer.from(secret, 'base64');
      if (buffer.length < 28) {
        return secret;
      }
      const iv = buffer.subarray(0, 12);
      const authTag = buffer.subarray(12, 28);
      const payload = buffer.subarray(28);

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.cryptoKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (error) {
      return secret;
    }
  }
}
