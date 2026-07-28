/**
 * `POST /files/bulk` must not let one permission stand in for another.
 *
 * The endpoint serves move, copy, delete and cleanup, so its route guard can
 * only require `files.bulk_actions` — which made that single grant a superset
 * of every file permission. A user given it to move files could **delete**
 * them, because the service dispatches on `dto.operation` and nothing
 * downstream re-checked.
 *
 * `TorrentsService.bulk` has always guarded against exactly this for exactly
 * this reason; Files did not. Found while auditing CAMA declarations against
 * their endpoints, which is how a UI-facing audit turned up a server-side hole.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { assertBulkOperationAllowed } from './files.controller';

const user = (permissions: string[], roles: string[] = ['user']): AuthenticatedUser => ({
  id: 'u1',
  username: 'u',
  roles,
  permissions,
});

describe('bulk file operations re-check the operation permission', () => {
  it('refuses a delete from someone who may only move', () => {
    // The escalation itself: `files.bulk_actions` + `files.move` must not
    // delete. Before this check it did.
    const mover = user([PERMISSIONS.FILES_BULK_ACTIONS, PERMISSIONS.FILES_MOVE]);
    expect(() => assertBulkOperationAllowed('delete', mover)).toThrow(ForbiddenException);
    expect(() => assertBulkOperationAllowed('move', mover)).not.toThrow();
  });

  it('treats cleanup as the deletion it is', () => {
    /*
     * `cleanup` removes files exactly as `delete` does — it is a filtered
     * deletion, not a lesser one. Mapping it to the weaker `files.cleanup`
     * (which governs the separate scan/preview routes) would leave the hole
     * open under another name.
     */
    const cleaner = user([PERMISSIONS.FILES_BULK_ACTIONS, PERMISSIONS.FILES_CLEANUP]);
    expect(() => assertBulkOperationAllowed('cleanup', cleaner)).toThrow(ForbiddenException);

    const deleter = user([PERMISSIONS.FILES_BULK_ACTIONS, PERMISSIONS.FILES_DELETE]);
    expect(() => assertBulkOperationAllowed('cleanup', deleter)).not.toThrow();
  });

  it('allows each operation to the permission that owns it', () => {
    for (const [op, perm] of [
      ['move', PERMISSIONS.FILES_MOVE],
      ['copy', PERMISSIONS.FILES_COPY],
      ['delete', PERMISSIONS.FILES_DELETE],
    ] as const) {
      expect(() => assertBulkOperationAllowed(op, user([perm]))).not.toThrow();
    }
  });

  it('bypasses for a super admin, mirroring PermissionsGuard', () => {
    // Without the bypass an administrator would be refused work they can do
    // one file at a time.
    expect(() =>
      assertBulkOperationAllowed('delete', user([], [SystemRole.SUPER_ADMIN])),
    ).not.toThrow();
  });

  it('rejects an operation it does not know rather than allowing it', () => {
    // Fail closed: an operation added to the service without being added here
    // must be refused, not waved through.
    expect(() => assertBulkOperationAllowed('exfiltrate', user([PERMISSIONS.FILES_DELETE])))
      .toThrow(BadRequestException);
  });

  it('refuses a user holding only files.bulk_actions', () => {
    const bare = user([PERMISSIONS.FILES_BULK_ACTIONS]);
    for (const op of ['move', 'copy', 'delete', 'cleanup']) {
      expect(() => assertBulkOperationAllowed(op, bare)).toThrow(ForbiddenException);
    }
  });
});
