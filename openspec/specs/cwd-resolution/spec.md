## ADDED Requirements

### Requirement: CWD path resolution with tilde support
The Daemon SHALL resolve the working directory path before starting a session process. The resolution rules SHALL be:
- Empty string `""` → `os.UserHomeDir()`
- `"~"` → `os.UserHomeDir()`
- `"~/"` followed by a path → `filepath.Join(os.UserHomeDir(), path)`
- Any other value → used as-is (absolute path expected)

#### Scenario: Empty CWD defaults to home directory
- **WHEN** a `session_create` request arrives with `cwd: ""`
- **THEN** the Daemon resolves cwd to the current user's home directory (e.g., `/Users/muwenbin`)
- **AND** the session process starts with that resolved directory

#### Scenario: Tilde CWD defaults to home directory
- **WHEN** a `session_create` request arrives with `cwd: "~"`
- **THEN** the Daemon resolves cwd to the current user's home directory
- **AND** the session process starts with that resolved directory

#### Scenario: Tilde-relative CWD resolves to home subdirectory
- **WHEN** a `session_create` request arrives with `cwd: "~/projects/myapp"`
- **THEN** the Daemon resolves cwd to `/Users/muwenbin/projects/myapp`
- **AND** the session process starts with that resolved directory

#### Scenario: Absolute CWD used as-is
- **WHEN** a `session_create` request arrives with `cwd: "/opt/workspace/myapp"`
- **THEN** the Daemon uses `/opt/workspace/myapp` without modification
- **AND** the session process starts with that directory (subject to permission validation)

### Requirement: CWD permission validation
The Daemon SHALL validate the resolved working directory before starting a session process. The validation SHALL check: (1) the path exists, (2) the path is a directory (not a file), (3) the directory is readable and writable. If any check fails, the Daemon SHALL reject the session creation with an error event.

#### Scenario: Directory does not exist
- **WHEN** the resolved cwd path does not exist on the filesystem
- **THEN** the Daemon returns an error event: `{ type: "error", error: "工作目录不存在: /path" }`
- **AND** no session process is started

#### Scenario: Path is a file, not a directory
- **WHEN** the resolved cwd path exists but is a regular file
- **THEN** the Daemon returns an error event: `{ type: "error", error: "工作目录不是目录: /path" }`
- **AND** no session process is started

#### Scenario: Directory is not accessible
- **WHEN** the resolved cwd path exists and is a directory, but the current user lacks read/write permission
- **THEN** the Daemon returns an error event: `{ type: "error", error: "工作目录无权限: /path" }`
- **AND** no session process is started

#### Scenario: Directory is valid and accessible
- **WHEN** the resolved cwd path exists, is a directory, and the current user has read/write permission
- **THEN** the session creation proceeds normally

### Requirement: CWD resolution function
The Daemon SHALL provide a `resolveCwd(cwd string) string` function that implements the path resolution rules. This function SHALL be called in `CreateSession` before setting `cmd.Dir` and before performing permission validation.

#### Scenario: resolveCwd returns home for empty input
- **WHEN** `resolveCwd("")` is called
- **THEN** the function returns `os.UserHomeDir()`

#### Scenario: resolveCwd returns home for tilde
- **WHEN** `resolveCwd("~")` is called
- **THEN** the function returns `os.UserHomeDir()`

#### Scenario: resolveCwd joins home with relative path
- **WHEN** `resolveCwd("~/projects")` is called and home is `/Users/muwenbin`
- **THEN** the function returns `/Users/muwenbin/projects`

#### Scenario: resolveCwd passes through absolute path
- **WHEN** `resolveCwd("/opt/workspace")` is called
- **THEN** the function returns `/opt/workspace`
