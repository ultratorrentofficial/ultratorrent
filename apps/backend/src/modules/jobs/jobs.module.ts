import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';

/**
 * The cross-subsystem jobs aggregator. Read-only; relies on the global
 * `PrismaModule`. Each subsystem's own module still owns job creation and
 * cancellation — this module only *reads* for the workspace Jobs surfaces.
 */
@Module({
  providers: [JobsService],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}
