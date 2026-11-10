import { BaselineBootstrapService } from './recovery/baseline-bootstrap.service';
import { BaselineBootstrapController } from './recovery/baseline-bootstrap.controller';
import { RecoveryStagingService } from './recovery/recovery-staging.service';
import { RecoveryValidationService } from './recovery/recovery-validation.service';
import { RecoveryPublicationService } from './recovery/recovery-publication.service';
import { CreateRecoveryDataset1794182400000 } from './migrations/1794182400000-CreateRecoveryDataset';
import { RecoveryRuntimePolicyService } from './recovery/recovery-runtime-policy.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CreateRecoveryProtocol1794096000000 } from './migrations/1794096000000-CreateRecoveryProtocol';
import { RecoveryController } from './recovery/recovery.controller';
import { RecoverySessionService } from './recovery/recovery-session.service';
import { RecoveryAuthorizationService } from './recovery/recovery-authorization.service';
import { RecoveryEligibilityService } from './recovery/recovery-eligibility.service';
import { ServerStateService } from './recovery/server-state.service';
import { ServerStateInterceptor } from './recovery/server-state.interceptor';
import { AddOfferPricing1793404800000 } from './migrations/1793404800000-AddOfferPricing';
import { SaleReconciliationCreditAllocationEntity } from './entities/sale-reconciliation-credit-allocation.entity';
import { SaleReconciliationEffectEntity } from './entities/sale-reconciliation-effect.entity';
import { CreateSaleReconciliationEffects1793232000000 } from './migrations/1793232000000-CreateSaleReconciliationEffects';
import { AlignSaleAdjustmentProjectionComments1793318400000 } from './migrations/1793318400000-AlignSaleAdjustmentProjectionComments';
import { SaleAdjustmentEntity } from './entities/sale-adjustment.entity';
import { SaleAdjustmentLineEntity } from './entities/sale-adjustment-line.entity';
import { SaleCreditReductionEntity } from './entities/sale-credit-reduction.entity';
import { SaleAdjustmentEventHandler } from './sync/sale-adjustment-event.handler';
import { CreateSaleAdjustments1793145600000 } from './migrations/1793145600000-CreateSaleAdjustments';
import { AddVariantMinimumStock1792368000000 } from './migrations/1792368000000-AddVariantMinimumStock';
import { SupplierEntity } from './entities/supplier.entity';
import { VariantSupplierEntity } from './entities/variant-supplier.entity';
import { ProveedorEventHandler } from './sync/proveedor-event.handler';
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
import { VariantInventoryMemoryEntity } from './entities/variant-inventory-memory.entity';
import { FinancialCategoryEntity } from './entities/financial-category.entity';
import { FinancialEntryEntity } from './entities/financial-entry.entity';
import { FinancialCategoryEventHandler } from './sync/financial-category-event.handler';
import { FinancialEntryEventHandler } from './sync/financial-entry-event.handler';
import { FinancialReportService } from './reports/financial-report.service';
import { FinancialReportController } from './reports/financial-report.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.POS_IGNORE_ENV_FILE === '1',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('DATABASE_HOST'),
        port: Number(config.getOrThrow<string>('DATABASE_PORT')),
        username: config.getOrThrow<string>('DATABASE_USER'),
        password: config.getOrThrow<string>('DATABASE_PASSWORD'),
        database: config.getOrThrow<string>('DATABASE_NAME'),
        // Las relaciones/constraints de ajustes se instalan por migración explícita.
        synchronize: false,
        // Registro para ejecución explícita; nunca ejecutar migraciones al arrancar.
        migrations: [
          CreateRecoveryProtocol1794096000000,
          CreateRecoveryDataset1794182400000,
          AddOfferPricing1793404800000,
          AddVariantMinimumStock1792368000000,
          CreateSaleAdjustments1793145600000,
          CreateSaleReconciliationEffects1793232000000,
          AlignSaleAdjustmentProjectionComments1793318400000,
        ],
        migrationsRun: false,
        entities: [
          SaleReconciliationCreditAllocationEntity,
          SaleReconciliationEffectEntity,
          SaleAdjustmentEntity,
          SaleAdjustmentLineEntity,
          SaleCreditReductionEntity,
          CreditSaleEntity,
          CustomerPaymentEntity,
          CreditAllocationEntity,
          ClienteEntity,
          SupplierEntity,
          VariantSupplierEntity,
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
          VariantInventoryMemoryEntity,
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
    RecoveryController,
    BaselineBootstrapController,
    AppController,
    SyncController,
    CollectionsReportController,
    FinancialReportController,
  ],
  providers: [
    RecoveryRuntimePolicyService,
    RecoverySessionService,
    RecoveryStagingService,
    BaselineBootstrapService,
    RecoveryValidationService,
    RecoveryPublicationService,
    RecoveryAuthorizationService,
    RecoveryEligibilityService,
    ServerStateService,
    { provide: APP_INTERCEPTOR, useClass: ServerStateInterceptor },
    SaleAdjustmentEventHandler,
    CashEventHandler,
    AccountBalanceBaselineEventHandler,
    CollectionsReportService,
    FinancialReportService,
    CustomerCreditProjector,
    AbonoClienteEventHandler,
    ClienteEventHandler,
    ProveedorEventHandler,
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
