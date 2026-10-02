/**
 * Just enough of a Redis client for the suite's housekeeping: one command
 * over RESP, no dependency. Only ever pointed at the E2E database (index 3).
 */

import net from "node:net";

import { REDIS_URL } from "../env";

function encode(args: string[]): string {
  return `*${String(args.length)}\r\n${args
    .map((arg) => `$${String(Buffer.byteLength(arg))}\r\n${arg}\r\n`)
    .join("")}`;
}

/** Run commands in order on one connection; resolves with the raw replies. */
export function redis(...commands: string[][]): Promise<string> {
  const url = new URL(REDIS_URL);
  const db = url.pathname.replace("/", "") || "0";
  const all = [["SELECT", db], ...commands];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port || 6379), url.hostname);
    let reply = "";
    let lines = 0;
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error("redis: timed out"));
    });
    socket.on("connect", () => {
      socket.write(all.map(encode).join(""));
    });
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      // Every command here answers with a one-line reply (status, integer or error).
      lines = reply.split("\r\n").filter(Boolean).length;
      if (reply.startsWith("-") || reply.includes("\r\n-")) {
        socket.end();
        reject(new Error(`redis: ${reply.trim()}`));
      } else if (lines >= all.length) {
        socket.end();
        resolve(reply);
      }
    });
    socket.on("error", reject);
  });
}

/**
 * Forget every rate-limit counter. The API limits sign-ins, registrations and
 * checkouts per IP, and every browser in the suite is 127.0.0.1: without this
 * the tenth checkout of a run would be refused (velo/core/rate_limit.py).
 */
export async function resetRateLimits(): Promise<void> {
  await redis([
    "EVAL",
    "local n = 0 for _, key in ipairs(redis.call('KEYS', 'velo:rl:*')) do redis.call('DEL', key) n = n + 1 end return n",
    "0",
  ]);
}

/** Empty the E2E Redis database: queues, sandbox intents, caches, counters. */
export async function flushE2eRedis(): Promise<void> {
  await redis(["FLUSHDB"]);
}
