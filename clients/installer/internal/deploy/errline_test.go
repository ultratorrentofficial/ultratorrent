package deploy

import "testing"

// Compose writes its progress to stderr, so the literal first line is almost
// never the reason something failed. These are the real outputs from two live
// failures on ut-test, both of which pointed the reader at the wrong thing.
func TestFirstLineSkipsComposeProgress(t *testing.T) {
	cases := []struct {
		name, stderr, want string
	}{
		{
			// The build failure. `node ... || true` is harmless and merely first;
			// the cause is five lines below.
			name: "build: real error below a harmless one",
			stderr: `./ops/scripts/docker-build.sh: line 29: node: command not found
time="2026-08-23T16:45:24Z" level=warning msg="The \"POSTGRES_PASSWORD\" variable is not set."
error while interpolating services.postgres.environment.POSTGRES_PASSWORD: required variable POSTGRES_PASSWORD is missing a value`,
			want: "error while interpolating services.postgres.environment.POSTGRES_PASSWORD: required variable POSTGRES_PASSWORD is missing a value",
		},
		{
			// The failed `up`. Every line was progress; the old code reported the
			// first, which named a volume that was fine.
			name: "up: nothing but progress",
			stderr: ` Volume ultratorrent_downloads  Creating
 Container ultratorrent-redis-1  Running
 Container ultratorrent-postgres-1  Running`,
			want: "Container ultratorrent-postgres-1  Running",
		},
		{
			// A successful up opens with progress too — proving the first line is
			// not a signal either way.
			name: "real error after progress",
			stderr: ` Container ultratorrent-redis-1  Running
Error response from daemon: driver failed programming external connectivity`,
			want: "Error response from daemon: driver failed programming external connectivity",
		},
		{name: "empty", stderr: "", want: "no output"},
		{name: "single line", stderr: "boom", want: "boom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstLine(tc.stderr); got != tc.want {
				t.Errorf("firstLine()\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}
