import { startUltraTorrentApp } from './bootstrap';

// Community / public-Core entrypoint: start the app with no external overlays.
// The private Enterprise build has its own entrypoint that passes the UPLM
// module via `externalModules`.
startUltraTorrentApp();
