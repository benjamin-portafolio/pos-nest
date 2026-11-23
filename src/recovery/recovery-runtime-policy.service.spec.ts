import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RecoveryRuntimePolicyService } from './recovery-runtime-policy.service';

describe('RecoveryRuntimePolicyService', () => {
  const originalEnv = process.env;
  let query: jest.Mock;
  let warn: jest.SpyInstance;
  let service: RecoveryRuntimePolicyService;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.POS_ALLOW_UNSAFE_DB_ROLE;
    query = jest
      .fn()
      .mockResolvedValueOnce([{ privileged: true }])
      .mockResolvedValueOnce([{ relname: 'products' }])
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValueOnce([{ installed: true }])
      .mockResolvedValueOnce([{ installed: true }])
      .mockResolvedValueOnce([{ singleton: true }]);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    service = new RecoveryRuntimePolicyService({
      query,
    } as unknown as DataSource);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it.each([
    [undefined, undefined],
    [undefined, '1'],
    ['production', '1'],
    ['test', '1'],
    ['staging', '1'],
    ['development', undefined],
    ['development', '0'],
    ['development', 'true'],
  ])(
    'rejects a privileged role with NODE_ENV=%s and opt-in=%s',
    async (env, optIn) => {
      if (env !== undefined) process.env.NODE_ENV = env;
      if (optIn !== undefined) process.env.POS_ALLOW_UNSAFE_DB_ROLE = optIn;

      await expect(service.onModuleInit()).rejects.toThrow('Unsafe runtime');
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('allows an explicitly opted-in development role and checks recovery prerequisites', async () => {
    process.env.NODE_ENV = 'development';
    process.env.POS_ALLOW_UNSAFE_DB_ROLE = '1';

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('POS_ALLOW_UNSAFE_DB_ROLE=1'),
    );
    expect(query).toHaveBeenCalledTimes(6);
  });

  it.each([
    [3, [], 'Recovery dataset migration missing'],
    [4, [], 'Connection request migration missing'],
    [5, [], 'Recovery migration/control missing'],
  ])(
    'still rejects missing recovery prerequisites at query %s',
    async (index, rows, message) => {
      process.env.NODE_ENV = 'development';
      process.env.POS_ALLOW_UNSAFE_DB_ROLE = '1';
      const results = [
        [{ privileged: true }],
        [],
        [{ allowed: false }],
        [{ installed: true }],
        [{ installed: true }],
        [{ singleton: true }],
      ];
      results[index] = index === 5 ? rows : [{ installed: false }];
      query.mockReset();
      results.forEach((result) => query.mockResolvedValueOnce(result));

      await expect(service.onModuleInit()).rejects.toThrow(message);
    },
  );

  it('accepts a restricted production role without an exception or warning', async () => {
    process.env.NODE_ENV = 'production';
    query.mockReset();
    [
      [{ privileged: false }],
      [],
      [{ allowed: false }],
      [{ installed: true }],
      [{ installed: true }],
      [{ singleton: true }],
    ].forEach((result) => query.mockResolvedValueOnce(result));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
