package host

import (
	"net"
	"strconv"
	"strings"
)

// listenAny binds an ephemeral port so a test can assert that PortIsFree sees
// it as taken. Using a real socket rather than a stub is the point: the check
// under test is itself a bind, and a stub would test nothing.
type boundPort struct {
	l    net.Listener
	port int
}

func listenAny() (*boundPort, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	_, portStr, err := net.SplitHostPort(l.Addr().String())
	if err != nil {
		l.Close()
		return nil, err
	}
	port, err := strconv.Atoi(strings.TrimSpace(portStr))
	if err != nil {
		l.Close()
		return nil, err
	}
	return &boundPort{l: l, port: port}, nil
}

func (b *boundPort) close() { b.l.Close() }
