package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestOfferDaemonUpdate(t *testing.T) {
	for _, tc := range []struct {
		name, current, latest, input           string
		interactive, fail, wantPrompt, wantRun bool
	}{
		{"higher", "0.5.7", "v0.5.8", "y\n", true, false, true, true},
		{"default no", "0.5.7", "v0.5.8", "\n", true, false, true, false},
		{"EOF", "0.5.7", "v0.5.8", "", true, false, true, false},
		{"unterminated yes", "0.5.7", "v0.5.8", "y", true, false, true, false},
		{"same", "0.5.7", "v0.5.7", "y\n", true, false, false, false},
		{"older", "0.5.7", "v0.5.6", "y\n", true, false, false, false},
		{"unknown", "dev", "v0.5.8", "y\n", true, false, false, false},
		{"offline", "0.5.7", "v0.5.8", "y\n", true, true, false, false},
		{"pipe", "0.5.7", "v0.5.8", "y\n", false, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			ran := false
			checked := false
			err := offerDaemonUpdate(tc.current, tc.interactive, strings.NewReader(tc.input), &out, func(context.Context) (string, error) {
				checked = true
				if tc.fail {
					return "", errors.New("offline")
				}
				return tc.latest, nil
			}, func(tag string) error {
				ran = true
				if tag != tc.latest {
					t.Fatal("target not pinned")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if (out.Len() > 0) != tc.wantPrompt || ran != tc.wantRun {
				t.Fatalf("output=%q ran=%v", out.String(), ran)
			}
			if !tc.interactive && checked {
				t.Fatal("network check in noninteractive mode")
			}
		})
	}
}

func TestOfferDaemonUpdatePropagatesUpdateFailure(t *testing.T) {
	want := errors.New("sudo cancelled")
	err := offerDaemonUpdate("0.5.7", true, strings.NewReader("yes\n"), &bytes.Buffer{}, func(context.Context) (string, error) { return "v0.5.8", nil }, func(string) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("update failure hidden: %v", err)
	}
}

func TestStatusNoUpdateCheckOption(t *testing.T) {
	opts, err := parseDaemonStatusOptions([]string{"--all", "--no-update-check"}, &bytes.Buffer{})
	if err != nil || !opts.noUpdateCheck || opts.limit != 0 {
		t.Fatalf("options=%+v error=%v", opts, err)
	}
}
