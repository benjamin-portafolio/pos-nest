import { Controller, Get, Query } from '@nestjs/common';
import { CollectionsReportService } from './collections-report.service';

@Controller('reports/collections')
export class CollectionsReportController {
  constructor(private readonly reports: CollectionsReportService) {}
  @Get()
  report(@Query('from_ms') from: string, @Query('to_ms') to: string) {
    return this.reports.report(Number(from), Number(to));
  }
}
