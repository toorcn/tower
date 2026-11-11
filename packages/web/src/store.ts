import { useSyncExternalStore } from 'react';
import { initialState, reduceState, StreamMessageSchema, type TowerEvent, type TowerState } from '@tower/shared';
import { derive, emptyPanel, type Panel } from './derive';
import type { GraphNode } from './scene/layout';

export interface Snapshot { tower: TowerState; panel: Panel; connected: boolean }
export interface SceneSink {
  reset(graph: { repoId: string; nodes: GraphNode[] }, now: number): void;
  ingest(event: TowerEvent, live: boolean, now: number): void;
}

/**
 * Owns the WebSocket. We always connect with `since=0`, so after a snapshot the server replays
 * the whole current run. Replayed events (seq up to the snapshot's lastSeq) rebuild the scene
 * silently; anything newer animates.
 */
export class TowerStore {
  private snap: Snapshot = { tower: initialState(), panel: emptyPanel(), connected: false };
  private listeners = new Set<() => void>();
  private scheduled = false;
  private appliedSeq = 0;
  private replayUntil = 0;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  sink?: SceneSink;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  get = () => this.snap;

  start() {
    this.stopped = false;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/v1/stream?since=0`);
      this.socket = socket;
      socket.onmessage = message => {
        try { this.handle(JSON.parse(message.data)); }
        catch (error) { console.warn('[tower] bad stream message', error); socket.close(); }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => { this.set({ connected: false }); if (!this.stopped) this.timer = setTimeout(connect, 1000); };
    };
    connect();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.close(); }

  private handle(raw: unknown) {
    const msg = StreamMessageSchema.parse(raw);
    const now = performance.now();
    if (msg.kind === 'snapshot') {
      this.appliedSeq = 0;
      this.replayUntil = msg.state.lastSeq;
      this.sink?.reset(msg.graph, now);
      this.snap = { tower: msg.state, panel: emptyPanel(), connected: true };
      this.notify();
      return;
    }
    const event = msg.event;
    if (event.seq <= this.appliedSeq) return;
    this.appliedSeq = event.seq;
    const live = event.seq > this.replayUntil;
    this.sink?.ingest(event, live, now);
    this.snap = {
      tower: live ? reduceState(this.snap.tower, event) : this.snap.tower,
      panel: derive(this.snap.panel, event),
      connected: true,
    };
    this.notify();
  }

  private set(part: Partial<Snapshot>) { this.snap = { ...this.snap, ...part }; this.notify(); }

  /** Panels re-render at most once per frame, so a replay burst stays cheap. */
  private notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; for (const fn of this.listeners) fn(); });
  }
}

export const store = new TowerStore();
export const useStore = () => useSyncExternalStore(store.subscribe, store.get);
