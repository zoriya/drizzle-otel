import { context, SpanKind, SpanStatusCode, trace, } from "@opentelemetry/api";
import { DrizzleQueryError } from "drizzle-orm";
const DEFAULT_TRACER_NAME = "@kubiks/otel-drizzle";
const DEFAULT_DB_SYSTEM = "postgresql";
const INSTRUMENTED_FLAG = "__kubiksOtelDrizzleInstrumented";
// Semantic conventions for database attributes
export const SEMATTRS_DB_SYSTEM = "db.system";
export const SEMATTRS_DB_OPERATION = "db.operation";
export const SEMATTRS_DB_STATEMENT = "db.statement";
export const SEMATTRS_DB_NAME = "db.name";
// Semantic conventions for network attributes
export const SEMATTRS_NET_PEER_NAME = "net.peer.name";
export const SEMATTRS_NET_PEER_PORT = "net.peer.port";
/**
 * Extracts SQL query text from various query argument formats.
 */
function extractQueryText(queryArg) {
    if (typeof queryArg === "string") {
        return queryArg;
    }
    if (queryArg && typeof queryArg === "object") {
        // Generic SQL object format (used by LibSQL, MySQL, and others)
        if (typeof queryArg.sql === "string") {
            return queryArg.sql;
        }
        // PostgreSQL-style query object
        if (typeof queryArg.text === "string") {
            return queryArg.text;
        }
        // Drizzle SQL object
        if (typeof queryArg.queryChunks === "object") {
            // Drizzle query objects may have complex structure, try to extract meaningful info
            const drizzleQuery = queryArg;
            if (typeof drizzleQuery.sql === "string") {
                return drizzleQuery.sql;
            }
        }
    }
    return undefined;
}
/**
 * Sanitizes and truncates query text for safe inclusion in spans.
 */
function sanitizeQueryText(queryText, maxLength) {
    if (queryText.length <= maxLength) {
        return queryText;
    }
    return `${queryText.substring(0, maxLength)}...`;
}
/**
 * Extracts the SQL operation (SELECT, INSERT, etc.) from query text.
 */
function extractOperation(queryText) {
    const trimmed = queryText.trimStart();
    const match = /^(?<op>\w+)/u.exec(trimmed);
    return match?.groups?.op?.toUpperCase();
}
/**
 * Finalizes a span with status, timing, and optional error.
 */
