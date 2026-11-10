import { SyncController } from '../sync/sync.controller';
import { CollectionsReportController } from '../reports/collections-report.controller';
import { FinancialReportController } from '../reports/financial-report.controller';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { lastValueFrom, from } from 'rxjs';
import { ServerStateService } from './server-state.service';
import { recoveryError } from './recovery-errors';
@Injectable()
export class ServerStateInterceptor implements NestInterceptor {
  constructor(private readonly state: ServerStateService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const controller = context.getClass();
    const handler = context.getHandler();
    if (
      ![
        SyncController,
        CollectionsReportController,
        FinancialReportController,
      ].includes(controller as any) ||
      handler === SyncController.prototype.health
    )
      return next.handle();
    const isPull = handler === SyncController.prototype.pullEvents;
    const isPreflight = handler === SyncController.prototype.preflightEvents;
    const h = req.headers;
    return from(
      this.state.business(
        {
          protocol: h['x-pos-protocol'],
          server: h['x-pos-server'],
          generation: h['x-pos-generation'],
          token: h.authorization?.replace(/^Bearer /, ''),
          device: h['x-pos-device'],
        },
        async (s, b, m) => {
          if (
            req.body?.device_id !== undefined &&
            req.body.device_id !== b.device_id
          )
            recoveryError(403, 'binding_device_mismatch');
          const cursor = isPull
            ? req.query.since
            : isPreflight
              ? req.body?.last_full_pull_server_sequence
              : undefined;
          if (isPull || isPreflight) {
            if (!/^(0|[1-9][0-9]*)$/.test(String(cursor)))
              recoveryError(400, 'invalid_cursor');
            const [r] = await m.query(
              "SELECT GREATEST($1::bigint,coalesce(max(server_sequence),0))::text AS watermark FROM events WHERE sync_status='synced'",
              [s.baseline_high_watermark],
            );
            if (
              BigInt(cursor) < BigInt(s.baseline_high_watermark) ||
              BigInt(cursor) > BigInt(r.watermark)
            )
              recoveryError(409, 'bootstrap_required');
          }
          // Holds singleton SHARE through all nested transactions, reads and post-commit notification.
          return lastValueFrom(next.handle());
        },
      ),
    );
  }
}
