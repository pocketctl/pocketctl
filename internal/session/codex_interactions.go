package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	codexApprovalCommand     = "commandExecution"
	codexApprovalFile        = "fileChange"
	codexApprovalPermissions = "permissions"
	codexQuestion            = "requestUserInput"
	codexMcpElicitation      = "mcpElicitation"
)

type codexPendingInteraction struct {
	publicID          string
	nativeKey         string
	threadID          string
	turnID            string
	kind              string
	method            string
	requestID         codexapp.RequestID
	available         map[string]struct{}
	permissions       json.RawMessage
	questions         []codexPendingQuestion
	hasSecret         bool
	elicitationMode   string
	elicitationSchema json.RawMessage
}

type codexPendingQuestion struct {
	id   string
	info protocol.QuestionInfo
}

type codexDeferredStatus struct {
	status   string
	revision uint64
}

type codexThreadSequencer struct {
	mu      sync.Mutex
	cond    *sync.Cond
	next    uint64
	serving uint64
}

func newCodexThreadSequencer() *codexThreadSequencer {
	sequencer := &codexThreadSequencer{}
	sequencer.cond = sync.NewCond(&sequencer.mu)
	return sequencer
}

type codexInteractions struct {
	sm         *SessionManager
	generation uint64
	client     codexRuntimeClient

	mu                  sync.Mutex
	pendingByPublic     map[string]*codexPendingInteraction
	pendingByNative     map[string]*codexPendingInteraction
	resolvedPublic      map[string]string
	resolvedNative      map[string]struct{}
	deferredStatus      map[string]codexDeferredStatus
	resolvingByThread   map[string]int
	lifecycleRevision   map[string]uint64
	sequencerMu         sync.Mutex
	sequencers          map[string]*codexThreadSequencer
	publicationGate     sync.Mutex
	closed              atomic.Bool
	done                chan struct{}
	closeOnce           sync.Once
	beforeLifecycleEmit func(protocol.DaemonEvent)
	afterSendBlocked    func()
}

func newCodexInteractions(sm *SessionManager, generation uint64, client codexRuntimeClient) *codexInteractions {
	return &codexInteractions{
		sm: sm, generation: generation, client: client,
		pendingByPublic: make(map[string]*codexPendingInteraction),
		pendingByNative: make(map[string]*codexPendingInteraction),
		resolvedPublic:  make(map[string]string), resolvedNative: make(map[string]struct{}),
		deferredStatus:    make(map[string]codexDeferredStatus),
		resolvingByThread: make(map[string]int),
		lifecycleRevision: make(map[string]uint64),
		sequencers:        make(map[string]*codexThreadSequencer),
		done:              make(chan struct{}),
	}
}

func (sm *SessionManager) codexInteractionBroker() *codexInteractions {
	sm.mu.RLock()
	provider := sm.codexProvider
	sm.mu.RUnlock()
	if provider == nil || provider.coordinator == nil {
		return nil
	}
	return provider.coordinator.interactionBroker()
}

func (c *codexInteractions) Handle(message codexapp.Inbound) {
	if message.ID == nil {
		if message.Method == "serverRequest/resolved" {
			c.handleResolved(message.Params)
		}
		return
	}
	switch message.Method {
	case "item/commandExecution/requestApproval":
		c.handleApproval(message, codexApprovalCommand)
	case "item/fileChange/requestApproval":
		c.handleApproval(message, codexApprovalFile)
	case "item/permissions/requestApproval":
		c.handleApproval(message, codexApprovalPermissions)
	case "item/tool/requestUserInput":
		c.handleQuestion(message)
	case "mcpServer/elicitation/request":
		c.handleMcpElicitation(message)
	}
}

