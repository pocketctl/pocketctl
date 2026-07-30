package i18n

import (
	"os"
	"strings"
	"testing"
)

// withLocales sets the locale env vars for a test and restores them after.
func withLocales(t *testing.T, set map[string]string) {
	t.Helper()
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		t.Setenv(k, "")
	}
	for k, v := range set {
		os.Setenv(k, v)
	}
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want Lang
	}{
		{"zh_CN.UTF-8", map[string]string{"LANG": "zh_CN.UTF-8"}, Chinese},
		{"zh_TW.UTF-8", map[string]string{"LANG": "zh_TW.UTF-8"}, Chinese},
		{"zh_Hans_CN", map[string]string{"LANG": "zh_Hans_CN"}, Chinese},
		{"en_US.UTF-8", map[string]string{"LANG": "en_US.UTF-8"}, English},
		{"C", map[string]string{"LANG": "C"}, English},
		{"empty", map[string]string{}, English},
		// POSIX precedence: LC_ALL overrides LANG.
		{"LC_ALL zh overrides LANG en", map[string]string{"LC_ALL": "zh_CN.UTF-8", "LANG": "en_US.UTF-8"}, Chinese},
		// First non-empty variable wins: a non-zh LC_ALL must NOT fall through to LANG.
		{"non-zh LC_ALL blocks LANG", map[string]string{"LC_ALL": "C", "LANG": "zh_CN.UTF-8"}, English},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withLocales(t, c.env)
			if got := detect(); got != c.want {
				t.Errorf("detect() = %v, want %v", got, c.want)
			}
		})
	}
}

func TestCurrentCode(t *testing.T) {
	t.Cleanup(func() { Set(English) })

	tests := []struct {
		name string
		lang Lang
		want string
	}{
		{name: "Chinese", lang: Chinese, want: "zh"},
		{name: "English", lang: English, want: "en"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			Set(tt.lang)
			if got := CurrentCode(); got != tt.want {
				t.Fatalf("CurrentCode() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestT_HitsEnglishTemplate(t *testing.T) {
	Set(English)
	got := T("daemon.started", "abc", 123)
	want := "pocketctl daemon started (ID: abc, PID: 123)"
	if got != want {
		t.Errorf("T(daemon.started) = %q, want %q", got, want)
	}
}

func TestT_HitsChineseTemplate(t *testing.T) {
	Set(Chinese)
	got := T("daemon.started", "abc", 123)
	want := "pocketctl 守护进程已启动 (ID: abc, PID: 123)"
	if got != want {
		t.Errorf("T(daemon.started) = %q, want %q", got, want)
	}
}

func TestT_NoArgsReturnsTemplateAsIs(t *testing.T) {
	Set(English)
	got := T("error.generic")
	if got != "error: %v" {
		t.Errorf("T(error.generic) = %q, want %q", got, "error: %v")
	}
}

func TestT_UnknownKeyFallsBackToLiteral(t *testing.T) {
	Set(English)
	// Unknown key with no args: returned verbatim.
	if got := T("nonexistent.key"); got != "nonexistent.key" {
		t.Errorf("unknown key no args = %q, want key itself", got)
	}
	// Unknown key with args: treated as a literal template. The key carries a
	// verb on purpose; pass it via a variable so `go vet` doesn't flag it as a
	// possible Printf misuse in a non-printf call.
	unknownKey := "literal %s here"
	got := T(unknownKey, "X")
	if got != "literal X here" {
		t.Errorf("unknown key with args = %q, want %q", got, "literal X here")
	}
}

// verbCount counts fmt.Sprintf verb placeholders (%s, %d, %v, %w, %f, %t …)
// in a template string, ignoring "%%".
func verbCount(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+1 < len(s) {
			if s[i+1] == '%' {
				i++
				continue
			}
			// Skip flags/width/precision until the verb letter.
			j := i + 1
			for j < len(s) && strings.IndexByte("+-#. 0123456789", s[j]) >= 0 {
				j++
			}
			if j < len(s) && strings.IndexByte("vdgGeEftsxXbcqoU", s[j]) >= 0 {
				n++
			}
		}
	}
	return n
}

func TestAllKeysHaveBothLangsAndMatchingVerbs(t *testing.T) {
	for key, m := range messages {
		if strings.TrimSpace(m.en) == "" {
			t.Errorf("key %q: English template is empty", key)
		}
		if strings.TrimSpace(m.zh) == "" {
			t.Errorf("key %q: Chinese template is empty", key)
		}
		if ve, vz := verbCount(m.en), verbCount(m.zh); ve != vz {
			t.Errorf("key %q: verb count mismatch (en=%d, zh=%d)\n  en: %s\n  zh: %s", key, ve, vz, m.en, m.zh)
		}
	}
}

func TestDaemonAndServiceRecoveryStatusesAreLocalized(t *testing.T) {
	t.Cleanup(func() { Set(English) })
	for _, tt := range []struct {
		lang Lang
		want []string
	}{
		{English, []string{"authentication uncertain", "Supervisor is not loaded"}},
		{Chinese, []string{"身份验证状态不确定", "系统服务未加载"}},
	} {
		Set(tt.lang)
		got := []string{T("status.auth_uncertain"), T("service.supervisor_unloaded")}
		for i, want := range tt.want {
			if got[i] != want {
				t.Fatalf("lang=%v got=%q want=%q", tt.lang, got[i], want)
			}
		}
	}
}

func TestDaemonStatusUncertaintyHasBothLanguages(t *testing.T) {
	t.Cleanup(func() { Set(English) })
	for _, tt := range []struct {
		lang Lang
		want string
	}{
		{English, "Daemon status cannot be confirmed: owner metadata missing"},
		{Chinese, "无法确认 Daemon 状态：owner metadata missing"},
	} {
		Set(tt.lang)
		if got := T("daemon.status_uncertain", "owner metadata missing"); got != tt.want {
			t.Fatalf("lang=%v got=%q want=%q", tt.lang, got, tt.want)
		}
	}
}

func TestKeyNamingConvention(t *testing.T) {
	for key := range messages {
		// Special exception: literal-fallback style keys (with spaces) are
		// allowed only if they are not registered (they aren't, by
		// definition). Registered keys must follow namespace.name.
		parts := strings.SplitN(key, ".", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			t.Errorf("key %q does not follow <namespace>.<name> convention", key)
		}
	}
}

func TestHelpDocumentsOpenCodeAgentControl(t *testing.T) {
	t.Cleanup(func() { Set(English) })
	for _, lang := range []Lang{English, Chinese} {
		Set(lang)
		help := T("help.body")
		for _, text := range []string{"agent opencode", "enable", "disable", "status", "--no-agent-prompt", "opencode --native"} {
			if !strings.Contains(help, text) {
				t.Fatalf("lang=%v help missing %q", lang, text)
			}
		}
	}
}
