/** Child process harness: real production module, only explicit isolated database. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureRecoveryBodyParser } from '../../src/recovery/recovery-body-parser';
async function main() {
  if (
    process.env.DATABASE_HOST !== '127.0.0.1' ||
    process.env.DATABASE_NAME !== 'pos_nest_test_recovery_s2' ||
    process.env.DATABASE_PORT !== '55482' ||
    process.env.POS_IGNORE_ENV_FILE !== '1'
  )
    throw new Error('Isolated S2 database required');
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ['error'],
  });
  configureRecoveryBodyParser(app);
  await app.listen(0, '127.0.0.1');
  console.log('RECOVERY_READY ' + (await app.getUrl()));
  process.once('SIGTERM', () => void app.close().then(() => process.exit(0)));
}
void main();