func (c *codexInteractions) handleMcpElicitation(message codexapp.Inbound) {
	var params struct {
		ThreadID        string          `json:"threadId"`
		TurnID          string          `json:"turnId"`
		ServerName      string          `json:"serverName"`
		Mode            string          `json:"mode"`
		Message         string          `json:"message"`
		ElicitationID   string          `json:"elicitationId"`
		URL             string          `json:"url"`
		RequestedSchema json.RawMessage `json:"requestedSchema"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" || message.ID == nil {
		return
	}
	// openai/form is intentionally not forwarded: its schema is provider
	// specific and cannot be safely validated by every Pocketctl client.
	if params.Mode != "form" && params.Mode != "url" {
		return
	}
	if params.Mode == "form" {
		if err := validateMcpFormSchema(params.RequestedSchema); err != nil {
			return
		}
	} else if err := validateMcpElicitationURL(params.URL); err != nil {
		return
	}
	pending := &codexPendingInteraction{
		threadID: params.ThreadID, turnID: params.TurnID, kind: codexMcpElicitation,
		method: message.Method, requestID: *message.ID, elicitationMode: params.Mode,
		elicitationSchema: append(json.RawMessage(nil), params.RequestedSchema...),
	}
	release, open := c.beginLifecycle(params.ThreadID)
	if !open {
		return
	}
	defer release()
	if !c.addPending(pending) {
		return
	}
	event := protocol.DaemonEvent{
		Type: "mcp_elicitation_request", SessionID: params.ThreadID, RequestID: pending.publicID,
		MCPServer: params.ServerName, ElicitationMode: params.Mode, ElicitationID: params.ElicitationID,
		Message: params.Message, URL: params.URL, ElicitationSchema: append(json.RawMessage(nil), params.RequestedSchema...),
	}
	c.publishPendingTransition(params.ThreadID, protocol.StatusWaitingQuestion, event)
}

func (c *codexInteractions) handleApproval(message codexapp.Inbound, kind string) {
	var params struct {
		ThreadID           string            `json:"threadId"`
		TurnID             string            `json:"turnId"`
		ItemID             string            `json:"itemId"`
		Command            *string           `json:"command"`
		Cwd                string            `json:"cwd"`
		Reason             *string           `json:"reason"`
		GrantRoot          *string           `json:"grantRoot"`
		AvailableDecisions []json.RawMessage `json:"availableDecisions"`
		Permissions        json.RawMessage   `json:"permissions"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" || message.ID == nil {
		return
	}
	available := approvalDecisions(kind, params.AvailableDecisions)
	pending := &codexPendingInteraction{
		threadID: params.ThreadID, turnID: params.TurnID, kind: kind, method: message.Method,
		requestID: *message.ID, available: make(map[string]struct{}), permissions: append(json.RawMessage(nil), params.Permissions...),
	}
	for _, decision := range available {
		pending.available[decision] = struct{}{}
	}
	release, open := c.beginLifecycle(params.ThreadID)
	if !open {
		return
	}
	defer release()
	if !c.addPending(pending) {
		return
	}
	description := ""
	if params.Reason != nil {
		description = *params.Reason
	}
	command := ""
	if params.Command != nil {
		command = *params.Command
	}
	files := []string(nil)
	if params.GrantRoot != nil && *params.GrantRoot != "" {
		files = []string{*params.GrantRoot}
	}
	event := protocol.DaemonEvent{
		Type: "approval_request", SessionID: params.ThreadID, RequestID: pending.publicID,
		ApprovalKind: kind, AvailableDecisions: available, Tool: kind, CallID: params.ItemID,
		Command: command, Cwd: params.Cwd, Description: description, Files: files,
	}
	if kind == codexApprovalPermissions && len(params.Permissions) > 0 {
		event.Input = append(json.RawMessage(nil), params.Permissions...)
	}
	c.publishPendingTransition(params.ThreadID, protocol.StatusWaitingApproval, event)
}

