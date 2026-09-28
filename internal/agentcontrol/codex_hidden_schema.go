package agentcontrol

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// Generated schema output is a concatenation of standalone JSON documents.
// Hidden history needs a correlated request contract, not a method mention:
// inject raw Responses items, then start a turn with ordinary UserInput.
func supportsCodexHiddenContextSchema(raw []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var requests, responses []codexSchemaNode
	for {
		var document map[string]any
		if err := decoder.Decode(&document); err != nil {
			if err != io.EOF {
				return false
			}
			break
		}
		if document == nil {
			return false
		}
		collectCodexSchemaNodes(document, document, "", &requests, &responses)
	}
	responseOK := false
	for _, response := range responses {
		node := response.node
		if node["type"] == "object" && len(schemaMap(node["properties"])) == 0 && len(schemaList(node["required"])) == 0 {
			responseOK = true
		}
	}
	if !responseOK {
		return false
	}
	for _, request := range requests {
		inject := request.methodParams("thread/inject_items")
		start := request.methodParams("turn/start")
		if !schemaObjectRequired(inject, "threadId", "items") || !schemaObjectRequired(start, "threadId", "input") {
			continue
		}
		injectProps, startProps := schemaMap(inject["properties"]), schemaMap(start["properties"])
		items, input := schemaMap(injectProps["items"]), schemaMap(startProps["input"])
		if schemaMap(injectProps["threadId"])["type"] != "string" || items["type"] != "array" || items["items"] != true || schemaMap(startProps["threadId"])["type"] != "string" || input["type"] != "array" {
			continue
		}
		userInput := request.resolve(schemaMap(input["items"]))
		for _, variant := range schemaList(userInput["oneOf"]) {
			text := request.resolve(schemaMap(variant))
			props := schemaMap(text["properties"])
			if schemaObjectRequired(text, "type", "text") && schemaStringValue(schemaMap(props["type"]), "text") && schemaMap(props["text"])["type"] == "string" {
				return true
			}
		}
	}
	return false
}

type codexSchemaNode struct{ root, node map[string]any }

func collectCodexSchemaNodes(root, node map[string]any, name string, requests, responses *[]codexSchemaNode) {
	if node["title"] == "ClientRequest" || name == "ClientRequest" {
		*requests = append(*requests, codexSchemaNode{root, node})
	}
	if node["title"] == "ThreadInjectItemsResponse" || name == "ThreadInjectItemsResponse" {
		*responses = append(*responses, codexSchemaNode{root, node})
	}
	for key, value := range node {
		if child, ok := value.(map[string]any); ok {
			collectCodexSchemaNodes(root, child, key, requests, responses)
		} else if children, ok := value.([]any); ok {
			for _, value := range children {
				if child, ok := value.(map[string]any); ok {
					collectCodexSchemaNodes(root, child, "", requests, responses)
				}
			}
		}
	}
}

func (n codexSchemaNode) resolve(node map[string]any) map[string]any {
	for depth := 0; depth < 16; depth++ {
		ref, ok := node["$ref"].(string)
		if !ok {
			return node
		}
		if !strings.HasPrefix(ref, "#/") {
			return nil
		}
		var value any = n.root
		for _, segment := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			segment = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
			value = schemaMap(value)[segment]
		}
		node = schemaMap(value)
		if node == nil {
			return nil
		}
	}
	return nil
}

func (n codexSchemaNode) methodParams(method string) map[string]any {
	for _, value := range schemaList(n.node["oneOf"]) {
		variant := n.resolve(schemaMap(value))
		props := schemaMap(variant["properties"])
		if schemaStringValue(schemaMap(props["method"]), method) && schemaObjectRequired(variant, "id", "method", "params") {
			return n.resolve(schemaMap(props["params"]))
		}
	}
	return nil
}

func schemaObjectRequired(node map[string]any, fields ...string) bool {
	if node["type"] != "object" {
		return false
	}
	required := schemaList(node["required"])
	if len(required) != len(fields) {
		return false
	}
	seen := make(map[string]bool, len(fields))
	for _, value := range required {
		field, ok := value.(string)
		if !ok || seen[field] {
			return false
		}
		seen[field] = true
	}
	for _, field := range fields {
		if !seen[field] {
			return false
		}
	}
	return true
}

func schemaStringValue(node map[string]any, want string) bool {
	if node["type"] != "string" {
		return false
	}
	if value, ok := node["const"].(string); ok {
		return value == want
	}
	values := schemaList(node["enum"])
	return len(values) == 1 && values[0] == want
}

func schemaMap(value any) map[string]any { node, _ := value.(map[string]any); return node }
func schemaList(value any) []any         { list, _ := value.([]any); return list }
