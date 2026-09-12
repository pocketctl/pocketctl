//go:build !windows

package sessiondocument

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func secureOpenRegular(root, relativePath string) (*os.File, error) {
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("canonical root: %w", err)
	}
	rootFD, err := unix.Open(canonicalRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open root: %w", err)
	}
	defer unix.Close(rootFD)

	segments := strings.Split(relativePath, string(filepath.Separator))
	currentFD := rootFD
	for index, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return nil, errUnsafePath
		}
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if index < len(segments)-1 {
			flags |= unix.O_DIRECTORY
		}
		fd, openErr := unix.Openat(currentFD, segment, flags, 0)
		if currentFD != rootFD {
			_ = unix.Close(currentFD)
		}
		if openErr != nil {
			if openErr == unix.ELOOP || openErr == unix.ENOTDIR {
				return nil, errUnsafePath
			}
			return nil, fmt.Errorf("secure open: %w", openErr)
		}
		currentFD = fd
	}

	var stat unix.Stat_t
	if err := unix.Fstat(currentFD, &stat); err != nil {
		_ = unix.Close(currentFD)
		return nil, fmt.Errorf("stat opened document: %w", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		_ = unix.Close(currentFD)
		return nil, errNonRegular
	}
	return os.NewFile(uintptr(currentFD), "session-document"), nil
}
