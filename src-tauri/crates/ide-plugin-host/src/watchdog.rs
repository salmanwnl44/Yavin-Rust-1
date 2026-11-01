//! The host's backstop (EXT-10): every entry into an extension runs under a deadline that
//! QuickJS's interrupt handler enforces -- but only where QuickJS checks for interrupts. Code that
//! keeps it from checking (a long native operation) would hold the host past any deadline. The
//! watchdog is a thread of its own: an entry still running at twice its limit plus a second
//! ends the whole process, which Yavin sees as a crash -- the extension's work is stopped for
//! certain, not abandoned while it runs on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The exit code of a host the watchdog ended.
pub const EXIT_CODE: i32 = 70;

/// How much past its limit an entry may run before the process ends.
pub fn allowance(limit_ms: u64) -> u64 {
    limit_ms.saturating_mul(2).saturating_add(1_000)
}

struct State {
    epoch: Instant,
    /// When the current entry must be over, in ms since `epoch`; 0: none running.
    until: AtomicU64,
}

/// One per host. `enter` before an entry, `leave` after it.
pub struct Watchdog {
    state: Arc<State>,
}

impl Watchdog {
    /// A watchdog that ends this process (`EXIT_CODE`) when an entry runs past its allowance.
    pub fn start() -> Watchdog {
        Watchdog::with(Box::new(|| {
            eprintln!(
                "An extension ran past its time limit and could not be interrupted: the extension host ends."
            );
            std::process::exit(EXIT_CODE);
        }))
    }

    /// A watchdog that calls `expired` instead (tests).
    pub fn with(expired: Box<dyn Fn() + Send>) -> Watchdog {
        let state = Arc::new(State {
            epoch: Instant::now(),
            until: AtomicU64::new(0),
        });
        let watched = Arc::downgrade(&state);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            // The watchdog ends with its host.
            let Some(state) = watched.upgrade() else {
                return;
            };
            let until = state.until.load(Ordering::SeqCst);
            let now = state.epoch.elapsed().as_millis() as u64;
            if until != 0 && now > until {
                state.until.store(0, Ordering::SeqCst);
                expired();
            }
        });
        Watchdog { state }
    }

    /// An entry with a limit of `limit_ms` begins.
    pub fn enter(&self, limit_ms: u64) {
        let now = self.state.epoch.elapsed().as_millis() as u64;
        self.state.until.store(
            now.saturating_add(allowance(limit_ms)).max(1),
            Ordering::SeqCst,
        );
    }

    /// It is over.
    pub fn leave(&self) {
        self.state.until.store(0, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn fired() -> (Watchdog, Arc<AtomicBool>) {
        let fired = Arc::new(AtomicBool::new(false));
        let flag = fired.clone();
        let watchdog = Watchdog::with(Box::new(move || flag.store(true, Ordering::SeqCst)));
        (watchdog, fired)
    }

    #[test]
    fn an_entry_that_outlives_its_allowance_ends_the_host() {
        let (watchdog, fired) = fired();
        // A 0 ms limit: an allowance of 1 s.
        watchdog.enter(0);
        std::thread::sleep(Duration::from_millis(1_400));
        assert!(fired.load(Ordering::SeqCst));
    }

    #[test]
    fn entries_within_their_allowance_and_idle_time_do_not() {
        let (watchdog, fired) = fired();
        for _ in 0..5 {
            watchdog.enter(0);
            std::thread::sleep(Duration::from_millis(100));
            watchdog.leave();
        }
        // Idle for longer than any allowance: nothing is running.
        std::thread::sleep(Duration::from_millis(1_300));
        assert!(!fired.load(Ordering::SeqCst));
    }

    #[test]
    fn the_allowance_is_twice_the_limit_and_a_second() {
        assert_eq!(allowance(2_000), 5_000);
        assert_eq!(allowance(0), 1_000);
        assert_eq!(allowance(u64::MAX), u64::MAX);
    }
}
