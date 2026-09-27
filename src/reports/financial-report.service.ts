import { BadRequestException, Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';

export interface FinancialReportFilters {
  method?: string;
  direction?: string;
  categoryId?: string;
}

const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

interface FinancialEntryRow {
  id: string;
  event_id: string;
  category_id: string;
  category_name_snapshot: string;
  direction: string;
  nature: string;
  amount_minor: string;
  currency: string;
  method: string;
  occurred_at_ms: unknown;
  notes: string | null;
  reference: string | null;
  user_id: string;
  device_id: string;
  created_at_server: unknown;
}

/**
 * Informe central de ingresos/gastos adicionales (contrato §8.2). Solo usa
 * proyecciones oficialmente aceptadas (evento `synced`), filtra por fecha
 * efectiva `[from_ms, to_ms)` y calcula totales con BigInt sobre el conjunto
 * filtrado. No altera `GET /reports/collections`.
 */
@Injectable()
export class FinancialReportService {
  constructor(private readonly db: DataSource) {}

  async report(from: number, to: number, filters: FinancialReportFilters = {}) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to <= from
    ) {
      throw new BadRequestException(
        'Período inválido: usa from_ms y to_ms exclusivos.',
      );
    }
    const method = this.optionalMethod(filters.method);
    const direction = this.optionalDirection(filters.direction);
    const categoryId = this.optionalCategoryId(filters.categoryId);

    const query = this.db
      .createQueryBuilder()
      .select([
        'f.id AS id',
        'f.created_event_id AS event_id',
        'f.category_id AS category_id',
        'f.category_name_snapshot AS category_name_snapshot',
        'f.direction AS direction',
        'f.nature AS nature',
        'f.amount_minor AS amount_minor',
        'f.currency AS currency',
        'f.method AS method',
        'f.occurred_at_ms AS occurred_at_ms',
        'f.notes AS notes',
        'f.reference AS reference',
        'e.user_id AS user_id',
        'e.device_id AS device_id',
        'e.created_at_server AS created_at_server',
      ])
      .from(FinancialEntryEntity, 'f')
      .innerJoin(EventEntity, 'e', 'e.event_id = f.created_event_id')
      .where('e.sync_status = :synced', { synced: EventSyncStatus.SYNCED })
      .andWhere('f.occurred_at_ms >= :fromMs', { fromMs: from })
      .andWhere('f.occurred_at_ms < :toMs', { toMs: to });

    const filtersToApply = new Brackets((qb) => {
      if (method) qb.andWhere('f.method = :method', { method });
      if (direction) qb.andWhere('f.direction = :direction', { direction });
      if (categoryId)
        qb.andWhere('f.category_id = :categoryId', { categoryId });
    });
    const hasFilters = Boolean(method || direction || categoryId);
    if (hasFilters) query.andWhere(filtersToApply);

    query.orderBy('f.occurred_at_ms', 'DESC').addOrderBy('f.id', 'ASC');
    const rows = (await query.getRawMany()) as unknown as FinancialEntryRow[];

    let income = 0n,
      expense = 0n,
      cash = 0n,
      transfer = 0n;
    const movements = rows.map((row) => {
      const amount = BigInt(row.amount_minor);
      if (row.direction === 'in') income += amount;
      else expense += amount;
      if (row.method === 'cash') cash += amount;
      else if (row.method === 'transfer') transfer += amount;
      else throw new Error('Método de registro financiero desconocido.');

      return {
        id: row.id,
        event_id: row.event_id,
        category_id: row.category_id,
        category_name_snapshot: row.category_name_snapshot,
        direction: row.direction,
        nature: row.nature,
        amount_minor: row.amount_minor,
        currency: row.currency,
        method: row.method,
        occurred_at_ms: this.toNumber(row.occurred_at_ms),
        notes: row.notes,
        reference: row.reference,
        user_id: row.user_id,
        device_id: row.device_id,
        created_at_server: this.toIso(row.created_at_server),
      };
    });

    return {
      from_ms: from,
      to_ms: to,
      currency: 'MXN',
      income_minor: income.toString(),
      expense_minor: expense.toString(),
      cash_minor: cash.toString(),
      transfer_minor: transfer.toString(),
      net_minor: (income - expense).toString(),
      movements,
    };
  }

  private optionalMethod(value: string | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value !== 'cash' && value !== 'transfer') {
      throw new BadRequestException('method debe ser cash o transfer.');
    }
    return value;
  }

  private optionalDirection(value: string | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value !== 'in' && value !== 'out') {
      throw new BadRequestException('direction debe ser in u out.');
    }
    return value;
  }

  private optionalCategoryId(value: string | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.trim(),
      )
    ) {
      throw new BadRequestException('category_id debe ser un UUID v4.');
    }
    return value.trim();
  }

  private toNumber(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_AMOUNT_MINOR) {
      throw new Error('occurred_at_ms fuera de rango seguro.');
    }
    return parsed;
  }

  private toIso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return new Date(value as string).toISOString();
  }
}
