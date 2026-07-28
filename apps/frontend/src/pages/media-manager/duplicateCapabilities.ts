/**
 * What a duplicate group admits, from its status.
 *
 * Replaces the inline `group.status === 'open' ? Ignore : Reopen` ternary. That
 * branch was correct, but it was written in the one place a group is rendered
 * and paired with **no permission check at all** — the endpoints behind it
 * require `media_manager.match`, so every viewer saw controls most of them
 * could not use and learned that by clicking.
 */

export interface DuplicateGroupLike {
  status: string;
}

export function duplicateCapabilities(group: DuplicateGroupLike): string[] {
  // Only an open group can be dismissed as a false positive.
  if (group.status === 'open') return ['ignorable'];

  /*
   * Both `ignored` and `resolved` reopen. That is the service's stated
   * contract — "put an ignored or resolved group back in front of the
   * operator" — and worth checking rather than assuming: reopening a group
   * whose duplicates were already deleted looks wrong until you read that a
   * resolution can be mistaken too, and the operator needs a way back.
   */
  if (group.status === 'ignored' || group.status === 'resolved') return ['reopenable'];

  // An unknown status withholds both rather than guessing, which would either
  // hide a real duplicate or resurrect a dismissed one.
  return [];
}
