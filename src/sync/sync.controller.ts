import { ServerStateService } from '../recovery/server-state.service';
import { Body, Controller, Get, Post, Query, Optional } from '@nestjs/common';
import type {
  ListConflictsQueryDto,
  ListConflictsResponseDto,
} from './dto/list-conflicts.dto';
import type {
  PullEventsQueryDto,
  PullEventsResponseDto,
} from './dto/pull-events.dto';
import type {
  PreflightEventsDto,
  PreflightEventsResponseDto,
} from './dto/preflight-events.dto';
import type {
  PushEventsDto,
  PushEventsResponseDto,
} from './dto/push-events.dto';
import type {
  ReportConflictsDto,
  ReportConflictsResponseDto,
} from './dto/report-conflicts.dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    @Optional() private readonly serverState?: ServerStateService,
  ) {}

  @Get('health')
  async health() {
    const health = await this.syncService.health();
    if (!this.serverState) return health;
    const state = await this.serverState.status();
    return {
      ...health,
      ...state,
      capabilities: [
        ...health.capabilities,
        'recovery_transport_v1',
        'sync_identity_v2',
        'baseline_bootstrap_required',
      ],
      latest_server_sequence: Math.max(
        health.latest_server_sequence,
        Number(state.baseline_high_watermark),
      ),
    };
  }

  @Post('push')
  pushEvents(@Body() body: PushEventsDto): Promise<PushEventsResponseDto> {
    return this.syncService.pushEvents(body);
  }

  @Post('preflight')
  preflightEvents(
    @Body() body: PreflightEventsDto,
  ): Promise<PreflightEventsResponseDto> {
    return this.syncService.preflightEvents(body);
  }

  @Post('conflicts/report')
  reportConflicts(
    @Body() body: ReportConflictsDto,
  ): Promise<ReportConflictsResponseDto> {
    return this.syncService.reportConflicts(body);
  }

  @Get('conflicts')
  listConflicts(
    @Query() query: ListConflictsQueryDto,
  ): Promise<ListConflictsResponseDto> {
    return this.syncService.listConflicts(query);
  }

  @Get('pull')
  pullEvents(
    @Query() query: PullEventsQueryDto,
  ): Promise<PullEventsResponseDto> {
    return this.syncService.pullEvents(query);
  }
}
