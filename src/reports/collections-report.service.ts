import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { CustomerPaymentEntity } from '../entities/customer-payment.entity';
import { SaleEntity } from '../entities/sale.entity';
import { ClienteEntity } from '../entities/cliente.entity';
import { EventEntity } from '../entities/event.entity';
import { CollectionMovement } from './collection-movement';

@Injectable()
export class CollectionsReportService {
  constructor(private readonly db: DataSource) {}
  /** Intervalo [from, to) en milisegundos UTC. Solo dinero proyectado en servidor. */
  async report(from: number, to: number) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to <= from
    )
      throw new BadRequestException(
        'Período inválido: usa from_ms y to_ms exclusivos.',
      );
    const direct = this.db
      .createQueryBuilder()
      .select([
        'p.payment_id AS id',
        'p.created_event_id AS event_id',
        'p.amount_minor AS amount_minor',
        'p.method AS method',
        'p.reference AS reference',
        '(extract(epoch FROM e.created_at_local) * 1000)::bigint AS occurred_at_ms',
        "'sale' AS origin",
        'p.sale_id AS sale_id',
        's.cliente_id AS cliente_id',
        'c.nombre AS cliente_nombre',
        'e.user_id AS user_id',
        'e.device_id AS device_id',
      ])
      .from(SalePaymentEntity, 'p')
      .innerJoin(SaleEntity, 's', 's.sale_id = p.sale_id')
      .innerJoin(EventEntity, 'e', 'e.event_id = p.created_event_id')
      .leftJoin(ClienteEntity, 'c', 'c.cliente_id = s.cliente_id');
    const customer = this.db
      .createQueryBuilder()
      .select([
        'p.id AS id',
        'p.created_event_id AS event_id',
        'p.amount_minor AS amount_minor',
        'p.method AS method',
        'p.reference AS reference',
        'p.occurred_at_ms AS occurred_at_ms',
        "'customer_payment' AS origin",
        'NULL::uuid AS sale_id',
        'p.cliente_id AS cliente_id',
        'c.nombre AS cliente_nombre',
        'e.user_id AS user_id',
        'e.device_id AS device_id',
      ])
      .from(CustomerPaymentEntity, 'p')
      .innerJoin(EventEntity, 'e', 'e.event_id = p.created_event_id')
      .innerJoin(ClienteEntity, 'c', 'c.cliente_id = p.cliente_id');
    // Una consulta y un snapshot: nunca unir las distribuciones FIFO a los cobros.
    const movements: CollectionMovement[] = await this.db.query(
      `SELECT * FROM (
      ${direct.getQuery()} UNION ALL ${customer.getQuery()}) collections
      WHERE occurred_at_ms >= $1 AND occurred_at_ms < $2
      ORDER BY occurred_at_ms DESC, origin, id`,
      [from, to],
    );
    let cash = 0n,
      transfer = 0n;
    for (const entry of movements) {
      if (entry.method === 'cash') cash += BigInt(entry.amount_minor);
      else if (entry.method === 'transfer')
        transfer += BigInt(entry.amount_minor);
      else throw new Error('Método de cobro desconocido.');
    }
    return {
      from_ms: from,
      to_ms: to,
      currency: 'MXN',
      cash_minor: cash.toString(),
      transfer_minor: transfer.toString(),
      total_minor: (cash + transfer).toString(),
      movements,
    };
  }
}
