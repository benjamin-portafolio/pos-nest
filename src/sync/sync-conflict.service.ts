import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantRole } from '../enums/sync-conflict-participant-role.enum';
import { SyncConflictStatus } from '../enums/sync-conflict-status.enum';

export interface RecordSyncConflictOptions {
  conflictType: string;
  refType: string;
  refId: string;
  reason: string;
  losingEvent: EventEntity;
  defaultWinnerEventId?: string | null;
}

@Injectable()
export class SyncConflictService {
  async recordConflict(
    manager: EntityManager,
    options: RecordSyncConflictOptions,
  ): Promise<SyncConflictEntity> {
    const conflict = await this.findOrCreateConflict(manager, options);

    if (conflict.defaultWinnerEventId) {
      const winner = await manager.findOneBy(EventEntity, {
        eventId: conflict.defaultWinnerEventId,
      });

      if (winner) {
        await this.addParticipantIfMissing(
          manager,
          conflict,
          winner,
          SyncConflictParticipantRole.DEFAULT_WINNER,
          null,
        );
      }
    }

    await this.addParticipantIfMissing(
      manager,
      conflict,
      options.losingEvent,
      SyncConflictParticipantRole.CONTENDER,
      options.reason,
    );

    return conflict;
  }

  private async findOrCreateConflict(
    manager: EntityManager,
    options: RecordSyncConflictOptions,
  ): Promise<SyncConflictEntity> {
    const existing = await manager.findOne(SyncConflictEntity, {
      where: {
        conflictType: options.conflictType,
        refType: options.refType,
        refId: options.refId,
        status: In([SyncConflictStatus.OPEN, SyncConflictStatus.ACKNOWLEDGED]),
      },
      order: { createdAtServer: 'ASC' },
    });

    if (existing) return existing;

    return manager.save(
      manager.create(SyncConflictEntity, {
        conflictType: options.conflictType,
        refType: options.refType,
        refId: options.refId,
        status: SyncConflictStatus.OPEN,
        defaultWinnerEventId: options.defaultWinnerEventId ?? null,
        resolutionEventId: null,
        reason: options.reason,
      }),
    );
  }

  private async addParticipantIfMissing(
    manager: EntityManager,
    conflict: SyncConflictEntity,
    event: EventEntity,
    role: SyncConflictParticipantRole,
    reason: string | null,
  ): Promise<void> {
    const existing = await manager.findOneBy(SyncConflictParticipantEntity, {
      conflictId: conflict.conflictId,
      eventId: event.eventId,
    });

    if (existing) return;

    try {
      await manager.save(
        manager.create(SyncConflictParticipantEntity, {
          conflictId: conflict.conflictId,
          eventId: event.eventId,
          participantRole: role,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          syncStatus: event.syncStatus,
          serverSequence: event.serverSequence,
          reason,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    return 'code' in error && error.code === '23505';
  }
}
