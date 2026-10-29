import { CreateSaleReconciliationEffects1793232000000 } from '../../src/migrations/1793232000000-CreateSaleReconciliationEffects';
import { CreateSaleAdjustments1793145600000 } from '../../src/migrations/1793145600000-CreateSaleAdjustments';
import { randomUUID } from 'crypto';
import { EventEntity } from '../../src/entities/event.entity';
import { EventSyncStatus } from '../../src/enums/event-sync-status.enum';
import { SaleAdjustmentEventHandler } from '../../src/sync/sale-adjustment-event.handler';
import { CustomerCreditProjector } from '../../src/sync/customer-credit.projector';
import { CashEventHandler } from '../../src/sync/cash-event.handler';
/** Isolated HTTP target for Flutter sale adjustment integration.
 * Run with DATABASE_* explicitly set to a new pos_nest_test_* database.
 * No application .env is loaded. Legacy baseline is created only in the
 * temporary schema; adjustment storage is installed with explicit down/up.
 */
import 'reflect-metadata';
import { Controller, Post, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SyncController } from '../../src/sync/sync.controller';
import { SyncService } from '../../src/sync/sync.service';
import { SyncConflictService } from '../../src/sync/sync-conflict.service';
import { ProductoEventHandler } from '../../src/sync/producto-event.handler';
import { InventoryEventHandler } from '../../src/sync/inventory-event.handler';
import { VentaEventHandler } from '../../src/sync/venta-event.handler';
import { ProveedorEventHandler } from '../../src/sync/proveedor-event.handler';
import { EventsGateway } from '../../src/events/events.gateway';
import { UnitEntity } from '../../src/entities/unit.entity';

async function main() {
  const name = process.env.DATABASE_NAME ?? '';
  if (
    process.env.DATABASE_HOST !== '127.0.0.1' ||
    !name.startsWith('pos_nest_test_')
  ) {
    throw new Error(
      'This harness requires loopback and a pos_nest_test_* database.',
    );
  }
  const schema = `adjustments_http_${process.pid}_${Date.now()}`;
  const options = {
    type: 'postgres' as const,
    host: '127.0.0.1',
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: name,
  };
  const admin = await new DataSource(options).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = await new DataSource({
    ...options,
    schema,
    extra: { options: `-c search_path=${schema},public` },
    entities: [join(__dirname, '../../src/entities/*.entity.ts')],
    synchronize: true,
  }).initialize();
  const runner = database.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    const migration = new CreateSaleAdjustments1793145600000();
    await runner.query('DROP TABLE sale_reconciliation_credit_allocations');
    await runner.query('DROP TABLE sale_reconciliation_effects');
    await migration.down(runner);
    await migration.up(runner);
    await new CreateSaleReconciliationEffects1793232000000().up(runner);
    await runner.commitTransaction();
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
  }
  await database.manager.save(
    UnitEntity,
    [
      ['1', 'piece', 'Pieza', 'pza', 'count', '1', 0],
      ['2', 'gram', 'Gramo', 'g', 'mass', '1', 0],
      ['3', 'kilogram', 'Kilogramo', 'kg', 'mass', '1000', 3],
      ['4', 'milliliter', 'Mililitro', 'ml', 'volume', '1', 0],
      ['5', 'liter', 'Litro', 'l', 'volume', '1000', 3],
    ].map(([suffix, code, unitName, symbol, dimension, factor, fraction]) => ({
      unitId: `10000000-0000-4000-8000-00000000000${suffix}`,
      code: String(code),
      name: String(unitName),
      symbol: String(symbol),
      dimension: String(dimension),
      atomicFactor: String(factor),
      maxFractionDigits: Number(fraction),
      active: true,
    })),
  );
  const conflicts = new SyncConflictService();
  const service = (gateway: EventsGateway) =>
    new SyncService(
      database,
      gateway,
      conflicts,
      undefined,
      new ProductoEventHandler(conflicts),
      new InventoryEventHandler(conflicts),
      new VentaEventHandler(conflicts),
      undefined,
      undefined,
      undefined,
      undefined,
      new CashEventHandler(conflicts),
      undefined,
      new ProveedorEventHandler(conflicts),
      new SaleAdjustmentEventHandler(new CustomerCreditProjector(), conflicts),
    );
  @Controller('test')
  class CompatibilityController {
    @Post('unknown') async unknown() {
      const event = await database.manager.save(
        EventEntity,
        database.manager.create(EventEntity, {
          eventId: randomUUID(),
          aggregateType: 'sale',
          aggregateId: randomUUID(),
          eventType: 'ajuste_futuro_v99',
          deviceId: 'compatibility',
          userId: 'test',
          createdAtLocal: new Date(),
          payload: { schema_version: 99 },
          syncStatus: EventSyncStatus.SYNCED,
        }),
      );
      return {
        event_id: event.eventId,
        server_sequence: Number(event.serverSequence),
      };
    }
  }
  @Module({
    controllers: [SyncController, CompatibilityController],
    providers: [
      EventsGateway,
      { provide: SyncService, useFactory: service, inject: [EventsGateway] },
    ],
  })
  class IntegrationModule {}
  const app = await NestFactory.create(IntegrationModule, {
    logger: ['error'],
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  writeFileSync(
    process.env.POS_ADJUSTMENTS_URL_FILE!,
    JSON.stringify({ url, schema }),
  );
  console.log(JSON.stringify({ url, schema, database: name }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await database.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
