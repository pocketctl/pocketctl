package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/mail"
	"net/url"
	"strings"
	"time"
)

const maxMcpElicitationContentBytes = 64 << 10

type mcpFormSchema struct {
	Schema     string                    `json:"$schema"`
	Type       string                    `json:"type"`
	Required   []string                  `json:"required"`
	Properties map[string]mcpFieldSchema `json:"properties"`
}

type mcpFieldSchema struct {
	Type        string           `json:"type"`
	Title       string           `json:"title"`
	Description string           `json:"description"`
	Format      string           `json:"format"`
	MinLength   *uint64          `json:"minLength"`
	MaxLength   *uint64          `json:"maxLength"`
	Minimum     *float64         `json:"minimum"`
	Maximum     *float64         `json:"maximum"`
	MinItems    *uint64          `json:"minItems"`
	MaxItems    *uint64          `json:"maxItems"`
	Enum        []string         `json:"enum"`
	EnumNames   []string         `json:"enumNames"`
	OneOf       []mcpConstOption `json:"oneOf"`
	Items       *mcpEnumItems    `json:"items"`
	Default     json.RawMessage  `json:"default"`
}

type mcpConstOption struct {
	Const string `json:"const"`
	Title string `json:"title"`
}

type mcpEnumItems struct {
	Type  string           `json:"type"`
	Enum  []string         `json:"enum"`
	AnyOf []mcpConstOption `json:"anyOf"`
}

func parseMcpFormSchema(raw json.RawMessage) (mcpFormSchema, error) {
	if len(raw) == 0 || len(raw) > maxMcpElicitationContentBytes {
		return mcpFormSchema{}, fmt.Errorf("invalid MCP elicitation schema size")
	}
	var schema mcpFormSchema
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&schema); err != nil {
		return mcpFormSchema{}, fmt.Errorf("invalid MCP elicitation schema: %w", err)
	}
	if err := requireMcpJSONEOF(decoder); err != nil {
		return mcpFormSchema{}, fmt.Errorf("invalid MCP elicitation schema: %w", err)
	}
	if schema.Type != "object" || len(schema.Properties) == 0 {
		return mcpFormSchema{}, fmt.Errorf("MCP elicitation schema must be a non-empty object")
	}
	for _, name := range schema.Required {
		if _, ok := schema.Properties[name]; !ok || name == "" {
			return mcpFormSchema{}, fmt.Errorf("MCP elicitation required field %q is not defined", name)
		}
	}
	for name, field := range schema.Properties {
		if name == "" {
			return mcpFormSchema{}, fmt.Errorf("MCP elicitation field name is empty")
		}
		if err := validateMcpFieldSchema(name, field); err != nil {
			return mcpFormSchema{}, err
		}
	}
	return schema, nil
}

func validateMcpFormSchema(raw json.RawMessage) error {
	_, err := parseMcpFormSchema(raw)
	return err
}

func validateMcpFieldSchema(name string, field mcpFieldSchema) error {
	switch field.Type {
	case "string":
		if len(field.Enum) == 0 && len(field.OneOf) == 0 && field.MinLength == nil && field.MaxLength == nil && field.Format == "" {
			return nil
		}
		if field.Format != "" && field.Format != "email" && field.Format != "uri" && field.Format != "date" && field.Format != "date-time" {
			return fmt.Errorf("MCP elicitation field %q has unsupported format %q", name, field.Format)
		}
	case "number", "integer", "boolean":
		return nil
	case "array":
		if field.Items == nil || (field.Items.Type != "" && field.Items.Type != "string") || (len(field.Items.Enum) == 0 && len(field.Items.AnyOf) == 0) {
			return fmt.Errorf("MCP elicitation field %q must be a string enum array", name)
		}
	default:
		return fmt.Errorf("MCP elicitation field %q has unsupported type %q", name, field.Type)
	}
	return nil
}

