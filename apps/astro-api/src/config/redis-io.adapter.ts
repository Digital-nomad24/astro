import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO backed by Redis pub/sub, so rooms, `server.to(room).emit(...)` and
 * `fetchSockets()` span every instance instead of the local process.
 *
 * This is what makes `--max-instances > 1` safe. Cloud Run's `--session-affinity` is
 * best-effort and cannot be relied on for correctness; the adapter can.
 *
 * Two dedicated connections are required: a connection in subscriber mode cannot issue normal
 * commands, so publish and subscribe must be separate. Both are duplicated from the shared
 * data-plane client so connection options (TLS, retry strategy, auth) live in exactly one
 * place — see `infra/redis/redis.module.ts`.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly baseClient: Redis,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    this.pubClient = this.baseClient.duplicate();
    this.subClient = this.baseClient.duplicate();

    this.pubClient.on('error', (err) =>
      this.logger.error(`Redis pub client error: ${err.message}`),
    );
    this.subClient.on('error', (err) =>
      this.logger.error(`Redis sub client error: ${err.message}`),
    );

    // Wait until both are usable so a broken URL fails fast at boot rather than silently
    // degrading the first broadcasts — which would look like a product bug, not a config one.
    await Promise.all([this.pubClient.ping(), this.subClient.ping()]);

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log('Socket.IO Redis adapter connected (multi-instance mode).');
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (fn: ReturnType<typeof createAdapter>) => void;
    };
    // Ordering matters: `connect()` must have been awaited before this runs, or the server is
    // built with the default in-memory adapter and nothing tells you.
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  /** Framework-invoked on shutdown (shutdown hooks are enabled in `main.ts`). */
  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}
