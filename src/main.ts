import { NestFactory } from '@nestjs/core';
import { configureRecoveryBodyParser } from './recovery/recovery-body-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureRecoveryBodyParser(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
