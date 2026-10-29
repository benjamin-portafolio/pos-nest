import { SaleReconciliationEffectEntity } from '../entities/sale-reconciliation-effect.entity';
import { SaleReconciliationCreditAllocationEntity } from '../entities/sale-reconciliation-credit-allocation.entity';
import { SaleCreditReductionEntity } from '../entities/sale-credit-reduction.entity';
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
    const reductions = manager.connection.hasMetadata(SaleCreditReductionEntity)
      ? await manager.find(SaleCreditReductionEntity, {where: {creditId: In(credits.map(c=>c.id))}}) : [];
    const net = (id: string, amount: string) => BigInt(amount) - reductions.filter(r=>r.creditId===id).reduce((sum,r)=>sum+BigInt(r.amountMinor),0n);
    const payments = await manager.find(CustomerPaymentEntity, {
      where: { clienteId },
      order: { occurredAtMs: 'ASC', id: 'ASC' },
    });
    if (credits.length)
      await manager.delete(CreditAllocationEntity, {
        creditId: In(credits.map((c) => c.id)),
      });
    const notes = manager.connection.hasMetadata(SaleReconciliationEffectEntity) ? await manager.find(SaleReconciliationEffectEntity,{where:{ledger:'credit',targetId:clienteId}}) : [];
    const charges = [...credits.map(c=>({id:c.id,amount:net(c.id,c.amountMinor),at:BigInt(c.occurredAtMs),note:false})),...notes.filter(n=>BigInt(n.delta)<0n).map(n=>({id:n.effectId,amount:-BigInt(n.delta),at:BigInt(n.payload.occurred_at_ms as number),note:true}))].sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.id.localeCompare(b.id));
    const funds = [...payments.map(p=>({id:p.id,amount:BigInt(p.amountMinor),at:BigInt(p.occurredAtMs),note:false})),...notes.filter(n=>BigInt(n.delta)>0n).map(n=>({id:n.effectId,amount:BigInt(n.delta),at:BigInt(n.payload.occurred_at_ms as number),note:true}))].sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.id.localeCompare(b.id));
    if(manager.connection.hasMetadata(SaleReconciliationCreditAllocationEntity)) await manager.delete(SaleReconciliationCreditAllocationEntity,{clienteId});
    let i=0, used=0n;
    for(const source of funds) {
      let available=source.amount;
      while(available>0n && i<charges.length) {
        const pending=charges[i].amount-used;
        const amount=available<pending?available:pending;
        if(amount>0n) {
          if(!source.note && !charges[i].note) await manager.insert(CreditAllocationEntity,{paymentId:source.id,creditId:charges[i].id,amountMinor:String(amount)});
          else await manager.insert(SaleReconciliationCreditAllocationEntity,{sourceId:source.id,targetId:charges[i].id,clienteId,amountMinor:String(amount)});
        }
        available-=amount;used+=amount;
        if(used===charges[i].amount){i++;used=0n;}
      }
    }
  }
}
