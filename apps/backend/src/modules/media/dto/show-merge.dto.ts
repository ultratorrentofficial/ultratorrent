import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Body for the duplicate show-folder preview and merge routes.
 *
 * These were typed with an inline TypeScript type, which the global `ValidationPipe`
 * (`whitelist` / `forbidNonWhitelisted` / `transform`) cannot act on — a non-class
 * type erases at runtime, so the pipe had nothing to validate against. The merge
 * route MOVES FILES AND DELETES FOLDERS, and it was reachable with an entirely
 * unvalidated body: a non-array `duplicateShowIds`, a number where an id belongs, or
 * a thousand ids in one request all reached the service. `loadShows` caught the worst
 * of it by 404-ing on unknown ids, but that is incidental defence, not validation.
 *
 * A class DTO restores the pipe: unknown properties are now rejected outright rather
 * than passed through to a destructive handler.
 */
export class ShowMergeDto {
  /** The folder every other folder in the family is merged INTO. */
  @IsUUID() canonicalShowId!: string;

  /**
   * The folders being merged away. Capped because each one is walked recursively on
   * disk during preview — an unbounded list is a cheap way to tie up the process.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  duplicateShowIds!: string[];
}

/** Query for listing duplicate show folders. */
export class ListDuplicateShowsDto {
  @IsString() @MaxLength(64) libraryId?: string;
}
