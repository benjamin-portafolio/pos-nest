import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { CreditSaleEntity } from '../entities/credit-sale.entity';
import { CustomerPaymentEntity } from '../entities/customer-payment.entity';
import { CreditAllocationEntity } from '../entities/credit-allocation.entity';

/** Serializa por cuenta y reconstruye FIFO sin depender del orden de llegada. */
@Injectable()
export class CustomerCreditProjector {
  async lock(manager: EntityManager, clienteId: string): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['customer_account:' + clienteId],
    );
  }
  async rebuild(manager: EntityManager, clienteId: string): Promise<void> {
    const credits = await manager.find(CreditSaleEntity, {
      where: { clienteId },
      order: { occurredAtMs: 'ASC', id: 'ASC' },
    });
    const payments = await manager.find(CustomerPaymentEntity, {
      where: { clienteId },
      order: { occurredAtMs: 'ASC', id: 'ASC' },
    });
    if (credits.length)
      await manager.delete(CreditAllocationEntity, {
        creditId: In(credits.map((c) => c.id)),
      });
    let i = 0,
      used = 0n;
    for (const payment of payments) {
      let available = BigInt(payment.amountMinor);
      while (available > 0n && i < credits.length) {
        const pending = BigInt(credits[i].amountMinor) - used;
        const amount = available < pending ? available : pending;
        if (amount > 0n)
          await manager.insert(CreditAllocationEntity, {
            paymentId: payment.id,
            creditId: credits[i].id,
            amountMinor: String(amount),
          });
        available -= amount;
        used += amount;
        if (used === BigInt(credits[i].amountMinor)) {
          i++;
          used = 0n;
        }
      }
    }
  }
}
