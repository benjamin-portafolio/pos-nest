import { Controller, Get, Query } from '@nestjs/common';
import { FinancialReportService } from './financial-report.service';

@Controller('reports/financial')
export class FinancialReportController {
  constructor(private readonly reports: FinancialReportService) {}

  @Get()
  report(
    @Query('from_ms') from: string,
    @Query('to_ms') to: string,
    @Query('method') method?: string,
    @Query('direction') direction?: string,
    @Query('category_id') categoryId?: string,
  ) {
    return this.reports.report(Number(from), Number(to), {
      method,
      direction,
      categoryId,
    });
  }
}
