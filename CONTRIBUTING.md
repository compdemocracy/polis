# Contributing to Polis

## Running E2E Tests

End-to-end (E2E) tests are tests that puppet a real browser to drive simulated user interactions on a functional copy of the website.

Requirements: Docker & docker-compose installed locally.

Though these tests are useful when developing new features on your own feature branch,
it's first helpful to ensure you can run them against a known-good version of the application.
The project builds [working docker container images nightly][nightlies],
using the codebase on the mainline `dev` branch,
so we'll pull and run those first.

   [nightlies]: https://hub.docker.com/u/polisdemo

```
git clone https://github.com/compdemocracy/polis
cd polis
make pull
make start
```

You can confirm that this is running here: `http://127.0.0.1`

Your local application is running inside Docker! Now, to prepare your Cypress testing environment:

```
make e2e-install
```

You can then run a minimal test suite with:

```
make e2e-run-minimal
```

If for whatever reason, Docker is serving your application from a remote IP or URL instead of `http://127.0.0.1`, then there are work-arounds:

```
make e2e-run-minimal BASEURL=https://123.45.67.89.xip.io
make e2e-run-minimal BASEURL=https://mydomain.dev # Won't work right now
```

(Specifically, [xip.io](https://xip.io) is a free third-party support service that allows any IP to "pretend" it's a domain.
There is currently a hardcoded "allow list" in the codebase,
that lets this service work in the "development mode" that our Docker environment currently uses.)

Once you've confirmed that these work, you're good to make some changes and try testing your own version of the codebase.
You'll need to rebuild the Docker containers locally, which can take more time than pulling pre-built ones like before.

After ensuring you're back in the project root directory, run:

```
make prepare-e2e
make start-rebuild
make e2e-run-standalone
```

### Tests requiring third-party credentials

Some of our E2E tests require third-party credentials, which are acquired as described here:
- [Google Translate credentials](/docs/deployment.md#enabling-comment-translation)

Once you have those credentials in place, you can run these specific tests via:

```
make e2e-run-secret
```

## :telephone_receiver: Open Calls

:clock10: **When?** Every Saturday at 19:00 UTC (noon PT / 3pm ET / [your timezone][]) \
:raising_hand: **Where?** [`meet.jit.si/pol.is`](https://meet.jit.si/pol.is) (video chatroom) \
:pencil: **Call Notes**: [`bit.ly/polis-calls2`](https://bit.ly/polis-calls2)

   [your timezone]: https://www.worldtimebuddy.com/event?lid=100%2C8%2C1668341%2C5&h=100&sts=26493120&sln=19-20&a=show&euid=d53410dd-f948-c1a4-3dde-31ac0adf894d

- We run **weekly** community calls, open to **anyone**.
- We especially welcome **newcomers**, and contributors who are **under-represented in open source!**
- If you can only drop by irregularly, then the **first call of the month is usually the most active**.

## :muscle: How We Work

- We're working on establishing our collaboration practices. Expect this section to be expanded very soon!
