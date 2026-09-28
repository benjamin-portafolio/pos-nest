import { CollectionsReportService } from './reports/collections-report.service';
import { CollectionsReportController } from './reports/collections-report.controller';
import { CreditSaleEntity } from './entities/credit-sale.entity';
import { CustomerPaymentEntity } from './entities/customer-payment.entity';
import { CreditAllocationEntity } from './entities/credit-allocation.entity';
import { CustomerCreditProjector } from './sync/customer-credit.projector';
import { AbonoClienteEventHandler } from './sync/abono-cliente-event.handler';
import { ClienteEntity } from './entities/cliente.entity';
import { ClienteEventHandler } from './sync/cliente-event.handler';
import { SaleEntity } from './entities/sale.entity';
import { SaleItemEntity } from './entities/sale-item.entity';
import { SalePaymentEntity } from './entities/sale-payment.entity';
import { VentaEventHandler } from './sync/venta-event.handler';
import { CashSessionEntity } from './entities/cash-session.entity';
import { CashMovementEntity } from './entities/cash-movement.entity';
import { CashEventHandler } from './sync/cash-event.handler';
import { AccountBalanceBaselineEntity } from './entities/account-balance-baseline.entity';
import { AccountBalanceBaselineEventHandler } from './sync/account-balance-baseline-event.handler';
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
import { FinancialCategoryEntity } from './entities/financial-category.entity';
import { FinancialEntryEntity } from './entities/financial-entry.entity';
import { FinancialCategoryEventHandler } from './sync/financial-category-event.handler';
import { FinancialEntryEventHandler } from './sync/financial-entry-event.handler';
import { FinancialReportService } from './reports/financial-report.service';
import { FinancialReportController } from './reports/financial-report.controller';

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
          CreditSaleEntity,
          CustomerPaymentEntity,
          CreditAllocationEntity,
          ClienteEntity,
          SaleEntity,
          SaleItemEntity,
          SalePaymentEntity,
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
          FinancialCategoryEntity,
          FinancialEntryEntity,
          CashSessionEntity,
          CashMovementEntity,
          AccountBalanceBaselineEntity,
        ],
        autoLoadEntities: true,
      }),
    }),
  ],
  controllers: [
    AppController,
    SyncController,
    CollectionsReportController,
    FinancialReportController,
  ],
  providers: [
    CashEventHandler,
    AccountBalanceBaselineEventHandler,
    CollectionsReportService,
    FinancialReportService,
    CustomerCreditProjector,
    AbonoClienteEventHandler,
    ClienteEventHandler,
    VentaEventHandler,
    FinancialCategoryEventHandler,
    FinancialEntryEventHandler,
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
