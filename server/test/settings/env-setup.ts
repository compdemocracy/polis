// This will be replaced with a better dotenv solution when the configuration-unification
// branch is merged.

// Note that (for now) you must have a database running for the tests to pass.

process.env.API_SERVER_PORT = '5050'; // Must be different than server port to avoid collision.
process.env.DATABASE_URL = 'postgres://postgres:oiPorg3Nrz0yqDLE@localhost:5432/polis-dev';
