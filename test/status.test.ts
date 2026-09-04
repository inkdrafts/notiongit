import { describe, expect, test } from 'bun:test';

import {
  admitStatusRerun,
  statusRerunKey,
  STATUS_RERUN_DAILY_LIMIT,
  STATUS_RERUN_SPACING_SECONDS,
  STATUS_RERUN_WINDOW_SECONDS,
} from '../src/status';

class MemoryKV {
  private values = new Map<string, string>();
  private ttls = new Map<string, number>();
  puts = 0;

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts += 1;
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.ttls.delete(key);
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

const ACCOUNT_ID = 42;
const START = 1_700_000_000_000;

describe('admitStatusRerun', () => {
  test('admits the first rerun and the written slot survives even if no dispatch follows', async () => {
    const kv = new MemoryKV();
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START)).resolves.toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toEqual({
      version: 1,
      windowStartedAt: START,
      lastRerunAt: START,
      count: 1,
    });
    expect(kv.ttlFor(statusRerunKey(ACCOUNT_ID))).toBe(STATUS_RERUN_WINDOW_SECONDS);
    const crashed = await admitStatusRerun(kv, ACCOUNT_ID, START + 1000);
    expect(crashed).toMatchObject({ admitted: false, reason: 'spacing' });
  });

  test('refuses a rerun inside the spacing floor and says when to return', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_SPACING_SECONDS - 60) * 1000))
      .resolves.toEqual({ admitted: false, reason: 'spacing', retryAfterSeconds: 60 });
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_SPACING_SECONDS + 1) * 1000))
      .resolves.toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toMatchObject({ count: 2, windowStartedAt: START });
  });

  test('refuses reruns beyond the daily cap until the window rolls', async () => {
    const kv = new MemoryKV();
    for (let attempt = 0; attempt < STATUS_RERUN_DAILY_LIMIT; attempt += 1) {
      const decision = await admitStatusRerun(kv, ACCOUNT_ID, START + attempt * 400_000);
      expect(decision).toEqual({ admitted: true });
    }
    const refusedAt = START + STATUS_RERUN_DAILY_LIMIT * 400_000;
    await expect(admitStatusRerun(kv, ACCOUNT_ID, refusedAt)).resolves.toMatchObject({
      admitted: false,
      reason: 'daily_cap',
    });
    const elapsedSeconds = Math.ceil((refusedAt - START) / 1000);
    const refused = await admitStatusRerun(kv, ACCOUNT_ID, refusedAt);
    expect(refused).toMatchObject({ retryAfterSeconds: STATUS_RERUN_WINDOW_SECONDS - elapsedSeconds });
    expect(kv.puts).toBe(STATUS_RERUN_DAILY_LIMIT);
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!).count).toBe(STATUS_RERUN_DAILY_LIMIT);
  });

  test('a refused rerun writes nothing, so refusals never consume window state', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    const putsAfterAdmission = kv.puts;
    await admitStatusRerun(kv, ACCOUNT_ID, START + 1000);
    expect(kv.puts).toBe(putsAfterAdmission);
  });

  test('an expired window starts over with a fresh count', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    const admitted = await admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000);
    expect(admitted).toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toEqual({
      version: 1,
      windowStartedAt: START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000,
      lastRerunAt: START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000,
      count: 1,
    });
  });

  test('a corrupted or unreadable record fails closed', async () => {
    const kv = new MemoryKV();
    await kv.put(statusRerunKey(ACCOUNT_ID), '{"version":1,"windowStartedAt":"x"}', { expirationTtl: 60 });
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START)).resolves.toMatchObject({
      admitted: false,
      reason: 'unavailable',
    });
    expect(kv.puts).toBe(1);

    const outage = new MemoryKV();
    outage.get = async () => {
      throw new Error('KV outage');
    };
    await expect(admitStatusRerun(outage, ACCOUNT_ID, START)).resolves.toMatchObject({
      admitted: false,
      reason: 'unavailable',
    });
  });

  test('accounts never share a window', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, 42, START);
    await expect(admitStatusRerun(kv, 43, START + 1000)).resolves.toEqual({ admitted: true });
  });
});
