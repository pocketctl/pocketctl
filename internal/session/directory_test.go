package session

import (
	"context"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestDirectoryPagingSearchAndValidation(t *testing.T) {
	root := t.TempDir()
	p, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	// macOS temp paths can include /var -> /private/var.
	root = p.Roots()[0]
	for i := 0; i < 237; i++ {
		if err := os.Mkdir(filepath.Join(root, fmt.Sprintf("project-%03d", i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(root, "not-a-directory"), []byte("x"), 0600)
	cmd := protocol.ClientMessage{Type: "list_directories", RequestID: "r1", Path: root, Limit: 100}
	first := p.DirectoryQuery(context.Background(), cmd)
	if first.Reason != "" || len(first.Directory.Entries) != 100 || first.Directory.NextCursor == "" {
		t.Fatalf("first: %+v", first)
	}
	if first.RequestID != "r1" || !first.Directory.CanSelect || first.Directory.Parent != "" {
		t.Fatal(first.Directory)
	}
	cmd.Cursor = first.Directory.NextCursor
	second := p.DirectoryQuery(context.Background(), cmd)
	if second.Reason != "" || second.Directory.Entries[0].Name != "project-100" {
		t.Fatalf("second: %+v", second)
	}
	cmd.Cursor = ""
	cmd.Query = "236"
	found := p.DirectoryQuery(context.Background(), cmd)
	if len(found.Directory.Entries) != 1 || found.Directory.Entries[0].Name != "project-236" {
		t.Fatal(found.Directory)
	}
	cmd.Cursor = first.Directory.NextCursor
	if e := p.DirectoryQuery(context.Background(), cmd); e.Reason != "stale_cursor" {
		t.Fatal(e)
	}
	cmd.Cursor = ""
	cmd.Query = ""
	cmd.Type = "validate_directory"
	if e := p.DirectoryQuery(context.Background(), cmd); e.Reason != "" {
		t.Fatal(e)
	}
}
func TestDirectoryBoundaryFallbackAndPermissions(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	p, _ := NewCwdPolicy([]string{root})
	root = p.Roots()[0]
	os.Symlink(outside, filepath.Join(root, "outside"))
	cmd := protocol.ClientMessage{Type: "list_directories", Path: filepath.Join(root, "outside")}
	if e := p.DirectoryQuery(context.Background(), cmd); e.Reason != "cwd_not_authorized" {
		t.Fatal(e)
	}
	cmd.Path = root
	e := p.DirectoryQuery(context.Background(), cmd)
	if len(e.Directory.Entries) != 1 || e.Directory.Entries[0].CanBrowse || e.Directory.Entries[0].Reason != "cwd_not_authorized" {
		t.Fatal(e.Directory)
	}
	cmd.Path = filepath.Join(root, "missing", "nested")
	cmd.Fallback = true
	e = p.DirectoryQuery(context.Background(), cmd)
	if e.Reason != "" || !e.Directory.Fallback || e.Directory.Path != root {
		t.Fatal(e)
	}
	cmd.Type = "validate_directory"
	if e = p.DirectoryQuery(context.Background(), cmd); e.Reason != "not_found" {
		t.Fatal(e)
	}
	cmd.Path = outside
	if e = p.DirectoryQuery(context.Background(), cmd); e.Reason != "cwd_not_authorized" {
		t.Fatal(e)
	}
	read := filepath.Join(root, "readonly")
	os.Mkdir(read, 0500)
	defer os.Chmod(read, 0700)
	if os.Geteuid() != 0 {
		cmd.Path = read
		cmd.Type = "list_directories"
		e = p.DirectoryQuery(context.Background(), cmd)
		if e.Reason != "" || !e.Directory.CanBrowse || e.Directory.CanSelect {
			t.Fatal(e.Directory)
		}
		cmd.Type = "validate_directory"
		if e = p.DirectoryQuery(context.Background(), cmd); e.Reason != "read_only" {
			t.Fatal(e)
		}
		if validateCwd(read) == nil {
			t.Fatal("creation accepted read-only directory")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cmd.Path = root
	cmd.Type = "list_directories"
	if e = p.DirectoryQuery(ctx, cmd); e.Reason != "timeout" {
		t.Fatal(e)
	}
}

func TestDirectoryLargeDeepAndUnicode(t *testing.T) {
	root := t.TempDir()
	p, _ := NewCwdPolicy([]string{root})
	root = p.Roots()[0]
	for i := 0; i < 10005; i++ {
		if err := os.Mkdir(filepath.Join(root, fmt.Sprintf("dir-%05d", i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	deep := filepath.Join(root, "中文 空格", ".hidden", "one", "two", "three", "four", "five", "six", "seven")
	if err := os.MkdirAll(deep, 0700); err != nil {
		t.Fatal(err)
	}
	e := p.DirectoryQuery(context.Background(), protocol.ClientMessage{Type: "list_directories", Path: root, Query: "10004", Limit: 100})
	if e.Reason != "" || len(e.Directory.Entries) != 1 || e.Directory.Entries[0].Name != "dir-10004" {
		t.Fatal(e)
	}
	e = p.DirectoryQuery(context.Background(), protocol.ClientMessage{Type: "validate_directory", Path: deep})
	if e.Reason != "" || e.Directory.Path != deep || !e.Directory.CanSelect {
		t.Fatal(e)
	}
}
