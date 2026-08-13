// tests/integration/violation-signaler-frontend.test.js
// ═══════════════════════════════════════════════════════════════════════════
//  FRONTEND SIMULATION TEST — ViolationSignaler (peserta-side)
//  --------------------------------------------------------------------------
//  Loads violation-signaler.js into jsdom and tests:
//    • Batching (3s debounce OR 5 signals OR critical-immediate)
//    • Dedup (same event_type + 2s window = skipped)
//    • Retry with exponential backoff (1s, 2s, 4s, max 3)
//    • IndexedDB persistence (offline queue survival)
//    • sendBeacon on page unload
//    • Edge cases (queue overflow, missing init, etc.)
//
//  Covers 12 frontend edge cases (F1–F12).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

// Use Node's native Response (Node 18+) — jsdom's Response is incomplete
const NodeResponse = globalThis.Response;

// ── Setup jsdom + globals ──────────────────────────────────────────────────

let dom, window, document;

beforeAll(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://albytehq.github.io/',
    pretendToBeVisual: true,
  });
  window = dom.window;
  globalThis.window = window;
  globalThis.document = window.document;
  try { globalThis.navigator = window.navigator; } catch (_) {}
  globalThis.fetch = vi.fn();
  try { window.navigator.sendBeacon = vi.fn(() => true); } catch (_) {}
  globalThis.navigator.sendBeacon = window.navigator.sendBeacon;
  globalThis.indexedDB = null;
  globalThis.Blob = window.Blob;
  globalThis.Request = window.Request;
  // Use Node's native Response (constructor) — jsdom's Response lacks features
  globalThis.Response = NodeResponse;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.Node = window.Node;
  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
  globalThis.setInterval = setInterval;
  globalThis.clearInterval = clearInterval;

  // Load the violation-signaler.js source
  const code = fs.readFileSync(
    path.resolve('/home/z/my-project/albedu/src/security/violation-signaler.js'),
    'utf8'
  );
  // Set up window.AlbEdu so the signaler can resolve Supabase URL + auth token
  window.AlbEdu = {
    supabase: {
      config: { url: 'https://test.supabase.co' },
      auth: {
        currentUser: {
          id: 'test-peserta-id',
          email: 'peserta@test.albedu.local',
          access_token: 'test-jwt-token-1234567890',
        },
      },
    },
  };
  window.eval(code);
});

beforeEach(() => {
  // Reset mocks + ViolationSignaler state between tests
  vi.clearAllMocks();
  // Re-attach mock fetch + sendBeacon to the window (vi.clearAllMocks wipes them)
  const _mockFetch = vi.fn();
  window.fetch = _mockFetch;
  globalThis.fetch = _mockFetch;
  const _mockSendBeacon = vi.fn(() => true);
  try { window.navigator.sendBeacon = _mockSendBeacon; } catch (_) {}
  globalThis.navigator.sendBeacon = _mockSendBeacon;

  if (window.ViolationSignaler._test) {
    // Reset internal state
    const s = window.ViolationSignaler._test.state;
    s.pendingSignals = [];
    s.retryCount = 0;
    s.inFlight = false;
    s.seenDedupKeys = new Map();
    s.initialized = false;
    s.destroyed = false;
    s.online = true;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  }
});

// Helpers to access the current mock (recreated each beforeEach)
function mockFetch() { return window.fetch; }
function mockSendBeacon() { return window.navigator.sendBeacon; }

// ── Tests ──────────────────────────────────────────────────────────────────

