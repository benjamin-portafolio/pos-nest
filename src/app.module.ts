import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EventsGateway } from './events/events.gateway';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEntity } from './entities/event.entity';
import { CategoryEntity } from './entities/category.entity';
import { EventRefEntity } from './entities/event-ref.entity';
import { EspacioEntity } from './entities/espacio.entity';
import { SyncConflictParticipantEntity } from './entities/sync-conflict-participant.entity';
import { SyncConflictEntity } from './entities/sync-conflict.entity';
import { ProductEntity } from './entities/product.entity';
import { ProductVariantEntity } from './entities/product-variant.entity';
import { SyncController } from './sync/sync.controller';
import { CategoriaEventHandler } from './sync/categoria-event.handler';
import { SyncConflictService } from './sync/sync-conflict.service';
import { SyncService } from './sync/sync.service';
import { ProductoEventHandler } from './sync/producto-event.handler';
import { InventoryEventHandler } from './sync/inventory-event.handler';
import { UnitEntity } from './entities/unit.entity';
import { InventoryItemEntity } from './entities/inventory-item.entity';
import { InventoryBalanceEntity } from './entities/inventory-balance.entity';
import { InventoryMovementEntity } from './entities/inventory-movement.entity';
import { InventoryUnitSeedService } from './inventory/inventory-unit-seed.service';
import { RecipeComponentEntity } from './entities/recipe-component.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('DATABASE_HOST'),
        port: Number(config.getOrThrow<string>('DATABASE_PORT')),
        username: config.getOrThrow<string>('DATABASE_USER'),
        password: config.getOrThrow<string>('DATABASE_PASSWORD'),
        database: config.getOrThrow<string>('DATABASE_NAME'),
        synchronize: true,
        entities: [
          EventEntity,
          CategoryEntity,
          EventRefEntity,
          EspacioEntity,
          SyncConflictEntity,
          SyncConflictParticipantEntity,
          ProductEntity,
          ProductVariantEntity,
          UnitEntity,
          InventoryItemEntity,
          InventoryBalanceEntity,
          InventoryMovementEntity,
          RecipeComponentEntity,
        ],
        autoLoadEntities: true,
      }),
    }),
  ],
  controllers: [AppController, SyncController],
  providers: [
    AppService,
    EventsGateway,
    SyncService,
    SyncConflictService,
    CategoriaEventHandler,
    ProductoEventHandler,
    InventoryEventHandler,
    InventoryUnitSeedService,
  ],
})
export class AppModule {}
