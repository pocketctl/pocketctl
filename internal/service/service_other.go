//go:build !darwin && !linux

package service

// Install is unsupported on platforms without a known supervisor backend.
func Install(_ Config) error { return ErrUnsupported }

// Uninstall is unsupported on platforms without a known supervisor backend.
func Uninstall() error { return ErrUnsupported }

// Status is unsupported on platforms without a known supervisor backend.
func Status() (Info, error) { return Info{}, ErrUnsupported }
