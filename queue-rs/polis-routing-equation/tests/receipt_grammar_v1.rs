//! The receipt format as first published: every receipt recorded here before
//! later rule shapes were added still reads back and writes out byte for byte.
//! The file is a golden file, so the immutability check refuses any change to
//! it; new records are appended in a new file.
#![allow(clippy::unwrap_used, clippy::panic)]

use polis_routing_equation::Drawn;

const RECORDED: &str = include_str!("golden/receipts-v1.txt");

#[test]
fn receipts_recorded_before_piece_three_read_back_identically() {
    let lines: Vec<&str> = RECORDED.lines().collect();
    assert!(!lines.is_empty());
    for line in lines {
        let back = Drawn::from_plain(line).unwrap_or_else(|e| panic!("{line}: {e}"));
        assert_eq!(back.to_plain(), line);
    }
}
