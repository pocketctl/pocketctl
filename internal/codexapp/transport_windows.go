//go:build windows

package codexapp

import (
	"context"
	"errors"
)

func DialUnix(context.Context, string) (*Client, error) {
	return nil, errors.New("Codex Unix socket transport is unavailable on Windows")
}
