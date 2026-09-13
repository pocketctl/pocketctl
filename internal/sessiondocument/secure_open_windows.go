//go:build windows

package sessiondocument

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func windowsFinalPath(handle windows.Handle) (string, error) {
	const normalizedDOSPath = 0
	needed, err := windows.GetFinalPathNameByHandle(handle, nil, 0, normalizedDOSPath)
	if err != nil && needed == 0 {
		return "", err
	}
	buffer := make([]uint16, needed+1)
	length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), normalizedDOSPath)
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(windows.UTF16ToString(buffer[:length]), `\\?\`), nil
}

func insideWindowsRoot(root, target string) bool {
	rel, err := filepath.Rel(strings.ToLower(root), strings.ToLower(target))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, `..\`)
}

func secureOpenRegular(root, relativePath string) (*os.File, error) {
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("canonical root: %w", err)
	}
	current := canonicalRoot
	for _, segment := range strings.Split(relativePath, string(filepath.Separator)) {
		if segment == "" || segment == "." || segment == ".." {
			return nil, errUnsafePath
		}
		current = filepath.Join(current, segment)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			return nil, fmt.Errorf("secure path component: %w", statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errUnsafePath
		}
	}
	pointer, err := windows.UTF16PtrFromString(current)
	if err != nil {
		return nil, errUnsafePath
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, fmt.Errorf("secure open: %w", err)
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		windows.CloseHandle(handle)
		return nil, fmt.Errorf("stat opened document: %w", err)
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, errUnsafePath
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		windows.CloseHandle(handle)
		return nil, errNonRegular
	}
	finalPath, err := windowsFinalPath(handle)
	if err != nil || !insideWindowsRoot(canonicalRoot, finalPath) {
		windows.CloseHandle(handle)
		return nil, errUnsafePath
	}
	return os.NewFile(uintptr(handle), "session-document"), nil
}
