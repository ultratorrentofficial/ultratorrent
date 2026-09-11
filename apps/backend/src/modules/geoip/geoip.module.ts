import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { GeoIpService } from './geoip.service';
import { GeoIpSettingsService } from './geoip-settings.service';
import { GeoIpDownloaderService } from './geoip-downloader.service';
import { GeoIpSchedulerService } from './geoip-scheduler.service';
import { GeoIpController } from './geoip.controller';

/**
 * `GeoIpService` (the offline reader) is @Global so every surface that shows an
 * IP resolves it through the one reader. The admin services — settings, the
 * downloader and its scheduler — are ordinary providers behind the controller.
 * `SecretCipher` is registered locally (it is not global), mirroring the other
 * modules that hold an encrypted credential.
 */
@Global()
@Module({
  imports: [SettingsModule],
  controllers: [GeoIpController],
  providers: [
    GeoIpService,
    GeoIpSettingsService,
    GeoIpDownloaderService,
    GeoIpSchedulerService,
    SecretCipher,
  ],
  exports: [GeoIpService],
})
export class GeoIpModule {}
