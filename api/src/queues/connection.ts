/**
 * The `ioredis` connection BullMQ's `Queue`s use to enqueue jobs.
 *
 * `maxRetriesPerRequest: null` is BullMQ's own documented requirement for any
 * connection it manages — without it, a Redis blip can make an in-flight
 * command reject instead of BullMQ's own retry/backoff logic handling it.
 */

import { Redis } from 'ioredis';

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
