package usageanalytics

import (
	"errors"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func Normalize(u protocol.ContextUsage, semantics string) (protocol.ContextUsage, error) {
	if u.InputTokens < 0 || u.OutputTokens < 0 || u.CacheRead < 0 || u.CacheCreate < 0 {
		return u, errors.New("negative_usage")
	}
	switch semantics {
	case "includes_cache":
		if u.InputTokens < u.CacheRead+u.CacheCreate {
			return u, errors.New("invalid_inclusive_cache")
		}
		u.InputTokens -= u.CacheRead + u.CacheCreate
	case "excludes_cache":
	default:
		return u, errors.New("unknown_semantics")
	}
	u.TotalTokens = u.InputTokens + u.OutputTokens + u.CacheRead + u.CacheCreate
	return u, nil
}
