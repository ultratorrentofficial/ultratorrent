/**
 * The engine looked at this particular torrent and refused it — a duplicate it
 * will not take, a file it cannot parse, an explicit "Fails.".
 *
 * Deliberately distinct from a transport failure (engine down, timed out, bad
 * credentials): those say nothing about the release and must be retried
 * unchanged. A refusal is a fact ABOUT THE RELEASE, and that difference is what
 * stops a retry loop — an acquisition that keeps re-picking a release the client
 * will never accept re-runs the same rejection every sweep, forever. Callers may
 * remember a refusal and reach for the next candidate; they must never do that
 * on a transport failure, which would blacklist good releases every time the
 * engine is briefly unreachable.
 */
export class TorrentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TorrentRejectedError';
  }
}
