package ws

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	toolOutputStreamCapability = "tool_output_stream_v1"
	contentChunkTargetBytes    = 64 << 10
)

type outboundContentStream struct {
	nextChunk  int
	byteOffset int
	content    string
}

type preparedOutbound struct {
	frames       []bufferedEvent
	streamID     string
	streamState  outboundContentStream
	streamFinal  bool
	quarantine   []byte
	originalType string
}

func (c *Client) prepareOutboundLocked(
	original *protocol.DaemonEvent,
	startSeq int64,
) (preparedOutbound, error) {
	event := *original
	if !c.streamTransportSupported {
		clearContentStreamMetadata(&event)
		return c.prepareSingleFrame(event, startSeq)
	}

	if event.StreamID != "" {
		if event.ChunkSeq != nil || event.ByteOffset != nil {
			return c.preparePhysicalStreamFrame(event, startSeq)
		}
		return c.prepareLogicalStream(event, startSeq)
	}

	single, err := c.prepareSingleFrame(event, startSeq)
	if err != nil {
		return preparedOutbound{}, err
	}
	if len(single.frames[0].data) <= c.maxEventBytes {
		return single, nil
	}

	content, ok := eventContent(event)
	if !ok || content == "" {
		return c.prepareDeliveryError(event, single.frames[0].data, startSeq)
	}
	event.StreamID = c.transportStreamID(event, startSeq, single.frames[0].data)
	event.Streaming = true
	event.Final = true
	event.TotalBytes = len([]byte(content))
	event.ContentHash = contentDigest([]byte(content))
	return c.prepareLogicalStream(event, startSeq)
}

func (c *Client) prepareSingleFrame(
	event protocol.DaemonEvent,
	seq int64,
) (preparedOutbound, error) {
	event.Seq = seq
	raw, err := json.Marshal(event)
	if err != nil {
		return preparedOutbound{}, err
	}
	return preparedOutbound{
		frames:       []bufferedEvent{{seq: seq, data: raw}},
		originalType: event.Type,
	}, nil
}

func (c *Client) preparePhysicalStreamFrame(
	event protocol.DaemonEvent,
	seq int64,
) (preparedOutbound, error) {
	content, ok := eventContent(event)
	if !ok || len([]byte(content)) > c.maxChunkBytes {
		raw, err := json.Marshal(event)
		if err != nil {
			return preparedOutbound{}, err
		}
		return c.prepareDeliveryError(event, raw, seq)
	}
	single, err := c.prepareSingleFrame(event, seq)
	if err != nil {
		return preparedOutbound{}, err
	}
	if len(single.frames[0].data) > c.maxEventBytes {
		return c.prepareDeliveryError(event, single.frames[0].data, seq)
	}
	return single, nil
}

func (c *Client) prepareLogicalStream(
	event protocol.DaemonEvent,
	startSeq int64,
) (preparedOutbound, error) {
	content, ok := eventContent(event)
	if !ok || !utf8.ValidString(content) {
		raw, err := json.Marshal(event)
		if err != nil {
			return preparedOutbound{}, err
		}
		return c.prepareDeliveryError(event, raw, startSeq)
	}

	streamID := event.StreamID
	state := c.outboundStreams[streamID]
	payload := content
	if event.Final && event.TotalBytes > 0 && state.byteOffset > 0 {
		switch {
		case state.byteOffset+len([]byte(content)) == event.TotalBytes:
			// The projector already supplied only the unsent suffix.
		case len([]byte(content)) == event.TotalBytes && strings.HasPrefix(content, state.content):
			payload = content[len(state.content):]
		default:
			// A source correction must use a fresh stream so byte offsets never
			// rewrite content that clients may already have rendered.
			streamID += ":correction:" + contentDigest([]byte(content))
			event.StreamID = streamID
			state = outboundContentStream{}
		}
	}

	frames, next, err := c.frameStreamContent(event, payload, state, startSeq)
	if err != nil {
		raw, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			return preparedOutbound{}, err
		}
		return c.prepareDeliveryError(event, raw, startSeq)
	}
	next.content += payload
	return preparedOutbound{
		frames:       frames,
		streamID:     streamID,
		streamState:  next,
		streamFinal:  event.Final,
		originalType: event.Type,
	}, nil
}

func (c *Client) frameStreamContent(
	base protocol.DaemonEvent,
	content string,
	state outboundContentStream,
	startSeq int64,
) ([]bufferedEvent, outboundContentStream, error) {
	remaining := content
	frames := make([]bufferedEvent, 0, 1)
	for len(remaining) > 0 || (len(frames) == 0 && base.Final) {
		seq := startSeq + int64(len(frames))
		prefix, err := c.fitStreamPrefix(base, remaining, state, seq)
		if err != nil {
			return nil, state, err
		}
		last := len(prefix) == len(remaining)
		frame := streamFrame(base, prefix, state, seq, last)
		raw, err := json.Marshal(frame)
		if err != nil {
			return nil, state, err
		}
		if len(raw) > c.maxEventBytes {
			return nil, state, fmt.Errorf("stream frame has %d bytes, max %d", len(raw), c.maxEventBytes)
		}
		frames = append(frames, bufferedEvent{seq: seq, data: raw})
		state.nextChunk++
		state.byteOffset += len([]byte(prefix))
		remaining = remaining[len(prefix):]
		if last {
			break
		}
	}
	return frames, state, nil
}

