use crate::{Error, Notification};
use futures_util::Stream;
use std::collections::VecDeque;
use std::future::{self, Future};
use std::ops::{Deref, DerefMut};
use std::pin::{Pin, pin};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::runtime::Runtime;
use tokio_postgres::AsyncMessage;
use tokio_postgres::error::DbError;

pub struct Connection {
    runtime: Runtime,
    io_timeout: Option<std::time::Duration>,
    deadline: Option<std::time::Instant>,
    connection: Pin<Box<dyn Stream<Item = Result<AsyncMessage, Error>> + Send>>,
    notifications: VecDeque<Notification>,
    notice_callback: Arc<dyn Fn(DbError) + Sync + Send>,
}

impl Connection {
    pub fn new<S, T>(
        runtime: Runtime,
        connection: tokio_postgres::Connection<S, T>,
        notice_callback: Arc<dyn Fn(DbError) + Sync + Send>,
    ) -> Connection
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static + Send,
        T: AsyncRead + AsyncWrite + Unpin + 'static + Send,
    {
        Connection {
            runtime,
            io_timeout: None,
            deadline: None,
            connection: Box::pin(ConnectionStream { connection }),
            notifications: VecDeque::new(),
            notice_callback,
        }
    }

    pub fn io_timeout(&mut self, timeout: Option<std::time::Duration>) {
        self.io_timeout = timeout;
    }

    pub fn deadline(&mut self, deadline: Option<std::time::Instant>) {
        self.deadline = deadline;
    }

    pub fn as_ref(&mut self) -> ConnectionRef<'_> {
        ConnectionRef { connection: self }
    }

    pub fn enter<F, T>(&self, f: F) -> T
    where
        F: FnOnce() -> T,
    {
        let _guard = self.runtime.enter();
        f()
    }

    pub fn block_on<F, T>(&mut self, future: F) -> Result<T, Error>
    where
        F: Future<Output = Result<T, Error>>,
    {
        let mut future = pin!(future);
        self.poll_block_on(|cx, _, _| future.as_mut().poll(cx))
    }

    pub fn poll_block_on<F, T>(&mut self, mut f: F) -> Result<T, Error>
    where
        F: FnMut(&mut Context<'_>, &mut VecDeque<Notification>, bool) -> Poll<Result<T, Error>>,
    {
        let deadline = match (self.deadline, self.io_timeout) {
            (Some(absolute), Some(timeout)) => {
                Some(absolute.min(std::time::Instant::now() + timeout))
            }
            (absolute, None) => absolute,
            (None, Some(timeout)) => Some(std::time::Instant::now() + timeout),
        };
        let connection = &mut self.connection;
        let notifications = &mut self.notifications;
        let notice_callback = &mut self.notice_callback;
        let work = future::poll_fn(|cx| {
            let done = loop {
                match connection.as_mut().poll_next(cx) {
                    Poll::Ready(Some(Ok(AsyncMessage::Notification(notification)))) => {
                        notifications.push_back(notification);
                    }
                    Poll::Ready(Some(Ok(AsyncMessage::Notice(notice)))) => notice_callback(notice),
                    Poll::Ready(Some(Ok(_))) => {}
                    Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                    Poll::Ready(None) => break true,
                    Poll::Pending => break false,
                }
            };

            f(cx, notifications, done)
        });
        let result = self.runtime.block_on(async {
            match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline.into(), work).await,
                None => Ok(work.await),
            }
        });
        match result {
            Ok(result) => result,
            Err(_) => {
                // Dropping the connection stream closes the actual socket and
                // its request receiver before the caller can release a slot.
                self.connection = Box::pin(futures_util::stream::empty());
                Err(Error::__private_api_timeout())
            }
        }
    }

    pub fn notifications(&self) -> &VecDeque<Notification> {
        &self.notifications
    }

    pub fn notifications_mut(&mut self) -> &mut VecDeque<Notification> {
        &mut self.notifications
    }
}

pub struct ConnectionRef<'a> {
    connection: &'a mut Connection,
}

// no-op impl to extend the borrow until drop
impl Drop for ConnectionRef<'_> {
    #[inline]
    fn drop(&mut self) {}
}

impl Deref for ConnectionRef<'_> {
    type Target = Connection;

    #[inline]
    fn deref(&self) -> &Connection {
        self.connection
    }
}

impl DerefMut for ConnectionRef<'_> {
    #[inline]
    fn deref_mut(&mut self) -> &mut Connection {
        self.connection
    }
}

struct ConnectionStream<S, T> {
    connection: tokio_postgres::Connection<S, T>,
}

impl<S, T> Stream for ConnectionStream<S, T>
where
    S: AsyncRead + AsyncWrite + Unpin,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Item = Result<AsyncMessage, Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.connection.poll_message(cx)
    }
}
