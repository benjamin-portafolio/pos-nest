import { number } from './sale-adjustment-data';
export interface AdjustmentCharge {
  id: string;
  occurredAtMs: number;
  amountMinor: number;
  reductionMinor: number;
}
export interface AdjustmentPayment {
  id: string;
  occurredAtMs: number;
  amountMinor: number;
}
export class SaleAdjustmentCreditRules {
  static allocate(
    charges: AdjustmentCharge[],
    payments: AdjustmentPayment[],
  ): Record<string, unknown> {
    const compare = (
      a: { id: string; occurredAtMs: number },
      b: { id: string; occurredAtMs: number },
    ) =>
      a.occurredAtMs - b.occurredAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const cs = [...charges].sort(compare),
      ps = [...payments].sort(compare);
    if (
      new Set(cs.map((c) => c.id)).size !== cs.length ||
      new Set(ps.map((p) => p.id)).size !== ps.length
    )
      throw new Error('Identidad duplicada.');
    for (const c of cs) {
      number(c.amountMinor);
      number(c.reductionMinor);
      number(c.occurredAtMs);
      if (c.reductionMinor > c.amountMinor)
        throw new Error('Reducción excesiva.');
    }
    for (const p of ps) {
      number(p.amountMinor);
      number(p.occurredAtMs);
    }
    const remaining = cs.map((c) => BigInt(c.amountMinor - c.reductionMinor)),
      allocations: Record<string, unknown>[] = [];
    let favor = 0n,
      i = 0;
    for (const p of ps) {
      let available = BigInt(p.amountMinor);
      while (available > 0n && i < cs.length) {
        const amount = available < remaining[i] ? available : remaining[i];
        if (amount > 0n)
          allocations.push({
            payment_id: p.id,
            credit_id: cs[i].id,
            amount_minor: Number(amount),
          });
        available -= amount;
        remaining[i] -= amount;
        if (remaining[i] === 0n) i++;
      }
      favor += available;
    }
    const pending = remaining.reduce((a, b) => a + b, 0n);
    if (
      favor > BigInt(Number.MAX_SAFE_INTEGER) ||
      pending > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Saldo fuera de rango.');
    return {
      allocations,
      outstanding_minor: Number(pending),
      credit_balance_minor: Number(favor),
    };
  }
}
