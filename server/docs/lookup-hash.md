# Optimizing Single-Field Authentication with a Lookup Hash

This document details the "Lookup Hash" or "Pepper" method, a strategy to make single-field authentication (where a user only provides a secret code) both fast and secure. It solves the inefficiency of scanning an entire database table by creating a way to quickly find the right user without compromising on strong password storage.

The solution relies on two core concepts: using two different types of hashes for two different jobs and protecting the weaker hash with a "pepper".

---

## The Core Components

#### 1. The Two-Hash System 🔐

Instead of storing just one hash for the user's `login_code`, you store two:

* **Secure Storage Hash (`bcrypt` hash):** This is the hash you already have. It's generated using a slow, salted algorithm like **`bcrypt`**. Its job is to be extremely difficult to reverse-engineer or "crack," even if an attacker steals your entire database. Because it's slow and salted, it's terrible for searching.
* **Fast Lookup Hash (e.g., `SHA-256` hash):** This is a new hash you'll add. It's generated using a fast, deterministic algorithm like **`SHA-256`**. "Deterministic" means the same input always produces the same output. Its only job is to be a pointer, allowing you to find a specific database row instantly.

#### 2. The Pepper 🌶️

A **pepper** is a secret string of characters that is stored exclusively in your application's configuration (e.g., an environment variable), not in the database. It is added to the `login_code` *before* creating the fast lookup hash.

Its purpose is to add a critical layer of security. If an attacker only steals your database, the lookup hashes are useless to them. Without knowing the secret pepper used to create them, they cannot use techniques like rainbow tables to figure out the original login codes.

---

## The Implementation in Detail

The process can be broken down into two phases: what happens when a code is created and what happens when a user logs in.

#### Phase 1: Setup and Storing the Code

This happens when a user is created or their `login_code` is set/updated.

1. **Database Change:** Add a new column to your `treevite_login_codes` table, perhaps named `login_code_lookup`.

2. **Create an Index:** Create a compound database index on the `(zid, login_code_lookup)` columns. This step is **essential** for making the login query fast.

3. **Generate Hashes:** When a user provides a new plain-text `loginCode`:
    * Generate the secure `bcrypt` hash as you do now:

        ```javascript
        const secureHash = await bcrypt.hash(loginCode, 12);
        ```

    * Generate the fast lookup hash by combining the `loginCode` with your server-side pepper and hashing it:

        ```javascript
        const crypto = require('crypto');
        const lookupHash = crypto.createHash('sha256').update(loginCode + process.env.LOGIN_CODE_PEPPER).digest('hex');
        ```

4. **Store Both:** Save both `secureHash` (in `login_code_hash`) and `lookupHash` (in `login_code_lookup`) in the user's database row.

#### Phase 2: The Login Process

This is the new, efficient flow for your `handle_POST_treevite_login` function.

1. **Receive Input:** The user submits their `zid` and plain-text `loginCode`.

2. **Calculate Lookup Hash:** Your server immediately calculates the lookup hash using the same peppered method:

    ```javascript
    const crypto = require('crypto');
    const lookupHashToFind = crypto.createHash('sha256').update(loginCode + process.env.LOGIN_CODE_PEPPER).digest('hex');
    ```

3. **Perform Fast Query:** Execute a direct, indexed query to find the single matching user.

    ```sql
    SELECT pid, login_code_hash
    FROM treevite_login_codes
    WHERE zid = ($1) AND login_code_lookup = ($2)
    LIMIT 1;
    ```

    Because this query uses the index you created, the database can find the result almost instantly, even with millions of rows.

4. **Handle No Match:** If the query returns no results, the `loginCode` was wrong. You can immediately send a `401 Unauthorized` error.

5. **Verify Secure Hash:** If a user record is found, you take the `login_code_hash` from that row and perform the final, critical security check.

    ```javascript
    const ok = await bcrypt.compare(loginCode, row.login_code_hash);
    ```

6. **Finalize Login:** If `bcrypt.compare` returns `true`, the user is authenticated, and you can proceed with issuing a JWT. If it returns `false` (an extremely rare case called a hash collision), you deny the login.

By implementing this method, you transform an inefficient O(N) search into a highly efficient O(1) lookup, ensuring your login system is both scalable and secure.
