//! Child output → `polis_queue_logs` (build spec §1.5): batched inserts keyed
//! `(env, attempt_id, seq)`, a per-attempt cap with one `truncated` marker
//! row, lines over 1 MiB split, NUL removed, and replay-tolerant batches.
use super::rpc::Rpc;
use std::{
    io::{BufRead, BufReader, Read},
    sync::mpsc,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// `polis_queue_logs.line` CHECK (octet_length ≤ 1 MiB).
pub const MAX_LINE: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub seq: i64,
    pub stream: &'static str,
    pub line: String,
}

/// Pure buffer: sequence numbers, splitting, cap and batching.
#[derive(Debug)]
pub struct LogBuffer {
    max_lines: u64,
    max_bytes: u64,
    next_seq: i64,
    kept_lines: u64,
    kept_bytes: u64,
    pub seen_lines: u64,
    pub dropped_lines: u64,
    truncated: bool,
    pending: Vec<Row>,
}

/// Split at UTF-8 boundaries into pieces of at most `MAX_LINE` bytes; NUL
/// (which Postgres text cannot hold) becomes U+FFFD.
pub fn split_line(line: &str) -> Vec<String> {
    let clean = if line.contains('\0') {
        line.replace('\0', "\u{FFFD}")
    } else {
        line.to_owned()
    };
    if clean.len() <= MAX_LINE {
        return vec![clean];
    }
    let mut out = Vec::new();
    let mut rest = clean.as_str();
    while !rest.is_empty() {
        let mut cut = rest.len().min(MAX_LINE);
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push(rest[..cut].to_owned());
        rest = &rest[cut..];
    }
    out
}

impl LogBuffer {
    pub fn new(max_lines: u64, max_bytes: u64) -> Self {
        Self {
            max_lines,
            max_bytes,
            next_seq: 0,
            kept_lines: 0,
            kept_bytes: 0,
            seen_lines: 0,
            dropped_lines: 0,
            truncated: false,
            pending: Vec::new(),
        }
    }

    pub fn push(&mut self, stream: &'static str, line: &str) {
        for piece in split_line(line) {
            self.seen_lines += 1;
            let len = piece.len() as u64;
            if self.truncated
                || self.kept_lines + 1 > self.max_lines
                || self.kept_bytes + len > self.max_bytes
            {
                self.dropped_lines += 1;
                if !self.truncated {
                    self.truncated = true;
                    let marker = format!(
                        "{{\"schema\":\"polis_jobs.truncated/1\",\"after_lines\":{},\"after_bytes\":{},\"max_lines\":{},\"max_bytes\":{}}}",
                        self.kept_lines, self.kept_bytes, self.max_lines, self.max_bytes
                    );
                    self.enqueue("truncated", marker);
                }
                continue;
            }
            self.kept_lines += 1;
            self.kept_bytes += len;
            self.enqueue(stream, piece);
        }
    }

    fn enqueue(&mut self, stream: &'static str, line: String) {
        self.pending.push(Row {
            seq: self.next_seq,
            stream,
            line,
        });
        self.next_seq += 1;
    }

    /// The manifest row: next sequence number, exempt from the cap.
    pub fn manifest_row(&mut self, text: &str) -> Row {
        let row = Row {
            seq: self.next_seq,
            stream: "manifest",
            line: text.to_owned(),
        };
        self.next_seq += 1;
        row
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    pub fn take(&mut self) -> Vec<Row> {
        std::mem::take(&mut self.pending)
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

pub enum Msg {
    Line(&'static str, String),
}

/// Read one pipe line by line (lines longer than `MAX_LINE` arrive in pieces).
pub fn pump<R: Read + Send + 'static>(
    stream: &'static str,
    reader: R,
    sender: mpsc::Sender<Msg>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader
                .by_ref()
                .take(MAX_LINE as u64)
                .read_until(b'\n', &mut buf)
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if buf.last() == Some(&b'\n') {
                        buf.pop();
                        if buf.last() == Some(&b'\r') {
                            buf.pop();
                        }
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    if sender.send(Msg::Line(stream, line)).is_err() {
                        break;
                    }
                }
            }
        }
    })
}

