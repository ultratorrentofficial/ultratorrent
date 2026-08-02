---
"ultratorrent": patch
---

File placement no longer overwrites an existing destination. `rename(2)` and `copyFile` REPLACE their target — POSIX behaviour, not a bug — so any two files resolving to the same name meant one was silently deleted. That loss is unrecoverable here: undo replays recorded moves backwards, and a file destroyed by an overwrite was never a move, so it appears in no log to restore from. An occupied destination now throws `DestinationExistsError`; the renamer records a FAILED rename operation naming the destination and leaves the source exactly where it was, so both files survive and the collision is visible afterwards. A dangling symlink or a directory counts as occupied. Copies use `COPYFILE_EXCL` so the check-then-act gap is closed wherever the syscall allows it. The guard lives in the shared primitive, so Media Intake gets it too.