func (c *codexInteractions) handleQuestion(message codexapp.Inbound) {
	var params struct {
		ThreadID         string `json:"threadId"`
		TurnID           string `json:"turnId"`
		ItemID           string `json:"itemId"`
		AutoResolutionMs uint64 `json:"autoResolutionMs"`
		Questions        []struct {
			ID       string `json:"id"`
			Header   string `json:"header"`
			Question string `json:"question"`
			IsOther  bool   `json:"isOther"`
			IsSecret bool   `json:"isSecret"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ThreadID == "" || len(params.Questions) == 0 || message.ID == nil {
		return
	}
	pending := &codexPendingInteraction{
		threadID: params.ThreadID, turnID: params.TurnID, kind: codexQuestion,
		method: message.Method, requestID: *message.ID,
	}
	questions := make([]protocol.QuestionInfo, 0, len(params.Questions))
	for _, question := range params.Questions {
		info := protocol.QuestionInfo{
			ID: question.ID, Header: question.Header, Question: question.Question,
			Custom: question.IsOther || len(question.Options) == 0, Secret: question.IsSecret,
		}
		for _, option := range question.Options {
			info.Options = append(info.Options, protocol.QuestionOption{Label: option.Label, Description: option.Description})
		}
		pending.questions = append(pending.questions, codexPendingQuestion{id: question.ID, info: info})
		pending.hasSecret = pending.hasSecret || question.IsSecret
		questions = append(questions, info)
	}
	release, open := c.beginLifecycle(params.ThreadID)
	if !open {
		return
	}
	defer release()
	if !c.addPending(pending) {
		return
	}
	event := protocol.DaemonEvent{
		Type: "question_request", SessionID: params.ThreadID, RequestID: pending.publicID,
		Questions: questions, CallID: params.ItemID, AutoResolutionMs: params.AutoResolutionMs,
	}
	c.publishPendingTransition(params.ThreadID, protocol.StatusWaitingQuestion, event)
}

func (c *codexInteractions) addPending(pending *codexPendingInteraction) bool {
	pending.nativeKey = c.nativeKey(pending.threadID, pending.requestID)
	pending.publicID = c.publicID(pending.nativeKey)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed.Load() {
		return false
	}
	if _, resolved := c.resolvedNative[pending.nativeKey]; resolved {
		return false
	}
	if _, exists := c.pendingByNative[pending.nativeKey]; exists {
		return false
	}
	c.pendingByNative[pending.nativeKey] = pending
	c.pendingByPublic[pending.threadID+"\x00"+pending.publicID] = pending
	c.lifecycleRevision[pending.threadID]++
	return true
}

func (c *codexInteractions) ResolveApproval(_ context.Context, threadID, publicID, action string) error {
	release, open := c.beginLifecycle(threadID)
	if !open {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	defer release()
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return fmt.Errorf("Codex interaction broker is closed")
	}
	pending, ok := c.pendingByPublic[threadID+"\x00"+publicID]
	if !ok || !isCodexApprovalKind(pending.kind) {
		_, resolved := c.resolvedPublic[threadID+"\x00"+publicID]
		c.mu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: publicID}
		}
		return fmt.Errorf("Codex approval request is not pending")
	}
	result, approved, err := codexApprovalResponse(pending, action)
	if err != nil {
		c.mu.Unlock()
		return err
	}
	c.markResolvingLocked(pending)
	c.mu.Unlock()
	if err := c.client.Respond(pending.requestID, result, nil); err != nil {
		c.restoreAfterWriteFailure(pending)
		return err
	}
	if c.closed.Load() {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	c.publishEvent(protocol.DaemonEvent{
		Type: "approval_resolved", SessionID: threadID, RequestID: publicID,
		Action: action, Approved: approved,
	})
	c.finishResolution(threadID)
	return nil
}

func (c *codexInteractions) KnowsApproval(threadID, publicID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := threadID + "\x00" + publicID
	if pending := c.pendingByPublic[key]; pending != nil {
		return isCodexApprovalKind(pending.kind)
	}
	resolvedKind, resolved := c.resolvedPublic[key]
	return resolved && isCodexApprovalKind(resolvedKind)
}

func isCodexApprovalKind(kind string) bool {
	return kind == codexApprovalCommand || kind == codexApprovalFile || kind == codexApprovalPermissions
}

func (c *codexInteractions) KnowsQuestion(threadID, publicID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := threadID + "\x00" + publicID
	if pending := c.pendingByPublic[key]; pending != nil {
		return pending.kind == codexQuestion
	}
	resolvedKind, resolved := c.resolvedPublic[key]
	return resolved && resolvedKind == codexQuestion
}

func (c *codexInteractions) KnowsMcpElicitation(threadID, publicID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := threadID + "\x00" + publicID
	if pending := c.pendingByPublic[key]; pending != nil {
		return pending.kind == codexMcpElicitation
	}
	resolvedKind, resolved := c.resolvedPublic[key]
	return resolved && resolvedKind == codexMcpElicitation
}

func (c *codexInteractions) ResolveMcpElicitation(_ context.Context, threadID, publicID, action string, content json.RawMessage) error {
	release, open := c.beginLifecycle(threadID)
	if !open {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	defer release()
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return fmt.Errorf("Codex interaction broker is closed")
	}
	pending, ok := c.pendingByPublic[threadID+"\x00"+publicID]
	if !ok || pending.kind != codexMcpElicitation {
		_, resolved := c.resolvedPublic[threadID+"\x00"+publicID]
		c.mu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: publicID}
		}
		return fmt.Errorf("Codex MCP elicitation is not pending")
	}
	if action != "accept" && action != "decline" && action != "cancel" {
		c.mu.Unlock()
		return fmt.Errorf("invalid MCP elicitation action %q", action)
	}
	if action == "accept" && pending.elicitationMode == "form" {
		if err := validateMcpFormContent(pending.elicitationSchema, content); err != nil {
			c.mu.Unlock()
			return err
		}
	} else if len(content) > 0 && strings.TrimSpace(string(content)) != "null" {
		c.mu.Unlock()
		return fmt.Errorf("MCP elicitation content is only valid for accepted forms")
	}
	result := map[string]any{"action": action}
	if action == "accept" && pending.elicitationMode == "form" {
		result["content"] = json.RawMessage(content)
	}
	c.markResolvingLocked(pending)
	c.mu.Unlock()
	if err := c.client.Respond(pending.requestID, result, nil); err != nil {
		c.restoreAfterWriteFailure(pending)
		return err
	}
	if c.closed.Load() {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	// Form values may contain credentials or private data. Persist only the
	// resolution action, never the submitted content.
	c.publishEvent(protocol.DaemonEvent{
		Type: "mcp_elicitation_resolved", SessionID: threadID, RequestID: publicID,
		Action: action, Redacted: action == "accept" && pending.elicitationMode == "form",
	})
	c.finishResolution(threadID)
	return nil
}

func (c *codexInteractions) HasPending(threadID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hasPendingOrResolvingLocked(threadID)
}

// DeferStatusIfPending keeps interaction waiting states authoritative while
// retaining the newest native lifecycle status for final reconciliation.
func (c *codexInteractions) PublishProjectedStatus(event protocol.DaemonEvent, prepare func() []protocol.DaemonEvent) {
	release, open := c.beginLifecycle(event.SessionID)
	if !open {
		return
	}
	defer release()
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return
	}
	c.lifecycleRevision[event.SessionID]++
	if c.hasPendingOrResolvingLocked(event.SessionID) {
		c.deferredStatus[event.SessionID] = codexDeferredStatus{status: event.Status, revision: c.lifecycleRevision[event.SessionID]}
		c.mu.Unlock()
		return
	}
	publishedEvents := prepare()
	c.mu.Unlock()
	for _, published := range publishedEvents {
		if !c.publishEvent(published) {
			return
		}
	}
}

func (c *codexInteractions) ResolveQuestion(_ context.Context, threadID, publicID string, answers [][]string) error {
	release, open := c.beginLifecycle(threadID)
	if !open {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	defer release()
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return fmt.Errorf("Codex interaction broker is closed")
	}
	pending, ok := c.pendingByPublic[threadID+"\x00"+publicID]
	if !ok || pending.kind != codexQuestion {
		_, resolved := c.resolvedPublic[threadID+"\x00"+publicID]
		c.mu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: publicID}
		}
		return fmt.Errorf("Codex question request is not pending")
	}
	questions := make([]protocol.QuestionInfo, 0, len(pending.questions))
	for _, question := range pending.questions {
		questions = append(questions, question.info)
	}
	if err := protocol.ValidateQuestionAnswers(questions, answers); err != nil {
		c.mu.Unlock()
		return err
	}
	nativeAnswers := make(map[string]any, len(answers))
	for index, values := range answers {
		nativeAnswers[pending.questions[index].id] = map[string]any{"answers": append([]string(nil), values...)}
	}
	result := map[string]any{"answers": nativeAnswers}
	c.markResolvingLocked(pending)
	c.mu.Unlock()
	if err := c.client.Respond(pending.requestID, result, nil); err != nil {
		c.restoreAfterWriteFailure(pending)
		return err
	}
	if c.closed.Load() {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	event := protocol.DaemonEvent{Type: "question_resolved", SessionID: threadID, RequestID: publicID}
	if pending.hasSecret {
		event.Redacted = true
	} else {
		event.Answers = answers
	}
	c.publishEvent(event)
	c.finishResolution(threadID)
	return nil
}

func (c *codexInteractions) RejectQuestion(_ context.Context, threadID, publicID string) error {
	release, open := c.beginLifecycle(threadID)
	if !open {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	defer release()
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return fmt.Errorf("Codex interaction broker is closed")
	}
	pending, ok := c.pendingByPublic[threadID+"\x00"+publicID]
	if !ok || pending.kind != codexQuestion {
		_, resolved := c.resolvedPublic[threadID+"\x00"+publicID]
		c.mu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: publicID}
		}
		return fmt.Errorf("Codex question request is not pending")
	}
	c.markResolvingLocked(pending)
	c.mu.Unlock()
	rpcErr := &codexapp.RPCError{Code: -32800, Message: "request canceled"}
	if err := c.client.Respond(pending.requestID, nil, rpcErr); err != nil {
		c.restoreAfterWriteFailure(pending)
		return err
	}
	if c.closed.Load() {
		return fmt.Errorf("Codex interaction broker is closed")
	}
	c.publishEvent(protocol.DaemonEvent{
		Type: "question_resolved", SessionID: threadID, RequestID: publicID, Rejected: true,
	})
	c.finishResolution(threadID)
	return nil
}

func (c *codexInteractions) handleResolved(raw json.RawMessage) {
	var params struct {
		ThreadID  string             `json:"threadId"`
		RequestID codexapp.RequestID `json:"requestId"`
	}
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" {
		return
	}
	release, open := c.beginLifecycle(params.ThreadID)
	if !open {
		return
	}
	defer release()
	nativeKey := c.nativeKey(params.ThreadID, params.RequestID)
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return
	}
	if _, local := c.resolvedNative[nativeKey]; local {
		c.mu.Unlock()
		return
	}
	pending := c.pendingByNative[nativeKey]
	if pending == nil {
		c.resolvedNative[nativeKey] = struct{}{}
		c.mu.Unlock()
		return
	}
	c.markResolvingLocked(pending)
	c.mu.Unlock()
	typeName := "approval_resolved"
	if pending.kind == codexQuestion {
		typeName = "question_resolved"
	} else if pending.kind == codexMcpElicitation {
		typeName = "mcp_elicitation_resolved"
	}
	c.publishEvent(protocol.DaemonEvent{
		Type: typeName, SessionID: pending.threadID, RequestID: pending.publicID,
		Reason: protocol.InteractionResolvedElsewhere,
	})
	c.finishResolution(pending.threadID)
}

func (c *codexInteractions) markResolvingLocked(pending *codexPendingInteraction) {
	c.removePendingLocked(pending)
	c.resolvedNative[pending.nativeKey] = struct{}{}
	c.resolvedPublic[pending.threadID+"\x00"+pending.publicID] = pending.kind
	c.resolvingByThread[pending.threadID]++
}

func (c *codexInteractions) removePendingLocked(pending *codexPendingInteraction) {
	delete(c.pendingByNative, pending.nativeKey)
	delete(c.pendingByPublic, pending.threadID+"\x00"+pending.publicID)
}

func (c *codexInteractions) restoreAfterWriteFailure(pending *codexPendingInteraction) {
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return
	}
	delete(c.resolvedNative, pending.nativeKey)
	delete(c.resolvedPublic, pending.threadID+"\x00"+pending.publicID)
	c.pendingByNative[pending.nativeKey] = pending
	c.pendingByPublic[pending.threadID+"\x00"+pending.publicID] = pending
	c.decrementResolvingLocked(pending.threadID)
	c.mu.Unlock()
}

func (c *codexInteractions) finishResolution(threadID string) {
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return
	}
	c.decrementResolvingLocked(threadID)
	final := !c.hasPendingOrResolvingLocked(threadID)
	candidate := c.deferredStatus[threadID]
	if candidate.status == "" {
		candidate = codexDeferredStatus{status: protocol.StatusRunning, revision: c.lifecycleRevision[threadID]}
	}
	if final {
		delete(c.deferredStatus, threadID)
	}
	c.mu.Unlock()
	if !final {
		return
	}
	if c.setWaiting(threadID, candidate.status) {
		c.publishEvent(c.statusEvent(threadID, candidate.status))
	}
}

func (c *codexInteractions) publishPendingTransition(threadID, status string, event protocol.DaemonEvent) {
	if !c.setWaiting(threadID, status) || !c.publishEvent(event) {
		return
	}
	c.publishEvent(c.statusEvent(threadID, status))
}

func (c *codexInteractions) beginLifecycle(threadID string) (func(), bool) {
	if c.closed.Load() {
		return nil, false
	}
	c.sequencerMu.Lock()
	sequencer := c.sequencers[threadID]
	if sequencer == nil {
		sequencer = newCodexThreadSequencer()
		c.sequencers[threadID] = sequencer
	}
	c.sequencerMu.Unlock()
	sequencer.mu.Lock()
	ticket := sequencer.next
	sequencer.next++
	for ticket != sequencer.serving && !c.closed.Load() {
		sequencer.cond.Wait()
	}
	if c.closed.Load() {
		sequencer.mu.Unlock()
		return nil, false
	}
	sequencer.mu.Unlock()
	return func() {
		sequencer.mu.Lock()
		sequencer.serving++
		sequencer.cond.Broadcast()
		sequencer.mu.Unlock()
	}, true
}

func (c *codexInteractions) Close() {
	c.closeOnce.Do(func() {
		c.publicationGate.Lock()
		c.mu.Lock()
		c.closed.Store(true)
		c.mu.Unlock()
		close(c.done)
		c.publicationGate.Unlock()
		c.sequencerMu.Lock()
		sequencers := make([]*codexThreadSequencer, 0, len(c.sequencers))
		for _, sequencer := range c.sequencers {
			sequencers = append(sequencers, sequencer)
		}
		c.sequencerMu.Unlock()
		for _, sequencer := range sequencers {
			sequencer.mu.Lock()
			sequencer.cond.Broadcast()
			sequencer.mu.Unlock()
		}
	})
}

func (c *codexInteractions) publishEvent(event protocol.DaemonEvent) bool {
	if c.closed.Load() {
		return false
	}
	if c.beforeLifecycleEmit != nil {
		c.beforeLifecycleEmit(event)
	}
	for {
		c.publicationGate.Lock()
		if c.closed.Load() {
			c.publicationGate.Unlock()
			return false
		}
		select {
		case c.sm.outputCh <- event:
			c.publicationGate.Unlock()
			return true
		default:
			c.publicationGate.Unlock()
		}
		if c.afterSendBlocked != nil {
			c.afterSendBlocked()
		}
		timer := time.NewTimer(time.Millisecond)
		select {
		case <-c.done:
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

func (c *codexInteractions) hasPendingOrResolvingLocked(threadID string) bool {
	if c.resolvingByThread[threadID] > 0 {
		return true
	}
	for _, pending := range c.pendingByNative {
		if pending.threadID == threadID {
			return true
		}
	}
	return false
}

func (c *codexInteractions) decrementResolvingLocked(threadID string) {
	if c.resolvingByThread[threadID] <= 1 {
		delete(c.resolvingByThread, threadID)
		return
	}
	c.resolvingByThread[threadID]--
}

func (c *codexInteractions) setWaiting(threadID, status string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed.Load() {
		return false
	}
	now := time.Now()
	c.sm.mu.Lock()
	ps := c.sm.sessions[threadID]
	if ps == nil {
		ps = &ProcessState{
			SessionID: threadID, Agent: adapter.AgentCodex, Source: "terminal",
			StartedAt: now, ControlMode: protocol.ControlManaged,
		}
		c.sm.sessions[threadID] = ps
	}
	ps.Status = status
	ps.LastActivityAt = now
	c.sm.mu.Unlock()
	return true
}

func (c *codexInteractions) statusEvent(threadID, status string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "session_status", SessionID: threadID, Status: status,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func (c *codexInteractions) nativeKey(threadID string, requestID codexapp.RequestID) string {
	return fmt.Sprintf("%d\x00%s\x00%s", c.generation, threadID, requestID.Key())
}

func (c *codexInteractions) publicID(nativeKey string) string {
	hash := sha256.Sum256([]byte(nativeKey))
	return fmt.Sprintf("codex:%d:%s", c.generation, hex.EncodeToString(hash[:12]))
}

func approvalDecisions(kind string, raw []json.RawMessage) []string {
	if kind == codexApprovalPermissions {
		return []string{"accept", "acceptForSession", "decline"}
	}
	if len(raw) == 0 {
		return []string{"accept", "acceptForSession", "decline", "cancel"}
	}
	decisions := make([]string, 0, len(raw))
	for _, item := range raw {
		var value string
		if json.Unmarshal(item, &value) == nil && value != "" {
			decisions = append(decisions, value)
		}
	}
	return decisions
}

func codexApprovalResponse(pending *codexPendingInteraction, action string) (map[string]any, bool, error) {
	decision := ""
	switch action {
	case "once":
		decision = "accept"
	case "always":
		decision = "acceptForSession"
	case "reject":
		decision = "decline"
	case "cancel":
		decision = "cancel"
	default:
		return nil, false, fmt.Errorf("invalid Codex approval action %q", action)
	}
	if _, ok := pending.available[decision]; !ok {
		return nil, false, fmt.Errorf("Codex approval decision %q is unavailable", decision)
	}
	if pending.kind != codexApprovalPermissions {
		return map[string]any{"decision": decision}, decision == "accept" || decision == "acceptForSession", nil
	}
	permissions := any(map[string]any{})
	if decision == "accept" || decision == "acceptForSession" {
		if len(pending.permissions) > 0 && strings.TrimSpace(string(pending.permissions)) != "null" {
			permissions = json.RawMessage(pending.permissions)
		}
	}
	scope := "turn"
	if decision == "acceptForSession" {
		scope = "session"
	}
	return map[string]any{"permissions": permissions, "scope": scope}, decision != "decline", nil
}
