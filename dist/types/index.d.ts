declare const INSTRUMENTED_FLAG: "__kubiksOtelDrizzleInstrumented";
export declare const SEMATTRS_DB_SYSTEM = "db.system";
export declare const SEMATTRS_DB_OPERATION = "db.operation";
export declare const SEMATTRS_DB_STATEMENT = "db.statement";
export declare const SEMATTRS_DB_NAME = "db.name";
export declare const SEMATTRS_NET_PEER_NAME = "net.peer.name";
export declare const SEMATTRS_NET_PEER_PORT = "net.peer.port";
type QueryFunction = (...args: any[]) => any;
interface DrizzleClientLike {
    query?: QueryFunction;
    execute?: QueryFunction;
    [INSTRUMENTED_FLAG]?: true;
    [key: string]: any;
}
/**
 * Configuration options for Drizzle instrumentation.
 */
export interface InstrumentDrizzleConfig {
    /**
     * Custom tracer name. Defaults to "\@kubiks/otel-drizzle".
     */
    tracerName?: string;
    /**
     * Database system identifier (e.g., "postgresql", "mysql", "sqlite").
     * Defaults to "postgresql".
     */
    dbSystem?: string;
    /**
     * Database name to include in spans.
     */
    dbName?: string;
    /**
     * Whether to capture full SQL query text in spans.
     * Defaults to true.
     */
    captureQueryText?: boolean;
    /**
     * Maximum length for captured query text. Queries longer than this
     * will be truncated. Defaults to 1000 characters.
     */
    maxQueryTextLength?: number;
    /**
     * Remote hostname or IP address of the database server.
     * Example: "db.example.com" or "192.168.1.100"
     */
    peerName?: string;
    /**
     * Remote port number of the database server.
     * Example: 5432 for PostgreSQL, 3306 for MySQL
     */
    peerPort?: number;
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
export declare function instrumentDrizzle<TClient extends DrizzleClientLike>(client: TClient, config?: InstrumentDrizzleConfig): TClient;
/**
 * Interface for Drizzle database instances with minimal type requirements.
 */
interface DrizzleDbLike {
    $client?: DrizzleClientLike | any;
    execute?: QueryFunction;
    transaction?: QueryFunction;
    _?: {
        session?: {
            execute?: QueryFunction;
            [INSTRUMENTED_FLAG]?: true;
            [key: string]: any;
        };
        [key: string]: any;
    };
    [INSTRUMENTED_FLAG]?: true;
    [key: string]: any;
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
export declare function instrumentDrizzleClient<TDb extends DrizzleDbLike>(db: TDb, config?: InstrumentDrizzleConfig): TDb;
export {};
//# sourceMappingURL=index.d.ts.map