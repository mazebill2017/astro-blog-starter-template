// worker-configuration.d.ts
// Generated types for Cloudflare Workers environment

export {};

declare global {
  const DB: D1Database;
  
  interface Env {
    DB: D1Database;
    API_KEY: string;
    API_VERSION: string;
    ENVIRONMENT: string;
  }
}

// Extended D1 types for better type safety
declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1Result<unknown>>;
}

declare interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<{ columns: string[]; results: T[] }>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

declare interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  error?: string;
  meta: {
    duration?: number;
    size_after?: number;
    rows_read?: number;
    rows_written?: number;
    last_row_id?: number;
    changed_db?: boolean;
    changes?: number;
  };
  results?: T[];
}
