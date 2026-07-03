import { Global, Module } from '@nestjs/common';
import { TwoFactorService } from './two-factor.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

@Global()
@Module({
  providers: [TwoFactorService, SecretCipher],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
