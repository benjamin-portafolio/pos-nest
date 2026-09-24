/** Importes como texto decimal para no perder precisión al acumular centavos. */
export interface CollectionMovement {
  id: string;
  event_id: string;
  amount_minor: string;
  method: 'cash' | 'transfer';
  reference: string | null;
  occurred_at_ms: string;
  origin: 'sale' | 'customer_payment';
  sale_id: string | null;
  cliente_id: string | null;
  cliente_nombre: string | null;
  user_id: string;
  device_id: string;
}
