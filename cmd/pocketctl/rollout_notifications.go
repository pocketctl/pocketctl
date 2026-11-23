package main

import (
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// Rollout notifications only wake the existing sequential tailer. Its cursor and
// periodic poll remain authoritative if the OS coalesces or drops a notification.
type rolloutNotifications struct {
	watcher *fsnotify.Watcher
	mu      sync.Mutex
	files   map[string]chan struct{}
}

func newRolloutNotifications() (*rolloutNotifications, error) {
	fs, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	n := &rolloutNotifications{watcher: fs, files: make(map[string]chan struct{})}
	go func() {
		for {
			select {
			case event, ok := <-fs.Events:
				if !ok {
					return
				}
				if event.Has(fsnotify.Write) {
					n.mu.Lock()
					select {
					case n.files[event.Name] <- struct{}{}:
					default:
					}
					n.mu.Unlock()
				}
			case _, ok := <-fs.Errors:
				if !ok {
					return
				}
				// Every registered file is also polled.
			}
		}
	}()
	return n, nil
}

func (n *rolloutNotifications) subscribe(path string) (<-chan struct{}, func()) {
	path = filepath.Clean(path)
	n.mu.Lock()
	if n.files[path] != nil {
		n.mu.Unlock()
		return nil, func() {}
	}
	wake := make(chan struct{}, 1)
	n.files[path] = wake
	n.mu.Unlock()

	forget := func() {
		n.mu.Lock()
		delete(n.files, path)
		n.mu.Unlock()
	}
	if err := n.watcher.Add(path); err != nil {
		forget()
		return nil, func() {}
	}
	// A write notification may already be queued by Add.
	select {
	case wake <- struct{}{}:
	default:
	}
	return wake, func() {
		_ = n.watcher.Remove(path)
		forget()
	}
}
