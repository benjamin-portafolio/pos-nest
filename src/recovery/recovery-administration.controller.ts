import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Header,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RecoveryAdminGuard } from './recovery-admin.guard';
import { RecoveryAdministrationService } from './recovery-administration.service';

@Controller('recovery-admin')
@UseGuards(RecoveryAdminGuard)
export class RecoveryAdministrationController {
  constructor(private readonly admin: RecoveryAdministrationService) {}
  private access(h: Record<string, string>) {
    return {
      server: h['x-pos-server'],
      generation: h['x-pos-generation'],
      protocol: h['x-pos-protocol'],
    };
  }
  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@Headers() h: Record<string, string>) {
    return this.admin.status(this.access(h));
  }
  @Post('actions')
  @HttpCode(200)
  execute(@Headers() h: Record<string, string>, @Body() body: unknown) {
    return this.admin.execute(this.access(h), body);
  }
}
