/** Isolated HTTP target for the Flutter inventory tracking integration test.
 * Run with DATABASE_* explicitly set to a new pos_nest_test_* database.
 * No application .env is loaded and no migrations run.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
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
import { UnitEntity } from '../../src/entities/unit.entity';
import type { EventsGateway } from '../../src/events/events.gateway';

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
  const schema = `seg_phase3_http_${process.pid}_${Date.now()}`;
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
    entities: [join(__dirname, '../../src/entities/*.entity.ts')],
    synchronize: true,
  }).initialize();
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
  const service = new SyncService(
    database,
    { notifyEventsAvailable() {} } as unknown as EventsGateway,
    conflicts,
    undefined,
    new ProductoEventHandler(conflicts),
    new InventoryEventHandler(conflicts),
    new VentaEventHandler(conflicts),
  );
  @Module({
    controllers: [SyncController],
    providers: [{ provide: SyncService, useValue: service }],
  })
  class IntegrationModule {}
  const app = await NestFactory.create(IntegrationModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  writeFileSync(
    process.env.POS_PHASE3_URL_FILE!,
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
