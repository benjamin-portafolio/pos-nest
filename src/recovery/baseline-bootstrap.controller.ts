import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { BaselineBootstrapService } from './baseline-bootstrap.service';
import { recoveryError } from './recovery-errors';
@Controller('sync')
export class BaselineBootstrapController {
  constructor(private readonly bootstrap: BaselineBootstrapService) {}
  private access(h: Record<string, string>) {
    return {
      protocol: h['x-pos-protocol'],
      server: h['x-pos-server'],
      generation: h['x-pos-generation'],
      token: h.authorization?.replace(/^Bearer /, ''),
    };
  }
  @Get('bootstrap') async descriptor(
    @Headers() h: Record<string, string>,
    @Res() res: Response,
  ) {
    const r = await this.bootstrap.descriptor(this.access(h));
    res
      .type('application/json')
      .set('X-Bootstrap-Sha256', r.digest)
      .send(r.bytes);
  }
  @Get('bootstrap/chunks/:index') async chunk(
    @Headers() h: Record<string, string>,
    @Param('index') index: string,
    @Res() res: Response,
  ) {
    if (!/^(0|[1-9][0-9]*)$/.test(index))
      recoveryError(400, 'invalid_chunk_index');
    const r = await this.bootstrap.chunk(this.access(h), Number(index));
    res
      .type('application/x-ndjson')
      .set('X-Chunk-Sha256', r.digest)
      .send(r.bytes);
  }
  @Post('bindings') bind(
    @Headers() h: Record<string, string>,
    @Body() body: any,
  ) {
    return this.bootstrap.bind(this.access(h), body);
  }
}
