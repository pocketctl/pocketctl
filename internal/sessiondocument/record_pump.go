package sessiondocument

import (
	"context"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type RecordPumpOptions struct {
	BatchDepth int
	RetryDelay time.Duration
	CanEmit    func() bool
	Emit       func(protocol.DaemonEvent) bool
}

type RecordPump struct {
	ctx        context.Context
	cancel     context.CancelFunc
	batches    chan []protocol.DaemonEvent
	retryDelay time.Duration
	canEmit    func() bool
	emit       func(protocol.DaemonEvent) bool

	mu       sync.Mutex
	admitted int
	stopped  bool
	wg       sync.WaitGroup
}

func NewRecordPump(options RecordPumpOptions) *RecordPump {
	if options.BatchDepth <= 0 {
		options.BatchDepth = 16
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = 5 * time.Millisecond
	}
	if options.CanEmit == nil {
		options.CanEmit = func() bool { return true }
	}
	if options.Emit == nil {
		options.Emit = func(protocol.DaemonEvent) bool { return false }
	}
	ctx, cancel := context.WithCancel(context.Background())
	pump := &RecordPump{
		ctx: ctx, cancel: cancel, batches: make(chan []protocol.DaemonEvent, options.BatchDepth),
		retryDelay: options.RetryDelay, canEmit: options.CanEmit, emit: options.Emit,
	}
	pump.wg.Add(1)
	go pump.run()
	return pump
}

// Submit admits one already-validated document record set atomically. The
// caller never waits and cannot enqueue a begin without its remaining batch.
func (p *RecordPump) Submit(records []protocol.DaemonEvent) bool {
	if len(records) == 0 {
		return false
	}
	copyOfRecords := append([]protocol.DaemonEvent(nil), records...)
	p.mu.Lock()
	if p.stopped || p.admitted >= cap(p.batches) {
		p.mu.Unlock()
		return false
	}
	p.admitted++
	p.mu.Unlock()
	select {
	case p.batches <- copyOfRecords:
		return true
	case <-p.ctx.Done():
		p.releaseAdmission()
		return false
	}
}

func (p *RecordPump) releaseAdmission() {
	p.mu.Lock()
	p.admitted--
	p.mu.Unlock()
}

func (p *RecordPump) run() {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case records := <-p.batches:
			if !p.emitBatch(records) {
				p.releaseAdmission()
				return
			}
			p.releaseAdmission()
		}
	}
}

func (p *RecordPump) emitBatch(records []protocol.DaemonEvent) bool {
	for _, record := range records {
		for {
			if p.canEmit() && p.emit(record) {
				break
			}
			timer := time.NewTimer(p.retryDelay)
			select {
			case <-p.ctx.Done():
				if !timer.Stop() {
					<-timer.C
				}
				return false
			case <-timer.C:
			}
		}
	}
	return true
}

func (p *RecordPump) Stop() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	p.cancel()
	p.mu.Unlock()
	p.wg.Wait()
}
