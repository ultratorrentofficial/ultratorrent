import { Global, Module } from '@nestjs/common';
import { GeoIpService } from './geoip.service';

/**
 * Global so any surface that shows an IP — watch history, live activity, and
 * whatever renders one next — resolves it through the one offline reader.
 */
@Global()
@Module({
  providers: [GeoIpService],
  exports: [GeoIpService],
})
export class GeoIpModule {}