/// Final counters of an attempt's log writer.
pub struct Written {
    pub buffer: LogBuffer,
    pub failed_batches: u64,
}

/// Drain the pumps into `polis_queue_logs`, flushing every `batch_lines`
/// lines or `interval`. Returns once every sender is gone and the last batch
/// is written (or retried and given up), with the buffer for the manifest row.
pub fn writer(
    mut rpc: Rpc,
    attempt: Uuid,
    receiver: mpsc::Receiver<Msg>,
    max_lines: u64,
    max_bytes: u64,
    batch_lines: usize,
    interval: Duration,
) -> (Rpc, Written) {
    let mut buffer = LogBuffer::new(max_lines, max_bytes);
    let mut failed_batches = 0;
    let mut last = Instant::now();
    let flush = |rpc: &mut Rpc, buffer: &mut LogBuffer, failed: &mut u64| {
        let rows = buffer.take();
        if rows.is_empty() {
            return;
        }
        let refs: Vec<(i64, &str, &str)> = rows
            .iter()
            .map(|r| (r.seq, r.stream, r.line.as_str()))
            .collect();
        // Replays of a partially committed batch are absorbed by ON CONFLICT.
        for attempt_no in 0..5 {
            match rpc.insert_logs(attempt, &refs) {
                Ok(()) => return,
                Err(e) => {
                    if attempt_no == 4 {
                        *failed += 1;
                        eprintln!("polis_jobs log batch dropped after retries: {e}");
                    } else {
                        std::thread::sleep(Duration::from_millis(200 << attempt_no));
                    }
                }
            }
        }
    };
    loop {
        let wait = interval.saturating_sub(last.elapsed());
        match receiver.recv_timeout(wait.max(Duration::from_millis(1))) {
            Ok(Msg::Line(stream, line)) => {
                buffer.push(stream, &line);
                if buffer.pending() >= batch_lines {
                    flush(&mut rpc, &mut buffer, &mut failed_batches);
                    last = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                flush(&mut rpc, &mut buffer, &mut failed_batches);
                last = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                flush(&mut rpc, &mut buffer, &mut failed_batches);
                break;
            }
        }
        if last.elapsed() >= interval {
            flush(&mut rpc, &mut buffer, &mut failed_batches);
            last = Instant::now();
        }
    }
    (
        rpc,
        Written {
            buffer,
            failed_batches,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_and_batching() {
        let mut b = LogBuffer::new(100, 1 << 20);
        b.push("stdout", "a");
        b.push("stderr", "b");
        let rows = b.take();
        assert_eq!(
            rows.iter().map(|r| (r.seq, r.stream)).collect::<Vec<_>>(),
            vec![(0, "stdout"), (1, "stderr")]
        );
        b.push("stdout", "c");
        assert_eq!(b.take()[0].seq, 2);
        assert_eq!(b.manifest_row("{}").seq, 3);
    }

    #[test]
    fn cap_writes_one_truncated_marker_and_keeps_counting() {
        let mut b = LogBuffer::new(3, 1 << 20);
        for i in 0..10 {
            b.push("stdout", &format!("line {i}"));
        }
        let rows = b.take();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[3].stream, "truncated");
        assert!(rows[3].line.contains("\"after_lines\":3"));
        assert_eq!((b.seen_lines, b.dropped_lines), (10, 7));
        // The manifest row is exempt from the cap.
        let m = b.manifest_row("{\"schema\":\"x\"}");
        assert_eq!((m.seq, m.stream), (4, "manifest"));
    }

    #[test]
    fn byte_cap_applies_too() {
        let mut b = LogBuffer::new(1000, 1024);
        b.push("stdout", &"x".repeat(1000));
        b.push("stdout", &"y".repeat(100));
        let rows = b.take();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].stream, "truncated");
    }

    #[test]
    fn long_lines_split_at_char_boundaries_and_nul_is_replaced() {
        let long = "é".repeat(MAX_LINE); // 2 MiB of two-byte characters
        let parts = split_line(&long);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.len() <= MAX_LINE));
        assert_eq!(parts.concat(), long);
        assert_eq!(split_line("a\0b"), vec!["a\u{FFFD}b".to_owned()]);
    }
}
