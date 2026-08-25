# Embedded console payload

`utconsole.bin` is committed EMPTY and is filled in at build time by
`build.sh`, which copies the console binary for the platform being built and
truncates it back afterwards.

It is committed rather than generated because `go:embed` fails to compile when
its target is missing: a fresh clone must be able to run `go build ./...` and
`go vet ./...` without anyone having built the console first. An empty file
compiles, and `console.Available()` reports false, so an installer built that
way simply says the console is not included instead of writing a broken binary.

Never commit a filled-in `utconsole.bin`. `build.sh` restores it on exit,
including when interrupted.
