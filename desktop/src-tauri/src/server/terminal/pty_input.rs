//! Blocking PTY input writer, kept off the async runtime.
//!
//! A PTY master write blocks once the slave's input queue is full (a large
//! paste while the foreground program is not reading stdin). Doing that write
//! inside the session run loop parked a tokio worker and stopped output
//! draining, which in turn blocked the program writing stdout: a permanent
//! deadlock. Input now goes through a bounded queue to a dedicated thread that
//! owns the writer and uses `write_all`, so a stalled PTY only stalls input.

use std::io::{self, Write};
use std::sync::Mutex;

use tokio::sync::mpsc;

/// Queued input frames per PTY before `write` applies backpressure.
const PTY_INPUT_QUEUE: usize = 256;

pub(crate) struct PtyInputWriter {
    tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl PtyInputWriter {
    pub(crate) fn spawn(mut writer: Box<dyn Write + Send>) -> Result<Self, String> {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PTY_INPUT_QUEUE);
        std::thread::Builder::new()
            .name("pty-input".to_string())
            .spawn(move || {
                while let Some(data) = rx.blocking_recv() {
                    if let Err(error) = writer.write_all(&data) {
                        eprintln!("[pty] input write failed: {}", error);
                        break;
                    }
                }
                // Dropping the writer here closes the PTY input side.
            })
            .map_err(|e| format!("spawn pty input thread: {}", e))?;
        Ok(Self {
            tx: Mutex::new(Some(tx)),
        })
    }

    /// Queue `data` for the writer thread. Waits (asynchronously) only when the
    /// queue is full; never blocks a runtime thread on the PTY itself.
    pub(crate) async fn write(&self, data: &[u8]) -> io::Result<usize> {
        let tx = self.tx.lock().unwrap().clone();
        let Some(tx) = tx else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "writer closed"));
        };
        tx.send(data.to_vec())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "writer closed"))?;
        Ok(data.len())
    }

    /// Stop accepting input; the thread drops the writer after draining.
    pub(crate) fn close(&self) {
        self.tx.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Condvar};

    /// Writer that blocks every write until released, recording what it got.
    struct GatedWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
        out: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for GatedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cvar) = &*self.gate;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cvar.wait(open).unwrap();
            }
            // Short writes exercise the write_all loop.
            let n = buf.len().min(3);
            self.out.lock().unwrap().extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_pty_does_not_block_the_runtime_and_writes_everything() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let out = Arc::new(Mutex::new(Vec::new()));
        let writer = PtyInputWriter::spawn(Box::new(GatedWriter {
            gate: gate.clone(),
            out: out.clone(),
        }))
        .unwrap();

        // With the PTY "full", queued writes still return promptly on a
        // single-threaded runtime (the old inline write would hang here).
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            writer.write(b"hello ").await.unwrap();
            writer.write(b"world").await.unwrap();
        })
        .await
        .expect("write must not block the runtime while the PTY is stalled");

        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
        writer.close();
        for _ in 0..200 {
            if out.lock().unwrap().len() == 11 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(&*out.lock().unwrap(), b"hello world");
    }

    #[tokio::test]
    async fn write_after_close_is_broken_pipe() {
        let writer = PtyInputWriter::spawn(Box::new(io::sink())).unwrap();
        writer.close();
        let err = writer.write(b"x").await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }
}
