-- Per-user display timezone.
--
-- An IANA zone name (`America/Puerto_Rico`) used to render every timestamp this
-- person sees. It matters most where there is no browser to fall back on: the
-- notification dispatcher renders Telegram, Discord and email server-side, so
-- without this those alerts carry the SERVER's clock — UTC in a container.
--
-- Nullable, and NULL means "follow the device". Every existing account keeps
-- exactly the behaviour it has today; nobody's timestamps move on deploy.
ALTER TABLE "users" ADD COLUMN "timezone" TEXT;