func validateMcpFormContent(rawSchema, rawContent json.RawMessage) error {
	schema, err := parseMcpFormSchema(rawSchema)
	if err != nil {
		return err
	}
	if len(rawContent) == 0 || len(rawContent) > maxMcpElicitationContentBytes {
		return fmt.Errorf("invalid MCP elicitation content size")
	}
	decoder := json.NewDecoder(bytes.NewReader(rawContent))
	decoder.UseNumber()
	var content map[string]any
	if err := decoder.Decode(&content); err != nil || content == nil {
		return fmt.Errorf("MCP elicitation content must be an object")
	}
	if err := requireMcpJSONEOF(decoder); err != nil {
		return fmt.Errorf("MCP elicitation content must contain one object")
	}
	for _, name := range schema.Required {
		if value, ok := content[name]; !ok || value == nil {
			return fmt.Errorf("MCP elicitation field %q is required", name)
		}
	}
	for name, value := range content {
		field, ok := schema.Properties[name]
		if !ok {
			return fmt.Errorf("unknown MCP elicitation field %q", name)
		}
		if err := validateMcpFieldValue(name, field, value); err != nil {
			return err
		}
	}
	return nil
}

func requireMcpJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return err
	}
	return nil
}

func validateMcpElicitationURL(value string) error {
	parsed, err := url.ParseRequestURI(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("MCP elicitation URL must be an absolute HTTP(S) URL")
	}
	return nil
}

func validateMcpFieldValue(name string, field mcpFieldSchema, value any) error {
	switch field.Type {
	case "string":
		text, ok := value.(string)
		if !ok {
			return fmt.Errorf("MCP elicitation field %q must be a string", name)
		}
		length := uint64(len([]rune(text)))
		if field.MinLength != nil && length < *field.MinLength || field.MaxLength != nil && length > *field.MaxLength {
			return fmt.Errorf("MCP elicitation field %q has invalid length", name)
		}
		allowed := field.Enum
		if len(allowed) == 0 {
			for _, option := range field.OneOf {
				allowed = append(allowed, option.Const)
			}
		}
		if len(allowed) > 0 && !containsString(allowed, text) {
			return fmt.Errorf("MCP elicitation field %q has an invalid option", name)
		}
		if err := validateMcpStringFormat(field.Format, text); err != nil {
			return fmt.Errorf("MCP elicitation field %q has an invalid %s value", name, field.Format)
		}
	case "number", "integer":
		number, ok := value.(json.Number)
		if !ok {
			return fmt.Errorf("MCP elicitation field %q must be numeric", name)
		}
		parsed, err := number.Float64()
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || field.Type == "integer" && math.Trunc(parsed) != parsed {
			return fmt.Errorf("MCP elicitation field %q has an invalid number", name)
		}
		if field.Minimum != nil && parsed < *field.Minimum || field.Maximum != nil && parsed > *field.Maximum {
			return fmt.Errorf("MCP elicitation field %q is out of range", name)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("MCP elicitation field %q must be boolean", name)
		}
	case "array":
		values, ok := value.([]any)
		if !ok {
			return fmt.Errorf("MCP elicitation field %q must be an array", name)
		}
		length := uint64(len(values))
		if field.MinItems != nil && length < *field.MinItems || field.MaxItems != nil && length > *field.MaxItems {
			return fmt.Errorf("MCP elicitation field %q has an invalid item count", name)
		}
		allowed := field.Items.Enum
		if len(allowed) == 0 {
			for _, option := range field.Items.AnyOf {
				allowed = append(allowed, option.Const)
			}
		}
		seen := make(map[string]struct{}, len(values))
		for _, value := range values {
			text, ok := value.(string)
			if !ok || !containsString(allowed, text) {
				return fmt.Errorf("MCP elicitation field %q has an invalid option", name)
			}
			if _, duplicate := seen[text]; duplicate {
				return fmt.Errorf("MCP elicitation field %q contains a duplicate option", name)
			}
			seen[text] = struct{}{}
		}
	default:
		return fmt.Errorf("MCP elicitation field %q has unsupported type %q", name, field.Type)
	}
	return nil
}

func validateMcpStringFormat(format, value string) error {
	switch format {
	case "":
		return nil
	case "email":
		address, err := mail.ParseAddress(value)
		if err != nil || address.Address != value {
			return fmt.Errorf("invalid email")
		}
		return nil
	case "uri":
		parsed, err := url.ParseRequestURI(value)
		if err != nil || parsed.Scheme == "" {
			return fmt.Errorf("invalid URI")
		}
		return nil
	case "date":
		_, err := time.Parse("2006-01-02", value)
		return err
	case "date-time":
		_, err := time.Parse(time.RFC3339, value)
		return err
	default:
		return fmt.Errorf("unsupported format")
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if strings.Compare(value, target) == 0 {
			return true
		}
	}
	return false
}
