-- The title recipients see in the email header, distinct from the admin-facing
-- `name`. NULL keeps the localized product title, so every existing newsletter
-- renders exactly as it does today.
ALTER TABLE "media_server_newsletters" ADD COLUMN "brandTitle" TEXT;
