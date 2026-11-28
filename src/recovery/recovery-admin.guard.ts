import type { Request } from 'express';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { sha256 } from './recovery-contract';
import { recoveryError } from './recovery-errors';
import {
  ADMIN_PASSWORD_HASH_KEY,
  ADMIN_LEGACY_HASH_KEY,
  acceptsAdminSecret,
  verifyAdminPasswordHash,
} from './recovery-admin-password';

/** Independent of business identities: also usable on an empty destination. */
@Injectable()
export class RecoveryAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private secret(authorization: string | undefined): string {
    if (typeof authorization !== 'string' || authorization.length > 1024)
      recoveryError(401, 'recovery_admin_unauthorized');
    // Legacy clients remain valid for an existing random token configuration.
    if (/^Bearer [0-9a-f]{64}$/.test(authorization))
      return authorization.slice(7);
    if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization))
      recoveryError(401, 'recovery_admin_unauthorized');
    const encoded = authorization.slice(6);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded)
      recoveryError(401, 'recovery_admin_unauthorized');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      recoveryError(401, 'recovery_admin_unauthorized');
    }
    if (!decoded.startsWith('admin:'))
      recoveryError(401, 'recovery_admin_unauthorized');
    const password = decoded.slice(6);
    if (!acceptsAdminSecret(password))
      recoveryError(401, 'recovery_admin_unauthorized');
    return password;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const passwordHash = this.config.get<string>(ADMIN_PASSWORD_HASH_KEY);
    const legacyHash = this.config.get<string>(ADMIN_LEGACY_HASH_KEY);
    // A configured password always wins, even if invalid: never fall back to an old secret.
    if (passwordHash !== undefined && passwordHash !== null) {
      if (!passwordHash.startsWith('$argon2id$v=19$'))
        recoveryError(503, 'recovery_admin_not_configured');
    } else if (!legacyHash || !/^[0-9a-f]{64}$/.test(legacyHash)) {
      recoveryError(503, 'recovery_admin_not_configured');
    }
    const secret = this.secret(
      context.switchToHttp().getRequest<Request>().headers.authorization,
    );
    if (passwordHash !== undefined && passwordHash !== null) {
      let matches: boolean;
      try {
        matches = await verifyAdminPasswordHash(passwordHash, secret);
      } catch {
        recoveryError(503, 'recovery_admin_not_configured');
      }
      if (!matches) recoveryError(401, 'recovery_admin_unauthorized');
    } else {
      if (
        !/^[0-9a-f]{64}$/.test(secret) ||
        !timingSafeEqual(
          Buffer.from(sha256(secret), 'hex'),
          Buffer.from(legacyHash!, 'hex'),
        )
      )
        recoveryError(401, 'recovery_admin_unauthorized');
    }
    return true;
  }
}