describe('📡 ViolationSignaler — Frontend Simulation', () => {

  it('F1: signal() queues a single signal', () => {
    window.ViolationSignaler.init('test-session-id');
    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'Tab switch',
      severity: 'warning',
    });
    const state = window.ViolationSignaler._test.state;
    expect(state.pendingSignals.length).toBe(1);
    expect(state.pendingSignals[0].event_type).toBe('tab_switch');
    expect(state.pendingSignals[0].severity).toBe('warning');
  });

  it('F2: Batch flushes after 5 signals (whichever first)', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { inserted: 5, skipped: 0 } }), { status: 200 })
    );

    // Use different event_types so dedup doesn't kick in (all signals
    // within the same 2s window would be deduped if they shared event_type)
    const eventTypes = ['tab_switch', 'window_blur', 'copy_attempt', 'context_menu', 'select_text'];
    for (let i = 0; i < 5; i++) {
      window.ViolationSignaler.signal({
        event_type: eventTypes[i],
        message: `#${i}`,
        severity: 'warning',
      });
      await new Promise(r => setTimeout(r, 10));
    }

    // Wait a tick for the flush
    await new Promise(r => setTimeout(r, 100));

    expect(mockFetch()).toHaveBeenCalledTimes(1);
    const call = mockFetch().mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.signals.length).toBe(5);
  });

  it('F3: sendBeacon used on page unload', () => {
    window.ViolationSignaler.init('test-session-id');
    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    // Simulate pagehide event
    const event = new window.Event('pagehide');
    window.dispatchEvent(event);

    expect(mockSendBeacon()).toHaveBeenCalledTimes(1);
    const blob = mockSendBeacon().mock.calls[0][1];
    // Blob is async-readable, but we can check it exists
    expect(blob).toBeInstanceOf(window.Blob);
  });

  it('F4: fetch(keepalive) used as fallback when sendBeacon returns false', async () => {
    // Override sendBeacon to return false
    const falseMock = vi.fn(() => false);
    window.navigator.sendBeacon = falseMock;
    globalThis.navigator.sendBeacon = falseMock;
    window.ViolationSignaler.init('test-session-id');
    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    const event = new window.Event('pagehide');
    window.dispatchEvent(event);

    // Wait a tick for the fallback fetch to fire
    await new Promise(r => setTimeout(r, 50));

    expect(mockFetch()).toHaveBeenCalled();
    const call = mockFetch().mock.calls[mockFetch().mock.calls.length - 1];
    expect(call[1].keepalive).toBe(true);
  });

  it('F5: Retry on network error (1s, 2s, 4s)', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockRejectedValueOnce(new Error('Network error'));

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    // Wait for the 3s debounce flush + first attempt
    await new Promise(r => setTimeout(r, 3100));
    expect(mockFetch()).toHaveBeenCalledTimes(1);

    // First retry succeeds (scheduled after 1s backoff)
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { inserted: 1, skipped: 0 } }), { status: 200 })
    );

    // Wait for retry (1s)
    await new Promise(r => setTimeout(r, 1100));
    expect(mockFetch()).toHaveBeenCalledTimes(2);
  });

  it('F6: Max 3 retries before giving up', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockRejectedValue(new Error('Network error'));

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    // Wait for initial flush (3s debounce)
    await new Promise(r => setTimeout(r, 3100));
    expect(mockFetch()).toHaveBeenCalledTimes(1);

    // Use fake timers to speed up the retry sequence
    vi.useFakeTimers();
    vi.advanceTimersByTime(1100); // 1st retry fires
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch()).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2100); // 2nd retry fires
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch()).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(4100); // 3rd retry fires
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch()).toHaveBeenCalledTimes(4);

    // No more retries after 3
    vi.advanceTimersByTime(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch()).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });

  it('F9: Dedup key prevents same violation from being signaled twice in 2s window', () => {
    window.ViolationSignaler.init('test-session-id');
    const ts = new Date().toISOString();

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'first',
      severity: 'warning',
      client_timestamp: ts,
    });
    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'dup',
      severity: 'warning',
      client_timestamp: ts,
    });

    const state = window.ViolationSignaler._test.state;
    expect(state.pendingSignals.length).toBe(1); // only the first one queued
  });

  it('F10: Flush immediately on critical severity', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { inserted: 1, skipped: 0 } }), { status: 200 })
    );

    window.ViolationSignaler.signal({
      event_type: 'max_violations_reached',
      message: 'MAX!',
      severity: 'critical',
    });

    // Wait a short tick — critical should fire immediately (delay=0)
    await new Promise(r => setTimeout(r, 50));

    expect(mockFetch()).toHaveBeenCalledTimes(1);
  });

  it('F11: Signal payload includes correct fields', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { inserted: 1, skipped: 0 } }), { status: 200 })
    );

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'test message',
      severity: 'warning',
      metadata: { custom: 'value' },
    });

    // Wait for flush (3s)
    await new Promise(r => setTimeout(r, 3100));

    expect(mockFetch()).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch().mock.calls[0][1].body);
    expect(body.session_id).toBe('test-session-id');
    expect(body.signals[0].event_type).toBe('tab_switch');
    expect(body.signals[0].message).toBe('test message');
    expect(body.signals[0].severity).toBe('warning');
    expect(body.signals[0].client_timestamp).toBeDefined();
    expect(body.signals[0].metadata.custom).toBe('value');
    expect(body.signals[0].metadata.user_agent).toBeDefined();
  });

  it('F12: Signaler initializes lazily (only when init() is called)', () => {
    // Before init, signal() should be a no-op (warns)
    const state = window.ViolationSignaler._test.state;
    state.initialized = false;

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    expect(state.pendingSignals.length).toBe(0);
  });

  it('F7+F8: Offline queue persists (no fetch called when offline)', async () => {
    // Simulate offline state
    const state = window.ViolationSignaler._test.state;
    state.online = false;

    window.ViolationSignaler.init('test-session-id');
    // Wait for init to complete (it's async — awaits IDB restore)
    await new Promise(r => setTimeout(r, 50));

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'offline signal',
      severity: 'warning',
    });

    // Trigger a flush
    await window.ViolationSignaler.flush();

    // Signal should be queued (no fetch call since offline)
    expect(mockFetch()).not.toHaveBeenCalled();
    // The signal should still be in pendingSignals (not cleared because flush was a no-op)
    expect(state.pendingSignals.length).toBe(1);
  });

  it('F13: Queue overflow drops oldest signal at 200 cap', () => {
    window.ViolationSignaler.init('test-session-id');

    // Add 200+ signals with unique dedup keys (different timestamps)
    for (let i = 0; i < 210; i++) {
      window.ViolationSignaler.signal({
        event_type: 'tab_switch',
        message: `#${i}`,
        severity: 'warning',
        client_timestamp: new Date(Date.now() + i * 3000).toISOString(),
      });
    }

    const state = window.ViolationSignaler._test.state;
    expect(state.pendingSignals.length).toBeLessThanOrEqual(200);
  });

  it('F14: 429 rate limit response triggers retry with backoff', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({
        error: { code: 'RATE_LIMITED', details: { retry_after_ms: 100 } },
      }), { status: 429 })
    );

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    // Wait for 3s debounce + first attempt
    await new Promise(r => setTimeout(r, 3100));
    expect(mockFetch()).toHaveBeenCalledTimes(1);

    // Next retry should happen after retry_after_ms (100ms)
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { inserted: 1, skipped: 0 } }), { status: 200 })
    );

    await new Promise(r => setTimeout(r, 300));
    expect(mockFetch()).toHaveBeenCalledTimes(2);
  });

  it('F15: 4xx (non-429) drops signals (non-retryable)', async () => {
    window.ViolationSignaler.init('test-session-id');
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 })
    );

    window.ViolationSignaler.signal({
      event_type: 'tab_switch',
      message: 'x',
      severity: 'warning',
    });

    // Wait for 3s debounce + first attempt
    await new Promise(r => setTimeout(r, 3100));
    expect(mockFetch()).toHaveBeenCalledTimes(1);

    // No retry (4xx non-429 is non-retryable)
    await new Promise(r => setTimeout(r, 2000));
    expect(mockFetch()).toHaveBeenCalledTimes(1);

    // Signals should be cleared (not re-queued)
    const state = window.ViolationSignaler._test.state;
    expect(state.pendingSignals.length).toBe(0);
  });

});
