/**
 * Cooperative-cancellation primitives shared by the IMDb import strategies
 * (legacy full import + optimized movie import). Kept in its own module so both
 * services can throw/catch the same sentinel without importing each other
 * (which would be a circular dependency).
 */

/** A predicate the worker polls at batch/step boundaries to decide whether to stop. */
export type ShouldCancel = () => boolean;

/** Thrown from a row loop when a stop was requested, to unwind the stream cleanly. */
export class ImportCancelledError extends Error {
  constructor() {
    super('Import stopped by user.');
    this.name = 'ImportCancelledError';
  }
}
