import { Global, Module } from '@nestjs/common';
import { DistributedLockService } from './distributed-lock.service';

/**
 * Redis infrastructure. Global so any module can inject the distributed lock
 * without re-importing; the service itself degrades to an in-process guard when
 * Redis is not reachable, so importing this never requires Redis to be present.
 */
@Global()
@Module({
  providers: [DistributedLockService],
  exports: [DistributedLockService],
})
export class RedisModule {}
