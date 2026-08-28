import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { INVENTORY_UNIT_SEED } from './inventory-unit-seed';

@Injectable()
export class InventoryUnitSeedService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const unit of INVENTORY_UNIT_SEED) {
      await this.dataSource.query(
        `
          INSERT INTO "units" (
            "unit_id", "code", "name", "symbol", "dimension",
            "atomic_factor", "max_fraction_digits", "active"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          ON CONFLICT ("unit_id") DO UPDATE SET
            "code" = EXCLUDED."code",
            "name" = EXCLUDED."name",
            "symbol" = EXCLUDED."symbol",
            "dimension" = EXCLUDED."dimension",
            "atomic_factor" = EXCLUDED."atomic_factor",
            "max_fraction_digits" = EXCLUDED."max_fraction_digits"
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
  }
}
