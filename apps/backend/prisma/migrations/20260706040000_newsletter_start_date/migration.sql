-- Fixed "included since" start date for newsletters (since_date range mode).
ALTER TABLE "media_server_newsletters" ADD COLUMN "startDate" TIMESTAMP(3);
