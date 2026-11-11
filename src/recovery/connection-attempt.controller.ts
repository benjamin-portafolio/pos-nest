import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ConnectionAttemptService } from './connection-attempt.service';

@Controller()
export class ConnectionAttemptController {
  constructor(private readonly attempts: ConnectionAttemptService) {}

  @Post('recovery/connection-request')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  recovery(@Headers() h: Record<string, string>, @Body() body: unknown) {
    return this.attempts.recovery(
      h['x-pos-server'],
      h['x-pos-generation'],
      h.authorization?.replace(/^Bearer /, ''),
      body,
    );
  }

  @Post('sync/bootstrap/request')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  bootstrap(@Headers() h: Record<string, string>) {
    return this.attempts.bootstrap(
      h['x-pos-server'],
      h['x-pos-generation'],
      h.authorization?.replace(/^Bearer /, ''),
    );
  }
}
