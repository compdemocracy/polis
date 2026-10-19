//! `Date.now()`. The Node route stamps `lastVoteTimestamp` on a conversation
//! with no math, and times its 3 s caches, with it.
//!
//! Conformance builds (`--features fixture-clock`) honour
//! `POLIS_API_FIXTURE_CLOCK=<ms>`, the counterpart of the characterization
//! harness's frozen `Date.now()`; other builds always read the system clock.

#[cfg(feature = "fixture-clock")]
tokio::task_local! {
    static REQUEST_CLOCK: Option<f64>;
}

/// Scope the test header to this request future, never a process-wide clock.
/// Production builds ignore it. Missing/invalid values use the frozen env
/// fallback, just as existing byte replays do.
#[cfg(any(feature = "fixture-clock", test))]
pub async fn for_request<F: std::future::Future>(header: Option<&str>, future: F) -> F::Output {
    #[cfg(feature = "fixture-clock")]
    {
        let value = header
            .filter(|v| !v.is_empty() && v.len() <= 16 && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v <= 8_640_000_000_000_000)
            .map(|v| v as f64);
        REQUEST_CLOCK.scope(value, future).await
    }
    #[cfg(not(feature = "fixture-clock"))]
    {
        let _ = header;
        future.await
    }
}

pub fn now_ms() -> f64 {
    #[cfg(feature = "fixture-clock")]
    {
        if let Ok(Some(ms)) = REQUEST_CLOCK.try_with(|v| *v) {
            return ms;
        }
        static FIXED: std::sync::OnceLock<Option<f64>> = std::sync::OnceLock::new();
        if let Some(ms) = FIXED.get_or_init(|| {
            std::env::var("POLIS_API_FIXTURE_CLOCK")
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
        }) {
            return *ms;
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "fixture-clock")]
    #[tokio::test]
    async fn request_clocks_are_isolated_and_restore_fallback() {
        let fallback = now_ms();
        let read = |value| async move {
            for_request(Some(value), async {
                tokio::task::yield_now().await;
                now_ms()
            })
            .await
        };
        let (a, b) = tokio::join!(read("1700000010000"), read("1700000020000"));
        assert_eq!(a, 1700000010000.0);
        assert_eq!(b, 1700000020000.0);
        for bad in [
            None,
            Some("NaN"),
            Some("1.5"),
            Some("-1"),
            Some("8640000000000001"),
            Some("1, 2"),
        ] {
            let got = for_request(bad, async { now_ms() }).await;
            assert!(got >= fallback && got != a && got != b);
        }
        assert!(now_ms() >= fallback);
    }

    #[cfg(not(feature = "fixture-clock"))]
    #[tokio::test]
    async fn production_ignores_fixture_clock_header() {
        let before = now_ms();
        let got = for_request(Some("1"), async { now_ms() }).await;
        assert!(got >= before && got <= now_ms());
        assert_ne!(got, 1.0);
    }
}
