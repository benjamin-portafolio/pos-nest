import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { INVENTORY_UNIT_SEED } from './inventory-unit-seed';

@Injectable()
export class InventoryUnitSeedService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [state] = await manager.query(
        'SELECT mode FROM server_state WHERE singleton FOR SHARE',
      );
      if (state.mode === 'recovering') return;
      for (const unit of INVENTORY_UNIT_SEED) {
        await manager.query(
          `
          INSERT INTO "units" (
            "unit_id", "code", "name", "symbol", "dimension",
            "atomic_factor", "max_fraction_digits", "active"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          ON CONFLICT DO NOTHING
        `,
          [
            unit.unitId,
            unit.code,
            unit.name,
            unit.symbol,
            unit.dimension,
            unit.atomicFactor,
            unit.maxFractionDigits,
          ],
        );
      }
    });
  }
}