func (c *Client) fitStreamPrefix(
	base protocol.DaemonEvent,
	remaining string,
	state outboundContentStream,
	seq int64,
) (string, error) {
	if remaining == "" {
		candidate := streamFrame(base, "", state, seq, true)
		raw, err := json.Marshal(candidate)
		if err != nil {
			return "", err
		}
		if len(raw) > c.maxEventBytes {
			return "", fmt.Errorf("stream envelope has %d bytes, max %d", len(raw), c.maxEventBytes)
		}
		return "", nil
	}

	boundaries := []int{0}
	chunkLimit := min(c.maxChunkBytes, contentChunkTargetBytes)
	for index := range remaining {
		if index > chunkLimit {
			break
		}
		if index > 0 && index <= chunkLimit {
			boundaries = append(boundaries, index)
		}
	}
	limit := min(len(remaining), chunkLimit)
	if boundaries[len(boundaries)-1] != limit && utf8.ValidString(remaining[:limit]) {
		boundaries = append(boundaries, limit)
	}
	low, high := 1, len(boundaries)-1
	best := 0
	for low <= high {
		mid := low + (high-low)/2
		prefix := remaining[:boundaries[mid]]
		// Use completion metadata for every fit check. Intermediate frames only
		// get smaller when completion and source identity are removed.
		candidate := streamFrame(base, prefix, state, seq, true)
		raw, err := json.Marshal(candidate)
		if err != nil {
			return "", err
		}
		if len(raw) <= c.maxEventBytes {
			best = boundaries[mid]
			low = mid + 1
		} else {
			high = mid - 1
		}
	}
	if best == 0 {
		return "", fmt.Errorf("stream metadata leaves no room for content")
	}
	return remaining[:best], nil
}

func streamFrame(
	base protocol.DaemonEvent,
	content string,
	state outboundContentStream,
	seq int64,
	last bool,
) protocol.DaemonEvent {
	frame := base
	frame.Seq = seq
	chunkSeq, byteOffset := state.nextChunk, state.byteOffset
	frame.ChunkSeq = &chunkSeq
	frame.ByteOffset = &byteOffset
	frame.Snapshot = ""
	frame.Streaming = true
	setEventContent(&frame, content)
	if !last {
		frame.EventID = ""
		frame.PreviousEventID = ""
		frame.Final = false
		frame.TotalBytes = 0
		frame.ContentHash = ""
		frame.Usage = nil
	}
	return frame
}

func (c *Client) prepareDeliveryError(
	original protocol.DaemonEvent,
	originalRaw []byte,
	seq int64,
) (preparedOutbound, error) {
	replacement := protocol.DaemonEvent{
		Type:          "event_delivery_error",
		Seq:           seq,
		SessionID:     original.SessionID,
		EventID:       original.EventID,
		Reason:        "event_too_large",
		Error:         "event exceeded the negotiated transport limit",
		Truncated:     true,
		OriginalType:  original.Type,
		OriginalBytes: len(originalRaw),
		ContentHash:   contentDigest(originalRaw),
	}
	raw, err := json.Marshal(replacement)
	if err != nil {
		return preparedOutbound{}, err
	}
	if len(raw) > c.maxEventBytes {
		replacement.Error = ""
		raw, err = json.Marshal(replacement)
	}
	if err != nil || len(raw) > c.maxEventBytes {
		return preparedOutbound{}, fmt.Errorf(
			"delivery error has %d bytes, max %d", len(raw), c.maxEventBytes,
		)
	}
	return preparedOutbound{
		frames:       []bufferedEvent{{seq: seq, data: raw}},
		quarantine:   append([]byte(nil), originalRaw...),
		originalType: original.Type,
	}, nil
}

func eventContent(event protocol.DaemonEvent) (string, bool) {
	switch event.Type {
	case "agent_text", "agent_reasoning":
		return event.Text, true
	case "tool_result":
		return event.Output, true
	case "agent_file_change":
		return event.Diff, true
	default:
		return "", false
	}
}

func setEventContent(event *protocol.DaemonEvent, content string) {
	switch event.Type {
	case "agent_text", "agent_reasoning":
		event.Text = content
	case "tool_result":
		event.Output = content
	case "agent_file_change":
		event.Diff = content
	}
}

func clearContentStreamMetadata(event *protocol.DaemonEvent) {
	wasFinal := event.Final
	event.StreamID = ""
	event.ChunkSeq = nil
	event.ByteOffset = nil
	event.Final = false
	event.TotalBytes = 0
	event.ContentHash = ""
	if wasFinal {
		event.Streaming = false
	}
}

func (c *Client) transportStreamID(
	event protocol.DaemonEvent,
	startSeq int64,
	raw []byte,
) string {
	if event.EventID != "" {
		return "transport:" + contentDigest([]byte(event.EventID))
	}
	return fmt.Sprintf("transport:%s:%d:%s", c.daemonID, startSeq, contentDigest(raw))
}

func contentDigest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:16])
}

func (c *Client) repairBufferedEventsLocked(shouldRepair func(bufferedEvent) bool) (map[int64]struct{}, error) {
	candidate := append([]bufferedEvent(nil), c.outBuf...)
	var originals [][]byte
	repaired := make(map[int64]struct{})
	for index, buffered := range candidate {
		if !shouldRepair(buffered) {
			continue
		}
		var original protocol.DaemonEvent
		_ = json.Unmarshal(buffered.data, &original)
		original.Seq = buffered.seq
		replacement, err := c.prepareDeliveryError(original, buffered.data, buffered.seq)
		if err != nil {
			return nil, err
		}
		candidate[index] = replacement.frames[0]
		originals = append(originals, append([]byte(nil), buffered.data...))
		repaired[buffered.seq] = struct{}{}
	}
	if len(repaired) == 0 {
		return repaired, nil
	}
	if err := c.spool.quarantineAndRewrite(originals, candidate); err != nil {
		return nil, err
	}
	c.outBuf = candidate
	c.outBytes = 0
	for _, buffered := range candidate {
		c.outBytes += len(buffered.data)
	}
	c.outCond.Broadcast()
	return repaired, nil
}
