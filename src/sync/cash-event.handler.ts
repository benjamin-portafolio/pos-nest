import { cashDuplicateMatches } from './payloads/cash-event-identity';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { CashSessionEntity } from '../entities/cash-session.entity';
import { CashMovementEntity } from '../entities/cash-movement.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { CustomerPaymentEntity } from '../entities/customer-payment.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { CajaAbiertaPayload } from './payloads/caja-abierta.payload';
import { CajaCerradaPayload } from './payloads/caja-cerrada.payload';
import { CashMovementEvidence } from './payloads/cash-movement-evidence';
import { CashOperationPayload } from './payloads/cash-operation.payload';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { SyncConflictService } from './sync-conflict.service';

@Injectable()
export class CashEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}
  supports(type: string): boolean { return type===CajaAbiertaPayload.eventType || type===CajaCerradaPayload.eventType; }
  async apply(m: EntityManager,e: PushEventDto): Promise<PushEventResultDto> {
    let p: CajaAbiertaPayload | CajaCerradaPayload;
    try {
      requiredUuidV4(e.event_id,'event_id'); requiredUuidV4(e.aggregate_id,'session_id');
      if(e.aggregate_type!==CajaAbiertaPayload.aggregateType || e.base_version!==1 || e.base_server_sequence!=null) throw new Error('Sobre de caja inválido.');
      p=e.event_type===CajaAbiertaPayload.eventType ? CajaAbiertaPayload.fromJson(e.payload) : CajaCerradaPayload.fromJson(e.payload);
    } catch(error) { return this.rejected(e,(error as Error).message); }
    // La misma exclusión se toma en apertura, cierre y operaciones, incluso sin fila aún.
    await this.lock(m,'device:'+e.device_id);
    await this.lock(m,'session:'+e.aggregate_id);
    const duplicate=await m.findOneBy(EventEntity,{eventId:e.event_id});
    if(duplicate) return cashDuplicateMatches(e,duplicate)?this.result(duplicate,'duplicate'):this.rejected(e,'El event_id ya existe con otro contenido.');
    const dependency=await this.dependencies(m,e,p.dependencyEventIds);
    if(dependency) return dependency;
    const session=await m.findOneBy(CashSessionEntity,{id:e.aggregate_id});
    if(p instanceof CajaAbiertaPayload) {
      if(session || await m.existsBy(CashSessionEntity,{deviceId:e.device_id,status:'open'})) return this.conflict(m,e,'Ya existe una sesión abierta o esta identidad fue utilizada.');
      const previous=await m.findOne(CashSessionEntity,{where:{deviceId:e.device_id,status:'closed'},order:{lastServerSequence:'DESC'}});
      if((previous?.lastEventId ?? null)!==p.previousCloseEventId) return this.conflict(m,e,'La apertura no depende del último cierre del dispositivo.');
      const saved=await this.save(m,{...e,payload:p.toJson()},EventSyncStatus.SYNCED);
      await m.insert(CashSessionEntity,{id:e.aggregate_id,deviceId:e.device_id,openedByUserId:e.user_id,status:'open',openedAtMs:String(p.openedAtMs),openingMinor:String(p.openingMinor),previousCloseEventId:p.previousCloseEventId,createdEventId:e.event_id,lastEventId:e.event_id,lastServerSequence:saved.serverSequence});
      await this.refs(m,saved,e.aggregate_id,true);
      return this.result(saved,'accepted');
    }
    if(!session || session.deviceId!==e.device_id || session.status!=='open' || session.createdEventId!==p.openingEventId) return this.conflict(m,e,'La sesión no está abierta o pertenece a otro dispositivo.');
    const movements=await m.findBy(CashMovementEntity,{sessionId:session.id});
    try { p.verify(session.openingMinor,movements.map(v=>this.evidence(v))); }
    catch(error) { return this.conflict(m,e,(error as Error).message); }
    const saved=await this.save(m,{...e,payload:p.toJson()},EventSyncStatus.SYNCED);
    await m.save(CashSessionEntity,{...session,status:'closed',closedByUserId:e.user_id,closedAtMs:String(p.closedAtMs),countedMinor:String(p.countedMinor),incomeMinor:p.incomeMinor,expenseMinor:p.expenseMinor,expectedMinor:p.expectedMinor,differenceMinor:p.differenceMinor,notes:p.notes,closeSnapshot:p.toJson(),lastEventId:e.event_id,lastServerSequence:saved.serverSequence,version:2});
    await this.refs(m,saved,session.id);
    return this.result(saved,'accepted');
  }
  async operation(m: EntityManager,e: PushEventDto,apply:()=>Promise<PushEventResultDto>): Promise<PushEventResultDto> {
    if(!CashOperationPayload.hasBinding(e)) return apply();
    let p: CashOperationPayload | null;
    try { p=CashOperationPayload.fromEvent(e); }
    catch(error) { return this.rejected(e,(error as Error).message); }
    if(!p) return apply();
    await this.lock(m,'device:'+e.device_id);
    await this.lock(m,'session:'+p.cash.sessionId);
    const duplicate=await m.findOneBy(EventEntity,{eventId:e.event_id});
    if(duplicate) return cashDuplicateMatches(e,duplicate)?this.result(duplicate,'duplicate'):this.rejected(e,'El event_id ya existe con otro contenido.');
    const dependency=await this.dependencies(m,e,[p.cash.openingEventId]);
    if(dependency) return dependency;
    const session=await m.findOneBy(CashSessionEntity,{id:p.cash.sessionId});
    if(!session || session.createdEventId!==p.cash.openingEventId || session.deviceId!==e.device_id || session.status!=='open') return this.conflict(m,e,'Operación conservada: caja cerrada, inexistente o de otro dispositivo.',p.cash.sessionId);
    const result=await apply();
    if(result.status!=='accepted') return result;
    const origin=p.sourceType==='sale_payment' ? await m.findOneBy(SalePaymentEntity,{id:p.sourceId}) : p.sourceType==='customer_payment' ? await m.findOneBy(CustomerPaymentEntity,{id:p.sourceId}) : await m.findOneBy(FinancialEntryEntity,{id:p.sourceId});
    if(!origin || origin.method!=='cash' || origin.amountMinor!==String(p.amountMinor) || origin.createdEventId!==e.event_id || (origin instanceof FinancialEntryEntity && origin.direction!==p.direction)) throw new Error('El origen real no coincide con el movimiento.');
    await m.insert(CashMovementEntity,{id:p.cash.movementId,sessionId:session.id,direction:p.direction,amountMinor:String(p.amountMinor),salePaymentId:p.sourceType==='sale_payment'?p.sourceId:null,customerPaymentId:p.sourceType==='customer_payment'?p.sourceId:null,financialEntryId:p.sourceType==='financial_entry'?p.sourceId:null,createdEventId:e.event_id,lastEventId:e.event_id,lastServerSequence:result.server_sequence==null?null:String(result.server_sequence)});
    const saved=await m.findOneByOrFail(EventEntity,{eventId:e.event_id});
    await this.refs(m,saved,session.id,false,p.cash.movementId);
    return result;
  }
  evidence(v: CashMovementEntity): CashMovementEvidence {
    return CashMovementEvidence.fromJson({movement_id:v.id,event_id:v.createdEventId,direction:v.direction,amount_minor:Number(v.amountMinor),source_type:v.salePaymentId?'sale_payment':v.customerPaymentId?'customer_payment':'financial_entry',source_id:v.salePaymentId??v.customerPaymentId??v.financialEntryId});
  }
  private async lock(m: EntityManager,key: string): Promise<void> { await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',['cash:'+key]); }
  private async dependencies(m: EntityManager,e: PushEventDto,ids: string[]): Promise<PushEventResultDto|null> {
    for(const id of ids) {
      const dep=await m.findOneBy(EventEntity,{eventId:id});
      if(!dep || dep.syncStatus===EventSyncStatus.PENDING) return {event_id:e.event_id,status:'pending',server_sequence:null,created_at_server:null,reason:'Dependencia de caja pendiente: '+id};
      if(dep.syncStatus!==EventSyncStatus.SYNCED) return this.conflict(m,e,'Dependencia de caja con incidencia: '+id);
    }
    return null;
  }
  async conflict(m: EntityManager,e: PushEventDto,reason: string,sessionId=e.aggregate_id): Promise<PushEventResultDto> {
    const saved=await this.save(m,e,EventSyncStatus.CONFLICT,reason);
    await this.refs(m,saved,sessionId);
    const c=await this.conflicts.recordConflict(m,{conflictType:'cash_session_integrity',refType:'cash_session',refId:sessionId,reason,losingEvent:saved,defaultWinnerEventId:null});
    return {...this.result(saved,'conflict'),conflict_id:c.conflictId};
  }
  private save(m: EntityManager,e: PushEventDto,status: EventSyncStatus,reason: string|null=null): Promise<EventEntity> {
    return m.save(m.create(EventEntity,{eventId:e.event_id,aggregateType:e.aggregate_type,aggregateId:e.aggregate_id,eventType:e.event_type,deviceId:e.device_id,userId:e.user_id,localSequence:e.local_sequence??null,baseVersion:e.base_version??1,baseServerSequence:null,createdAtLocal:new Date(e.created_at_local),payload:e.payload,syncStatus:status,rejectionReason:reason}));
  }
  private async refs(m: EntityManager,e: EventEntity,sessionId: string,opening=false,movementId?:string): Promise<void> {
    const refs=[{refType:'cash_session',refId:sessionId,relationship:movementId?'uses':'affects'},...(opening?[{refType:'cash_device',refId:e.deviceId,relationship:'requires_unique'}]:[]),...(movementId?[{refType:'cash_movement',refId:movementId,relationship:'affects'}]:[])];
    await m.insert(EventRefEntity,refs.map(r=>({...r,eventRefId:randomUUID(),eventId:e.eventId,serverSequence:e.serverSequence,source:'server'})));
  }
  private result(e:EventEntity,status:PushEventResultDto['status']):PushEventResultDto { return {event_id:e.eventId,status,server_sequence:Number(e.serverSequence),created_at_server:e.createdAtServer.toISOString(),reason:e.rejectionReason??undefined,...(status==='duplicate'?{original_sync_status:e.syncStatus}:{})}; }
  private rejected(e:PushEventDto,reason:string):PushEventResultDto { return {event_id:e.event_id,status:'rejected',server_sequence:null,created_at_server:null,reason}; }
}
