'use strict';

/**
 * TranscriptAssembler manages streaming STT events by strictly separating committed
 * final segments from volatile interim hypotheses.
 *
 * Prevents the concatenation artifact where partial recognizer hypotheses are
 * mistakenly appended into the persistent transcript.
 */
class TranscriptAssembler {
  constructor({ onInterim, onCommit } = {}) {
    this.committed = [];          // Array of final segments { segment_id, text, start_ms, end_ms, confidence }
    this.pending = null;          // Single current interim (overwritten, never appended)
    this.lastSegmentId = null;
    this.onInterim = onInterim || (() => {});
    this.onCommit = onCommit || (() => {});
  }

  ingest(evt) {
    if (!evt || typeof evt.text !== 'string') return;

    if (evt.is_final) {
      // Guard against duplicate finals for the same segment
      if (evt.segment_id != null && evt.segment_id === this.lastSegmentId) return;

      const seg = {
        segment_id: evt.segment_id ?? this.committed.length,
        text: evt.text.trim(),
        start_ms: evt.start_ms ?? null,
        end_ms: evt.end_ms ?? null,
        confidence: evt.confidence ?? null,
        words: evt.words ?? null
      };

      if (seg.text.length) {
        this.committed.push(seg);
      }
      this.lastSegmentId = seg.segment_id;
      this.pending = null; // Final clears pending interim
      this.onCommit(seg, this.committedText());
      return;
    }

    // Interim event: OVERWRITE pending, do NOT append
    this.pending = { text: evt.text, stability: evt.stability ?? null };
    this.onInterim(this.displayText());
  }

  committedText() {
    return this.committed.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  displayText() {
    return [this.committedText(), this.pending?.text ?? ''].join(' ').trim();
  }

  finalize({ flushPending = false } = {}) {
    if (flushPending && this.pending?.text?.trim()) {
      this.committed.push({
        segment_id: 'flush',
        text: this.pending.text.trim(),
        start_ms: null,
        end_ms: null,
        confidence: null,
        flushed_interim: true
      });
    }
    this.pending = null;
    return {
      text: this.committedText(),
      segments: this.committed.slice()
    };
  }
}

module.exports = { TranscriptAssembler };
