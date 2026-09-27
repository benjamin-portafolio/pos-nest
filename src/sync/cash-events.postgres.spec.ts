import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CashSessionEntity } from '../entities/cash-session.entity';
import { CashMovementEntity } from '../entities/cash-movement.entity';
import { EventEntity } from '../entities/event.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { EventsGateway } from '../events/events.gateway';
import { SyncService } from './sync.service';
import { SyncConflictService } from './sync-conflict.service';
import { CashEventHandler } from './cash-event.handler';
import { FinancialCategoryEventHandler } from './financial-category-event.handler';
import { FinancialEntryEventHandler } from './financial-entry-event.handler';
import { PushEventDto } from './dto/push-events.dto';
import { CreateCashSessions1790337600000 } from '../migrations/1790337600000-CreateCashSessions';
import { CajaCerradaPayload } from './payloads/caja-cerrada.payload';
import { readFileSync } from 'fs';
import { join } from 'path';
const integration=process.env.RUN_POSTGRES_INTEGRATION==='1'?describe:describe.skip;
integration('Caja PostgreSQL temporal, transacciones y causalidad',()=>{
 jest.setTimeout(30000);
 let db:DataSource,service:SyncService;
 const handler=new CashEventHandler(new SyncConflictService());
 const device='cash-test-'+randomUUID();
 beforeAll(async()=>{
  if(!process.env.DATABASE_NAME?.startsWith('pos_cash_test_')) throw new Error('Estas pruebas exigen DATABASE_NAME temporal pos_cash_test_*.');
  db=new DataSource({type:'postgres',host:process.env.DATABASE_HOST,port:Number(process.env.DATABASE_PORT),username:process.env.DATABASE_USER,password:process.env.DATABASE_PASSWORD,database:process.env.DATABASE_NAME,synchronize:true,entities:[__dirname+'/../entities/*.entity.ts']});
  await db.initialize();
  service=new SyncService(db,{notifyEventsAvailable:jest.fn()} as unknown as EventsGateway,new SyncConflictService(),undefined,undefined,undefined,undefined,undefined,undefined,new FinancialCategoryEventHandler(new SyncConflictService()),new FinancialEntryEventHandler(new SyncConflictService()),handler);
 });
 afterAll(async()=>{if(db?.isInitialized) await db.destroy();});
 beforeEach(async()=>{ await db.query('TRUNCATE cash_movements,cash_sessions,financial_entries,financial_categories,events,event_refs,sync_conflicts,sync_conflict_participants CASCADE'); });
 function event(type:string,id:string,payload:Record<string,unknown>,writer=device):PushEventDto{return {event_id:randomUUID(),aggregate_type:type.startsWith('caja_')?'cash_session':type==='categoria_financiera_creada'?'financial_category':'financial_entry',aggregate_id:id,event_type:type,device_id:writer,user_id:'cash-user',created_at_local:new Date().toISOString(),base_version:1,payload};}
 const push=async(e:PushEventDto)=>(await service.pushEvents({device_id:e.device_id,events:[e]})).results[0];
 async function open(previous:string|null=null){const e=event('caja_abierta',randomUUID(),{opening_minor:10000,opened_at_ms:Date.now(),previous_close_event_id:previous});expect((await push(e)).status).toBe('accepted');return e;}
 async function entry(o:PushEventDto,method='cash',direction='in'){
  const cat=event('categoria_financiera_creada',randomUUID(),{name:'Varios',direction,nature:'operating'});expect((await push(cat)).status).toBe('accepted');
  return event('movimiento_financiero_registrado',randomUUID(),{category_id:cat.aggregate_id,category_event_id:cat.event_id,category_name_snapshot:'Varios',direction,nature:'operating',amount_minor:2500,currency:'MXN',method,occurred_at_ms:Date.now(),notes:null,reference:null,...(method==='cash'?{cash:{session_id:o.aggregate_id,opening_event_id:o.event_id,movement_id:randomUUID()}}:{})});
 }
 async function close(o:PushEventDto){
  const movements=(await db.manager.findBy(CashMovementEntity,{sessionId:o.aggregate_id})).map(m=>handler.evidence(m));
  const income=movements.filter(m=>m.direction==='in').reduce((s,m)=>s+BigInt(m.amountMinor),0n),expense=movements.filter(m=>m.direction==='out').reduce((s,m)=>s+BigInt(m.amountMinor),0n),expected=10000n+income-expense;
  return event('caja_cerrada',o.aggregate_id,{opening_event_id:o.event_id,closed_at_ms:Date.now(),counted_minor:10000,income_minor:income.toString(),expense_minor:expense.toString(),expected_minor:expected.toString(),difference_minor:(10000n-expected).toString(),notes:null,movements:movements.map(m=>m.toJson())});
 }
 test('fixtures compartidos y rechazo de totales divergentes',()=>{
  const root=process.env.CASH_FIXTURES_DIR??'/Users/benjamin/Library/CloudStorage/GoogleDrive-benjamin94833@gmail.com/My Drive/Projects/POS/analisis /08 - Roadmap/Caja/Fixtures';
  const valid=CajaCerradaPayload.fromJson(JSON.parse(readFileSync(join(root,'close-valid.json'),'utf8')) as Record<string,unknown>);valid.verify('10000',valid.movements);
  const invalid=CajaCerradaPayload.fromJson(JSON.parse(readFileSync(join(root,'close-wrong-total.json'),'utf8')) as Record<string,unknown>);expect(()=>invalid.verify('10000',invalid.movements)).toThrow();
 });
 test('event_id con contenido distinto se rechaza sin mutar caja',async()=>{const o=await open();expect((await push({...o,payload:{...o.payload,opening_minor:999}})).status).toBe('rejected');expect((await db.manager.findOneByOrFail(CashSessionEntity,{id:o.aggregate_id})).openingMinor).toBe('10000');});
 test('apertura repetida y dos aperturas concurrentes, una sola abierta',async()=>{
  const a=event('caja_abierta',randomUUID(),{opening_minor:0,opened_at_ms:1});const b={...a,event_id:randomUUID(),aggregate_id:randomUUID()};
  const r=await Promise.all([push(a),push(b)]);expect(r.map(x=>x.status).sort()).toEqual(['accepted','conflict']);
  expect((await push(a)).status).toBe('duplicate');expect(await db.manager.count(CashSessionEntity,{where:{status:'open'}})).toBe(1);
 });
 test('cash in/out, transfer excluido, corte recalculado, reintento y tardío conservado',async()=>{
  const o=await open();const incoming=await entry(o),outgoing=await entry(o,'cash','out'),transfer=await entry(o,'transfer');
  for(const e of [incoming,outgoing,transfer]) expect((await push(e)).status).toBe('accepted');
  expect(await db.manager.count(CashMovementEntity)).toBe(2);
  const c=await close(o);expect((await push(c)).status).toBe('accepted');expect((await push(c)).original_sync_status).toBe('synced');
  const session=await db.manager.findOneByOrFail(CashSessionEntity,{id:o.aggregate_id});expect(session.expectedMinor).toBe('10000');expect(session.countedMinor).toBe('10000');
  const late=await entry(o);expect((await push(late)).status).toBe('conflict');expect((await db.manager.findOneByOrFail(EventEntity,{eventId:late.event_id})).payload).toEqual(late.payload);expect(await db.manager.count(CashMovementEntity)).toBe(2);
  const next=await open(c.event_id);expect(next.aggregate_id).not.toBe(o.aggregate_id);
 });
 test('cierre antes de dependencia queda pending y acepta retry tras recibir operación',async()=>{
  const o=await open(), e=await entry(o),c=await close(o);const cash=e.payload.cash as Record<string,string>;
  c.payload={...c.payload,income_minor:'2500',expected_minor:'12500',difference_minor:'-2500',movements:[{movement_id:cash.movement_id,event_id:e.event_id,direction:'in',amount_minor:2500,source_type:'financial_entry',source_id:e.aggregate_id}]};
  expect((await push(c)).status).toBe('pending');expect(await db.manager.existsBy(EventEntity,{eventId:c.event_id})).toBe(false);
  expect((await push(e)).status).toBe('accepted');expect((await push(c)).status).toBe('accepted');
 });
 test('dependencia conflictiva y segundo escritor nunca aceptan cierre ni operación',async()=>{
  const o=await open(),e=await entry(o);e.device_id='other-device';expect((await push(e)).status).toBe('conflict');
  const c=await close(o),cash=e.payload.cash as Record<string,string>;
  c.payload.movements=[{movement_id:cash.movement_id,event_id:e.event_id,direction:'in',amount_minor:2500,source_type:'financial_entry',source_id:e.aggregate_id}];
  expect((await push(c)).status).toBe('conflict');expect((await db.manager.findOneByOrFail(CashSessionEntity,{id:o.aggregate_id})).status).toBe('open');
 });
 test('concurrencia operación/cierre no cambia un corte aceptado',async()=>{
  const o=await open(),e=await entry(o),c=await close(o);
  const [operation,closing]=await Promise.all([push(e),push(c)]);
  expect([operation.status,closing.status].sort()).toEqual(['accepted','conflict']);
  const session=await db.manager.findOneByOrFail(CashSessionEntity,{id:o.aggregate_id});
  if(session.status==='closed') expect(await db.manager.count(CashMovementEntity)).toBe(0); else expect(await db.manager.count(CashMovementEntity)).toBe(1);
 });
 test('corte con lista incompleta o total alterado no es aceptado',async()=>{
  const o=await open(),e=await entry(o);expect((await push(e)).status).toBe('accepted');const c=await close(o);c.payload.expected_minor='99999';expect((await push(c)).status).toBe('conflict');
  const d=await close(o);d.payload.movements=[];expect((await push(d)).status).toBe('conflict');
  expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
 });
 test('migración aditiva y down protegido en esquema temporal',async()=>{
  const r=db.createQueryRunner();await r.connect();await r.startTransaction();
  try {await r.query('CREATE SCHEMA cash_migration_temp');await r.query('SET LOCAL search_path TO cash_migration_temp');
   await r.query('CREATE TABLE sale_payments(payment_id uuid PRIMARY KEY); CREATE TABLE customer_payments(id uuid PRIMARY KEY); CREATE TABLE financial_entries(id uuid PRIMARY KEY)');
   const migration=new CreateCashSessions1790337600000();await migration.up(r);
   await r.query("INSERT INTO cash_sessions(id,device_id,opened_by_user_id,status,opened_at_ms,opening_minor) VALUES ($1,'device','user','open',1,0)",[randomUUID()]);
   await expect(migration.down(r)).rejects.toThrow('historial');
   await r.query('DELETE FROM cash_sessions');await migration.down(r);
  } finally {await r.rollbackTransaction();await r.release();}
 });
});
