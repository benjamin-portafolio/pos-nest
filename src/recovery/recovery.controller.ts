import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { isUuid } from './recovery-contract';
import { recoveryError } from './recovery-errors';
import { RecoverySessionService } from './recovery-session.service';
@Controller('recovery')
export class RecoveryController {
  constructor(private readonly sessions: RecoverySessionService) {}
  private access(h: Record<string, string>) {
    return {
      token: h.authorization?.replace(/^Bearer /, ''),
      protocol: h['x-pos-protocol'],
      server: h['x-pos-server'],
      generation: h['x-pos-generation'],
    };
  }
  private id(id: string) {
    if (!isUuid(id)) recoveryError(400, 'invalid_recovery_id');
    return id;
  }
  @Get('eligibility') eligibility(@Headers() h: Record<string, string>) {
    return this.sessions.eligibilityFor(this.access(h));
  }
  @Post('sessions') start(
    @Headers() h: Record<string, string>,
    @Body() bytes: Buffer,
  ) {
    return this.sessions.start(
      this.access(h),
      bytes,
      h['x-manifest-sha256'],
      h['idempotency-key'],
    );
  }
  @Put('sessions/:id/chunks/:index') async chunk(
    @Headers() h: Record<string, string>,
    @Param('id') id: string,
    @Param('index') index: string,
    @Body() bytes: Buffer,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!/^(0|[1-9][0-9]*)$/.test(index))
      recoveryError(400, 'invalid_chunk_index');
    const result = await this.sessions.chunk(
      this.access(h),
      this.id(id),
      Number(index),
      bytes,
      h['x-chunk-sha256'],
    );
    res.status(result.duplicate ? 200 : 201);
    return result;
  }
  @Get('sessions/:id') progress(
    @Headers() h: Record<string, string>,
    @Param('id') id: string,
    @Query('offset') offset = '0',
  ) {
    if (!/^(0|[1-9][0-9]*)$/.test(offset)) recoveryError(400, 'invalid_offset');
    return this.sessions.progress(this.access(h), this.id(id), Number(offset));
  }
  @Post('sessions/:id/abort') abort(
    @Headers() h: Record<string, string>,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    if (
      body?.protocol_version !== 1 ||
      Object.keys(body).some(
        (k) => !['protocol_version', 'expected_revision', 'reason'].includes(k),
      )
    )
      recoveryError(400, 'invalid_abort');
    return this.sessions.abort(
      this.access(h),
      this.id(id),
      body.expected_revision,
      body.reason,
    );
  }
  @HttpCode(200)
  @Post('sessions/:id/validate')
  validate(
    @Headers() h: Record<string, string>,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.sessions.validate(this.access(h), this.id(id), body);
  }
  @HttpCode(200)
  @Post('sessions/:id/finalize')
  finalize(
    @Headers() h: Record<string, string>,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.sessions.finalize(this.access(h), this.id(id), body);
  }
}
