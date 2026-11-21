/** Matriz pura; el handler deberá validar cantidades/base antes de aplicarla. */
export type SupplierOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'partial'
  | 'received'
  | 'closed'
  | 'cancelled';
export function supplierOrderCanTransition(
  from: SupplierOrderStatus,
  to: SupplierOrderStatus,
): boolean {
  const transitions: Record<
    SupplierOrderStatus,
    readonly SupplierOrderStatus[]
  > = {
    draft: ['draft', 'confirmed', 'cancelled'],
    confirmed: ['partial', 'received', 'closed', 'cancelled'],
    partial: ['partial', 'received', 'closed'],
    received: [],
    closed: [],
    cancelled: [],
  };
  return transitions[from].includes(to);
}
