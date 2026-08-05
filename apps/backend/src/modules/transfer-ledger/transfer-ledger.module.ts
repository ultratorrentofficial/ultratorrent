import { Global, Module } from '@nestjs/common';
import { TransferLedgerService } from './transfer-ledger.service';

/**
 * Persistent transfer statistics.
 *
 * Global because the ledger has two unrelated consumers — the sync loop that
 * feeds it and the dashboard that reads it — and threading an import between
 * `TorrentsModule` and `DashboardModule` would be a module cycle waiting to
 * happen. The service holds no request state; it is a counter with a database
 * behind it.
 */
@Global()
@Module({
  providers: [TransferLedgerService],
  exports: [TransferLedgerService],
})
export class TransferLedgerModule {}