function finalizeSpan(span, error) {
    if (error) {
        if (error instanceof DrizzleQueryError && error.cause) {
            // special handling for node-postgres
            if ("detail" in error.cause && typeof error.cause.detail === "string")
                error.cause.stack = error.cause.detail;
            span.recordException(error.cause);
        }
        else if (error instanceof Error) {
            span.recordException(error);
        }
        else {
            span.recordException(new Error(String(error)));
        }
        span.setStatus({ code: SpanStatusCode.ERROR });
    }
    else {
        span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
}
/**
 * Instruments a database connection pool/client with OpenTelemetry tracing.
 *
 * This function wraps the connection's `query` and `execute` methods to create spans for each database
 * operation.
 * The instrumentation is idempotent - calling it multiple times on the same connection will only
 * instrument it once.
 *
 * @typeParam TClient - The type of the database connection pool or client
 * @param client - The database connection pool or client to instrument
 * @param config - Optional configuration for instrumentation behavior
 * @returns The instrumented pool/client (same instance, modified in place)
 *
 * @example
 * ```typescript
 * // PostgreSQL with node-postgres
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * import { Pool } from 'pg';
 * import { instrumentDrizzle } from '@kubiks/otel-drizzle';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const instrumentedPool = instrumentDrizzle(pool, {
 *   dbSystem: 'postgresql',
 *   dbName: 'myapp',
 *   peerName: 'db.example.com',
 *   peerPort: 5432,
 * });
 * const db = drizzle({ client: instrumentedPool });
 * ```
 *
 * @example
 * ```typescript
 * // MySQL with mysql2
 * import { drizzle } from 'drizzle-orm/mysql2';
 * import mysql from 'mysql2/promise';
 * import { instrumentDrizzle } from '@kubiks/otel-drizzle';
 *
 * const connection = await mysql.createConnection({
 *   host: 'localhost',
 *   user: 'root',
 *   database: 'mydb',
 * });
 * const instrumentedConnection = instrumentDrizzle(connection, { dbSystem: 'mysql' });
 * const db = drizzle({ client: instrumentedConnection });
 * ```
 *
 * @example
 * ```typescript
 * // SQLite with better-sqlite3
 * import { drizzle } from 'drizzle-orm/better-sqlite3';
 * import Database from 'better-sqlite3';
 * import { instrumentDrizzle } from '@kubiks/otel-drizzle';
 *
 * const sqlite = new Database('sqlite.db');
 * const instrumentedSqlite = instrumentDrizzle(sqlite, { dbSystem: 'sqlite' });
 * const db = drizzle({ client: instrumentedSqlite });
 * ```
 *
 * @example
 * ```typescript
 * // LibSQL/Turso
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 * import { instrumentDrizzle } from '@kubiks/otel-drizzle';
 *
 * const client = createClient({
 *   url: process.env.DATABASE_URL!,
 *   authToken: process.env.DATABASE_AUTH_TOKEN,
 * });
 * const instrumentedClient = instrumentDrizzle(client, { dbSystem: 'sqlite' });
 * const db = drizzle({ client: instrumentedClient });
 * ```
 */
export function instrumentDrizzle(client, config) {
    if (!client) {
        return client;
    }
    // Check if client has query or execute method
    const hasQuery = typeof client.query === "function";
    const hasExecute = typeof client.execute === "function";
    if (!hasQuery && !hasExecute) {
        return client;
    }
    if (client[INSTRUMENTED_FLAG]) {
        return client;
    }
    const { tracerName = DEFAULT_TRACER_NAME, dbSystem = DEFAULT_DB_SYSTEM, dbName, captureQueryText = true, maxQueryTextLength = 1000, peerName, peerPort, } = config ?? {};
    const tracer = trace.getTracer(tracerName);
    // Store the original method (query or execute)
    const methodName = hasQuery ? "query" : "execute";
    const originalMethod = hasQuery ? client.query : client.execute;
    if (!originalMethod) {
        return client;
    }
    const instrumentedMethod = function instrumented(...incomingArgs) {
        const args = [...incomingArgs];
        let callback;
        // Detect callback pattern
        if (typeof args[args.length - 1] === "function") {
            callback = args.pop();
        }
        // Extract query information
        const queryText = extractQueryText(args[0]);
        const operation = queryText ? extractOperation(queryText) : undefined;
        const spanName = operation
            ? `drizzle.${operation.toLowerCase()}`
            : "drizzle.query";
        // Start span
        const span = tracer.startSpan(spanName, { kind: SpanKind.CLIENT });
        span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
        if (operation) {
            span.setAttribute(SEMATTRS_DB_OPERATION, operation);
        }
        if (dbName) {
            span.setAttribute(SEMATTRS_DB_NAME, dbName);
        }
        if (captureQueryText && queryText !== undefined) {
            const sanitized = sanitizeQueryText(queryText, maxQueryTextLength);
            span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
        }
        if (peerName) {
            span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
        }
        if (peerPort) {
            span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
        }
        const activeContext = trace.setSpan(context.active(), span);
        // Callback-based pattern
        if (callback) {
            return context.with(activeContext, () => {
                const wrappedCallback = (err, result) => {
                    finalizeSpan(span, err);
                    if (callback) {
                        callback(err, result);
                    }
                };
                try {
                    return originalMethod.apply(this, [...args, wrappedCallback]);
                }
                catch (error) {
                    finalizeSpan(span, error);
                    throw error;
                }
            });
        }
        // Promise-based pattern
        return context.with(activeContext, () => {
            try {
                const result = originalMethod.apply(this, args);
                return Promise.resolve(result)
                    .then((value) => {
                    finalizeSpan(span);
                    return value;
                })
                    .catch((error) => {
                    finalizeSpan(span, error);
                    throw error;
                });
            }
            catch (error) {
                finalizeSpan(span, error);
                throw error;
            }
        });
    };
    client[INSTRUMENTED_FLAG] = true;
    // Replace the original method with the instrumented one
    if (hasQuery) {
        client.query = instrumentedMethod;
    }
    else {
        client.execute = instrumentedMethod;
    }
    return client;
}
/**
 * Instruments a Drizzle database instance with OpenTelemetry tracing.
 *
 * This function instruments the database at the session level, automatically tracing all database
 * operations including query builders, direct SQL execution, and transactions.
 *
 * The instrumentation is idempotent - calling it multiple times on the same
 * database will only instrument it once.
 *
 * @typeParam TDb - The type of the Drizzle database instance
 * @param db - The Drizzle database instance to instrument
 * @param config - Optional configuration for instrumentation behavior
 * @returns The instrumented database instance (same instance, modified in place)
 *
 * @example
 * ```typescript
 * // PostgreSQL with postgres.js
 * import { drizzle } from 'drizzle-orm/postgres-js';
 * import postgres from 'postgres';
 * import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
 *
 * // Using connection string
 * const db = drizzle(process.env.DATABASE_URL!);
 * instrumentDrizzleClient(db, { dbSystem: 'postgresql' });
 *
 * // Or with a client instance
 * const queryClient = postgres(process.env.DATABASE_URL!);
 * const db = drizzle({ client: queryClient });
 * instrumentDrizzleClient(db, { dbSystem: 'postgresql' });
 * ```
 *
 * @example
 * ```typescript
 * // PostgreSQL with node-postgres (pg)
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * import { Pool } from 'pg';
 * import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
 *
 * // Using connection string
 * const db = drizzle(process.env.DATABASE_URL!);
 * instrumentDrizzleClient(db, { dbSystem: 'postgresql' });
 *
 * // Or with a pool
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle({ client: pool });
 * instrumentDrizzleClient(db, {
 *   dbSystem: 'postgresql',
 *   dbName: 'myapp',
 *   peerName: 'db.example.com',
 *   peerPort: 5432,
 * });
 * ```
 *
 * @example
 * ```typescript
 * // MySQL with mysql2
 * import { drizzle } from 'drizzle-orm/mysql2';
 * import mysql from 'mysql2/promise';
 * import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
 *
 * // Using connection string
 * const db = drizzle(process.env.DATABASE_URL!);
 * instrumentDrizzleClient(db, { dbSystem: 'mysql' });
 *
 * // Or with a connection
 * const connection = await mysql.createConnection({
 *   host: 'localhost',
 *   user: 'root',
 *   database: 'mydb',
 * });
 * const db = drizzle({ client: connection });
 * instrumentDrizzleClient(db, {
 *   dbSystem: 'mysql',
 *   dbName: 'mydb',
 *   peerName: 'localhost',
 *   peerPort: 3306,
 * });
 * ```
 *
 * @example
 * ```typescript
 * // SQLite with better-sqlite3
 * import { drizzle } from 'drizzle-orm/better-sqlite3';
 * import Database from 'better-sqlite3';
 * import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
 *
 * // Using file path
 * const db = drizzle('sqlite.db');
 * instrumentDrizzleClient(db, { dbSystem: 'sqlite' });
 *
 * // Or with a Database instance
 * const sqlite = new Database('sqlite.db');
 * const db = drizzle({ client: sqlite });
 * instrumentDrizzleClient(db, { dbSystem: 'sqlite' });
 * ```
 *
 * @example
 * ```typescript
 * // SQLite with LibSQL/Turso
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 * import { instrumentDrizzleClient } from '@kubiks/otel-drizzle';
 *
 * // Using connection config
 * const db = drizzle({
 *   connection: {
 *     url: process.env.DATABASE_URL!,
 *     authToken: process.env.DATABASE_AUTH_TOKEN,
 *   }
 * });
 * instrumentDrizzleClient(db, { dbSystem: 'sqlite' });
 *
 * // Or with a client instance
 * const client = createClient({
 *   url: process.env.DATABASE_URL!,
 *   authToken: process.env.DATABASE_AUTH_TOKEN,
 * });
 * const db = drizzle({ client });
 * instrumentDrizzleClient(db, { dbSystem: 'sqlite' });
 * ```
 */
export function instrumentDrizzleClient(db, config) {
    if (!db) {
        return db;
    }
    // Check if already instrumented
    if (db[INSTRUMENTED_FLAG]) {
        return db;
    }
    const { tracerName = DEFAULT_TRACER_NAME, dbSystem = DEFAULT_DB_SYSTEM, dbName, captureQueryText = true, maxQueryTextLength = 1000, peerName, peerPort, } = config ?? {};
    const tracer = trace.getTracer(tracerName);
    let instrumented = false;
    // First priority: Instrument the session directly
    // This is where all queries actually go through
    if (db.session && !instrumented) {
        const session = db.session;
        // Check if session has prepareQuery method (used by select/insert/update/delete)
        if (typeof session.prepareQuery === "function" &&
            !session[INSTRUMENTED_FLAG]) {
            const originalPrepareQuery = session.prepareQuery;
            session.prepareQuery = function (...args) {
                const prepared = originalPrepareQuery.apply(this, args);
                // Wrap the prepared query's execute method
                if (prepared && typeof prepared.execute === "function") {
                    const originalPreparedExecute = prepared.execute;
                    prepared.execute = function (...executeArgs) {
                        // Extract query information from the query object
                        const queryObj = args[0]; // The query object passed to prepareQuery
                        const queryText = queryObj?.sql ||
                            queryObj?.queryString ||
                            extractQueryText(queryObj);
                        const operation = queryText
                            ? extractOperation(queryText)
                            : undefined;
                        const spanName = operation
                            ? `drizzle.${operation.toLowerCase()}`
                            : "drizzle.query";
                        // Start span
                        const span = tracer.startSpan(spanName, { kind: SpanKind.CLIENT });
                        span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
                        if (operation) {
                            span.setAttribute(SEMATTRS_DB_OPERATION, operation);
                        }
                        if (dbName) {
                            span.setAttribute(SEMATTRS_DB_NAME, dbName);
                        }
                        if (captureQueryText && queryText !== undefined) {
                            const sanitized = sanitizeQueryText(queryText, maxQueryTextLength);
                            span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
                        }
                        if (peerName) {
                            span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
                        }
                        if (peerPort) {
                            span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
                        }
                        const activeContext = trace.setSpan(context.active(), span);
                        // Execute the prepared query
                        return context.with(activeContext, () => {
                            try {
                                const result = originalPreparedExecute.apply(this, executeArgs);
                                return Promise.resolve(result)
                                    .then((value) => {
                                    finalizeSpan(span);
                                    return value;
                                })
                                    .catch((error) => {
                                    finalizeSpan(span, error);
                                    throw error;
                                });
                            }
                            catch (error) {
                                finalizeSpan(span, error);
                                throw error;
                            }
                        });
                    };
                }
                return prepared;
            };
            session[INSTRUMENTED_FLAG] = true;
            instrumented = true;
        }
        // Also instrument direct query method if exists
        if (typeof session.query === "function" &&
            !session[INSTRUMENTED_FLAG + "_query"]) {
            const originalQuery = session.query;
            session.query = function (queryString, params) {
                const operation = queryString
                    ? extractOperation(queryString)
                    : undefined;
                const spanName = operation
                    ? `drizzle.${operation.toLowerCase()}`
                    : "drizzle.query";
                // Start span
                const span = tracer.startSpan(spanName, { kind: SpanKind.CLIENT });
                span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
                if (operation) {
                    span.setAttribute(SEMATTRS_DB_OPERATION, operation);
                }
                if (dbName) {
                    span.setAttribute(SEMATTRS_DB_NAME, dbName);
                }
                if (captureQueryText && queryString !== undefined) {
                    const sanitized = sanitizeQueryText(queryString, maxQueryTextLength);
                    span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
                }
                if (peerName) {
                    span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
                }
                if (peerPort) {
                    span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
                }
                const activeContext = trace.setSpan(context.active(), span);
                // Execute the query
                return context.with(activeContext, () => {
                    try {
                        const result = originalQuery.apply(this, [queryString, params]);
                        return Promise.resolve(result)
                            .then((value) => {
                            finalizeSpan(span);
                            return value;
                        })
                            .catch((error) => {
                            finalizeSpan(span, error);
                            throw error;
                        });
                    }
                    catch (error) {
                        finalizeSpan(span, error);
                        throw error;
                    }
                });
            };
            session[INSTRUMENTED_FLAG + "_query"] = true;
            instrumented = true;
        }
        // Instrument transaction method to ensure transaction sessions are also instrumented
        if (typeof session.transaction === "function" &&
            !session[INSTRUMENTED_FLAG + "_transaction"]) {
            const originalTransaction = session.transaction;
            session.transaction = function (transactionCallback, ...restArgs) {
                // Wrap the transaction callback to instrument the tx object
                const wrappedCallback = async function (tx) {
                    // Instrument the transaction's session if it has one
                    if (tx && (tx.session || tx._?.session || tx)) {
                        const txSession = tx.session || tx._?.session || tx;
                        // Instrument tx.execute if it exists
                        if (typeof tx.execute === "function" &&
                            !tx[INSTRUMENTED_FLAG + "_execute"]) {
                            const originalTxExecute = tx.execute;
                            tx.execute = function (...executeArgs) {
                                const queryText = extractQueryText(executeArgs[0]);
                                const operation = queryText
                                    ? extractOperation(queryText)
                                    : undefined;
                                const spanName = operation
                                    ? `drizzle.${operation.toLowerCase()}`
                                    : "drizzle.query";
                                // Start span
                                const span = tracer.startSpan(spanName, {
                                    kind: SpanKind.CLIENT,
                                });
                                span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
                                span.setAttribute("db.transaction", true);
                                if (operation) {
                                    span.setAttribute(SEMATTRS_DB_OPERATION, operation);
                                }
                                if (dbName) {
                                    span.setAttribute(SEMATTRS_DB_NAME, dbName);
                                }
                                if (captureQueryText && queryText !== undefined) {
                                    const sanitized = sanitizeQueryText(queryText, maxQueryTextLength);
                                    span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
                                }
                                if (peerName) {
                                    span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
                                }
                                if (peerPort) {
                                    span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
                                }
                                const activeContext = trace.setSpan(context.active(), span);
                                // Execute the query
                                return context.with(activeContext, () => {
                                    try {
                                        const result = originalTxExecute.apply(this, executeArgs);
                                        return Promise.resolve(result)
                                            .then((value) => {
                                            finalizeSpan(span);
                                            return value;
                                        })
                                            .catch((error) => {
                                            finalizeSpan(span, error);
                                            throw error;
                                        });
                                    }
                                    catch (error) {
                                        finalizeSpan(span, error);
                                        throw error;
                                    }
                                });
                            };
                            tx[INSTRUMENTED_FLAG + "_execute"] = true;
                        }
                        // Also instrument txSession.prepareQuery if it exists
                        if (typeof txSession.prepareQuery === "function" &&
                            !txSession[INSTRUMENTED_FLAG + "_tx"]) {
                            const originalTxPrepareQuery = txSession.prepareQuery;
                            txSession.prepareQuery = function (...prepareArgs) {
                                const prepared = originalTxPrepareQuery.apply(this, prepareArgs);
                                // Wrap the prepared query's execute method
                                if (prepared && typeof prepared.execute === "function") {
                                    const originalPreparedExecute = prepared.execute;
                                    prepared.execute = function (...executeArgs) {
                                        // Extract query information from the query object
                                        const queryObj = prepareArgs[0]; // The query object passed to prepareQuery
                                        const queryText = queryObj?.sql ||
                                            queryObj?.queryString ||
                                            extractQueryText(queryObj);
                                        const operation = queryText
                                            ? extractOperation(queryText)
                                            : undefined;
                                        const spanName = operation
                                            ? `drizzle.${operation.toLowerCase()}`
                                            : "drizzle.query";
                                        // Start span
                                        const span = tracer.startSpan(spanName, {
                                            kind: SpanKind.CLIENT,
                                        });
                                        span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
                                        span.setAttribute("db.transaction", true);
                                        if (operation) {
                                            span.setAttribute(SEMATTRS_DB_OPERATION, operation);
                                        }
                                        if (dbName) {
                                            span.setAttribute(SEMATTRS_DB_NAME, dbName);
                                        }
                                        if (captureQueryText && queryText !== undefined) {
                                            const sanitized = sanitizeQueryText(queryText, maxQueryTextLength);
                                            span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
                                        }
                                        if (peerName) {
                                            span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
                                        }
                                        if (peerPort) {
                                            span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
                                        }
                                        const activeContext = trace.setSpan(context.active(), span);
                                        // Execute the prepared query
                                        return context.with(activeContext, () => {
                                            try {
                                                const result = originalPreparedExecute.apply(this, executeArgs);
                                                return Promise.resolve(result)
                                                    .then((value) => {
                                                    finalizeSpan(span);
                                                    return value;
                                                })
                                                    .catch((error) => {
                                                    finalizeSpan(span, error);
                                                    throw error;
                                                });
                                            }
                                            catch (error) {
                                                finalizeSpan(span, error);
                                                throw error;
                                            }
                                        });
                                    };
                                }
                                return prepared;
                            };
                            txSession[INSTRUMENTED_FLAG + "_tx"] = true;
                        }
                    }
                    // Call the original callback with the instrumented tx
                    return transactionCallback(tx);
                };
                // Call the original transaction with the wrapped callback
                return originalTransaction.apply(this, [wrappedCallback, ...restArgs]);
            };
            session[INSTRUMENTED_FLAG + "_transaction"] = true;
            instrumented = true;
        }
    }
    if (db.$client && !instrumented) {
        const client = db.$client;
        // Check if client has query or execute function
        if (typeof client.query === "function" ||
            typeof client.execute === "function") {
            instrumentDrizzle(client, config);
            instrumented = true;
        }
    }
    // Third priority: Try to instrument via session.execute as fallback
    if (db._ &&
        db._.session &&
        typeof db._.session.execute === "function" &&
        !instrumented) {
        const session = db._.session;
        // Check if already instrumented
        if (session[INSTRUMENTED_FLAG]) {
            return db;
        }
        const { tracerName = DEFAULT_TRACER_NAME, dbSystem = DEFAULT_DB_SYSTEM, dbName, captureQueryText = true, maxQueryTextLength = 1000, peerName, peerPort, } = config ?? {};
        const tracer = trace.getTracer(tracerName);
        const originalExecute = session.execute;
        if (!originalExecute) {
            return db;
        }
        const instrumentedExecute = function instrumented(...args) {
            // Extract query information
            const queryText = extractQueryText(args[0]);
            const operation = queryText ? extractOperation(queryText) : undefined;
            const spanName = operation
                ? `drizzle.${operation.toLowerCase()}`
                : "drizzle.query";
            // Start span
            const span = tracer.startSpan(spanName, { kind: SpanKind.CLIENT });
            span.setAttribute(SEMATTRS_DB_SYSTEM, dbSystem);
            if (operation) {
                span.setAttribute(SEMATTRS_DB_OPERATION, operation);
            }
            if (dbName) {
                span.setAttribute(SEMATTRS_DB_NAME, dbName);
            }
            if (captureQueryText && queryText !== undefined) {
                const sanitized = sanitizeQueryText(queryText, maxQueryTextLength);
                span.setAttribute(SEMATTRS_DB_STATEMENT, sanitized);
            }
            if (peerName) {
                span.setAttribute(SEMATTRS_NET_PEER_NAME, peerName);
            }
            if (peerPort) {
                span.setAttribute(SEMATTRS_NET_PEER_PORT, peerPort);
            }
            const activeContext = trace.setSpan(context.active(), span);
            // Promise-based pattern (session.execute is typically promise-based)
            return context.with(activeContext, () => {
                try {
                    const result = originalExecute.apply(this, args);
                    return Promise.resolve(result)
                        .then((value) => {
                        finalizeSpan(span);
                        return value;
                    })
                        .catch((error) => {
                        finalizeSpan(span, error);
                        throw error;
                    });
                }
                catch (error) {
                    finalizeSpan(span, error);
                    throw error;
                }
            });
        };
        session[INSTRUMENTED_FLAG] = true;
        session.execute = instrumentedExecute;
        instrumented = true;
    }
    // Mark the db as instrumented if we instrumented anything
    if (instrumented) {
        db[INSTRUMENTED_FLAG] = true;
    }
    return db;
}
//# sourceMappingURL=index.js.map