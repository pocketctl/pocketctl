package session

import "golang.org/x/sys/windows"

func directoryAccess(path string) (browse, write bool) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, false
	}
	// Ntfs uses FILE_WRITE_DATA's bit for FILE_ADD_FILE on directories.
	// Asking for access on an existing handle does not create a probe file.
	const addFile = windows.FILE_WRITE_DATA
	canOpen := func(access uint32) bool {
		handle, err := windows.CreateFile(name, access,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			return false
		}
		_ = windows.CloseHandle(handle)
		return true
	}
	browse = canOpen(windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE)
	return browse, browse && canOpen(addFile|windows.FILE_TRAVERSE)
}
