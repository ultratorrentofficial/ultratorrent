-- Account lockout: track consecutive failed login attempts and a temporary lock
-- window, so a distributed/rotating-IP guesser can't brute-force past the per-IP
-- rate limit. Both additive + nullable/defaulted — no existing data is touched.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lockedUntil" TIMESTAMP(3);
