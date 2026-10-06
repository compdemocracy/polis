//! SIGTERM/SIGINT (build spec §1.6). The daemon is PID 1 in its container, so
//! the kernel would ignore these signals without a handler. The handler only
//! sets a flag; the main loop stops claiming, every job task kills and reaps
//! its child's group, ends the attempt with
//! `pq_fail(…, false, 'interrupted_by_shutdown', true)`, deletes its journal
//! entry and flushes its logs, and the process exits 0.
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    REQUESTED.store(true, Ordering::SeqCst);
}

pub fn install() {
    let handler: extern "C" fn(libc::c_int) = on_signal;
    for sig in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: the handler is async-signal-safe (one atomic store).
        unsafe {
            libc::signal(sig, handler as libc::sighandler_t);
        }
    }
}

pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}
