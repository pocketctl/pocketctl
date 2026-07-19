package codexapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

type RequestID struct {
	raw []byte
}

func (id *RequestID) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return errors.New("request ID is empty")
	}
	if raw[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		id.raw = append(id.raw[:0], raw...)
		return nil
	}
	if _, err := strconv.ParseInt(string(raw), 10, 64); err != nil {
		return errors.New("request ID must be a string or signed integer")
	}
	id.raw = append(id.raw[:0], raw...)
	return nil
}

func (id RequestID) MarshalJSON() ([]byte, error) {
	if len(id.raw) == 0 {
		return nil, errors.New("request ID is empty")
	}
	return append([]byte(nil), id.raw...), nil
}

func (id RequestID) Key() string {
	if len(id.raw) > 0 && id.raw[0] == '"' {
		var value string
		_ = json.Unmarshal(id.raw, &value)
		return "s:" + value
	}
	return "n:" + string(id.raw)
}

func numberID(value int64) RequestID {
	return RequestID{raw: []byte(strconv.FormatInt(value, 10))}
}
