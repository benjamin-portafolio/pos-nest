import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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
import type { SyncHealthResponseDto } from './dto/sync-health.dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('health')
  health(): Promise<SyncHealthResponseDto> {
    return this.syncService.health();
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
