package sessiondocument

import (
	"context"
	"sync"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type CaptureQueueOptions struct {
	MaxDocumentBytes int
	PerSessionDepth  int
	MaxSessions      int
	ResolveRoot      func(sessionID string) (root string, reason string)
	Capture          func(root string, candidate Candidate, maxDocumentBytes int) CaptureResult
	OnResult         func(CaptureResult)
}

type captureSessionQueue struct {
	candidates chan captureWork
	pending    map[string]struct{}
}

type captureWork struct {
	candidate Candidate
	transport TransportLimits
}

type CaptureQueue struct {
	ctx              context.Context
	cancel           context.CancelFunc
	maxDocumentBytes int
	perSessionDepth  int
	maxSessions      int
	resolveRoot      func(string) (string, string)
	capture          func(string, Candidate, int) CaptureResult
	onResult         func(CaptureResult)

	mu                   sync.Mutex
	sessions             map[string]*captureSessionQueue
	stopped              bool
	wg                   sync.WaitGroup
	queueDepth           int
	maxQueueDepth        int
	rejectedBackpressure uint64
}

// QueueDiagnostics is a local-only aggregate snapshot. It deliberately omits
// session, turn, event, document, and path identities.
type QueueDiagnostics struct {
	QueueDepth           int
	PendingCandidates    int
	MaxQueueDepth        int
	RejectedBackpressure uint64
}

func NewCaptureQueue(options CaptureQueueOptions) *CaptureQueue {
	ctx, cancel := context.WithCancel(context.Background())
	if options.PerSessionDepth <= 0 {
		options.PerSessionDepth = 4
	}
	if options.MaxSessions <= 0 {
		options.MaxSessions = 256
	}
	if options.Capture == nil {
		options.Capture = Capture
	}
	if options.ResolveRoot == nil {
		options.ResolveRoot = func(string) (string, string) {
			return "", protocol.SessionDocumentReasonPathOutsideRoot
		}
	}
	return &CaptureQueue{
		ctx: ctx, cancel: cancel, maxDocumentBytes: options.MaxDocumentBytes,
		perSessionDepth: options.PerSessionDepth, maxSessions: options.MaxSessions,
		resolveRoot: options.ResolveRoot, capture: options.Capture, onResult: options.OnResult,
		sessions: make(map[string]*captureSessionQueue),
	}
}

func candidateQueueKey(candidate Candidate) string {
	return candidate.SourceEventID + "\x00" + candidate.RelativePath
}

// SubmitEvent performs only bounded in-memory validation and never waits for
// filesystem access. A true result means the candidate was queued or already
// pending; false means it was ineligible, the queue was full, or shutdown began.
func (q *CaptureQueue) SubmitEvent(event protocol.DaemonEvent) bool {
	return q.SubmitEventWithLimits(event, TransportLimits{})
}

func (q *CaptureQueue) SubmitEventWithLimits(event protocol.DaemonEvent, limits TransportLimits) bool {
	candidate, ok := CandidateFromEvent(event)
	if !ok {
		return false
	}
	key := candidateQueueKey(candidate)
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.stopped {
		return false
	}
	sessionQueue := q.sessions[candidate.SessionID]
	if sessionQueue == nil {
		if len(q.sessions) >= q.maxSessions {
			return false
		}
		sessionQueue = &captureSessionQueue{
			candidates: make(chan captureWork, q.perSessionDepth),
			pending:    make(map[string]struct{}),
		}
		q.sessions[candidate.SessionID] = sessionQueue
		q.wg.Add(1)
		go q.runSession(sessionQueue)
	}
	if _, duplicate := sessionQueue.pending[key]; duplicate {
		return true
	}
	select {
	case sessionQueue.candidates <- captureWork{candidate: candidate, transport: limits}:
		sessionQueue.pending[key] = struct{}{}
		q.queueDepth++
		if q.queueDepth > q.maxQueueDepth {
			q.maxQueueDepth = q.queueDepth
		}
		return true
	default:
		q.rejectedBackpressure++
		return false
	}
}

func (q *CaptureQueue) runSession(sessionQueue *captureSessionQueue) {
	defer q.wg.Done()
	for {
		select {
		case <-q.ctx.Done():
			return
		case work := <-sessionQueue.candidates:
			q.mu.Lock()
			if q.queueDepth > 0 {
				q.queueDepth--
			}
			q.mu.Unlock()
			candidate := work.candidate
			root, reason := q.resolveRoot(candidate.SessionID)
			var result CaptureResult
			if root == "" || reason != "" {
				if reason == "" {
					reason = protocol.SessionDocumentReasonPathOutsideRoot
				}
				result = unavailableResult(candidate, reason)
			} else {
				result = q.capture(root, candidate, q.maxDocumentBytes)
			}
			result.Transport = work.transport
			q.deliver(result)
			q.mu.Lock()
			delete(sessionQueue.pending, candidateQueueKey(candidate))
			q.mu.Unlock()
		}
	}
}

func (q *CaptureQueue) Diagnostics() QueueDiagnostics {
	q.mu.Lock()
	defer q.mu.Unlock()
	pending := 0
	for _, sessionQueue := range q.sessions {
		pending += len(sessionQueue.pending)
	}
	return QueueDiagnostics{
		QueueDepth: q.queueDepth, PendingCandidates: pending,
		MaxQueueDepth: q.maxQueueDepth, RejectedBackpressure: q.rejectedBackpressure,
	}
}

func (q *CaptureQueue) deliver(result CaptureResult) {
	if q.onResult == nil {
		return
	}
	defer func() { _ = recover() }()
	q.onResult(result)
}

func (q *CaptureQueue) Stop() {
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		return
	}
	q.stopped = true
	q.cancel()
	q.mu.Unlock()
	q.wg.Wait()
}
