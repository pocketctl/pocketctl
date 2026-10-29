package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

func TestAuthStatusShowsActionBeforeSessionDetails(t *testing.T) {
	i18n.Set(i18n.English)
	t.Cleanup(func() { i18n.Set(i18n.English) })
	var out bytes.Buffer
	renderDaemonStatus(&out, daemon.DaemonState{PID: 42, ConnectionStatus: "login_required", ConnectionReason: "refresh_rejected"}, 42, func(int) bool { return true })
	got := out.String()
	for _, want := range []string{"reconnect paused", "pocketctl login", "pocketctl daemon stop", "pocketctl daemon start", "pocketctl daemon service install"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if strings.Contains(got, "daemon restart") {
		t.Fatal("suggested unsupported restart command")
	}
	if at := strings.Index(got, "pocketctl login"); at < 0 || at > strings.Index(got, "Version:") {
		t.Fatal("recovery instructions must precede routine details")
	}
}

func TestAuthStatusNoticeDistinguishesRecoveryAndRetry(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	for _, lang := range []i18n.Lang{i18n.English, i18n.Chinese} {
		i18n.Set(lang)
		for _, tc := range []struct {
			status, reason, en, zh string
			login                  bool
		}{
			{"login_required", "refresh_rejected", "reconnect paused", "已暂停重连", true},
			{"stopped", "auth_storage_unavailable", "Cannot read credential storage", "无法读取凭证文件", false},
			{"stopped", "auth_persistence_failed", "could not be saved", "新凭证保存失败", true},
			{"auth_uncertain", "refresh_temporarily_unavailable", "retrying automatically", "正在自动重试", false},
			{"stopped", "auth_refresh_unavailable", "automatic refresh is unavailable", "无法自动刷新", true},
		} {
			var out bytes.Buffer
			renderDaemonStatus(&out, daemon.DaemonState{PID: 42, ConnectionStatus: tc.status, ConnectionReason: tc.reason}, 42, func(int) bool { return true })
			want := tc.en
			if lang == i18n.Chinese {
				want = tc.zh
			}
			if !strings.Contains(out.String(), want) {
				t.Errorf("missing %q: %s", want, out.String())
			}
			if strings.Contains(out.String(), "pocketctl login") != tc.login {
				t.Errorf("incorrect login advice: %s", out.String())
			}
		}
	}
}
