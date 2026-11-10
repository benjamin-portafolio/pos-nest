import { HttpException } from '@nestjs/common';
export function recoveryError(
  status: number,
  code: string,
  details?: unknown,
): never {
  throw new HttpException(
    { code, ...(details === undefined ? {} : { details }) },
    status,
  );
}
