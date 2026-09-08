'use strict';
// The real simulator discards supplied user_id and generates Mongo IDs via Faker.
// Seed its synthetic identity generator so a recording survives a full stack rebuild.
// This never seeds crypto or replaces the simulator's authentication implementation.
require('@faker-js/faker').faker.seed(27);
