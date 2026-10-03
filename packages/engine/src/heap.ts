// Time-ordered event queue. Ties are broken by insertion order so the simulation is deterministic.

export type Action = () => void;

/** Something that can freeze time locally (a JVM in a stop-the-world GC pause). */
export interface Gate {
  pausedUntil: number;
}

export class EventQueue {
  private times: number[] = [];
  private seqs: number[] = [];
  private actions: Action[] = [];
  private gates: (Gate | null)[] = [];
  private seq = 0;
  /** gate of the most recently popped event */
  gate: Gate | null = null;

  get size(): number {
    return this.times.length;
  }

  push(t: number, action: Action, gate: Gate | null = null): void {
    const times = this.times;
    const seqs = this.seqs;
    const actions = this.actions;
    const gates = this.gates;
    let i = times.length;
    const s = this.seq++;
    times.push(t);
    seqs.push(s);
    actions.push(action);
    gates.push(gate);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (times[p] < t || (times[p] === t && seqs[p] < s)) break;
      times[i] = times[p];
      seqs[i] = seqs[p];
      actions[i] = actions[p];
      gates[i] = gates[p];
      i = p;
    }
    times[i] = t;
    seqs[i] = s;
    actions[i] = action;
    gates[i] = gate;
  }

  peekTime(): number {
    return this.times.length ? this.times[0] : Infinity;
  }

  /** Removes the earliest event and returns its action (its gate is left in `this.gate`). Caller reads the time via peekTime() first. */
  pop(): Action {
    const times = this.times;
    const seqs = this.seqs;
    const actions = this.actions;
    const gates = this.gates;
    const top = actions[0];
    this.gate = gates[0];
    const lastT = times.pop()!;
    const lastS = seqs.pop()!;
    const lastA = actions.pop()!;
    const lastG = gates.pop()!;
    const n = times.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let m = l;
        if (r < n && (times[r] < times[l] || (times[r] === times[l] && seqs[r] < seqs[l]))) m = r;
        if (lastT < times[m] || (lastT === times[m] && lastS < seqs[m])) break;
        times[i] = times[m];
        seqs[i] = seqs[m];
        actions[i] = actions[m];
        gates[i] = gates[m];
        i = m;
      }
      times[i] = lastT;
      seqs[i] = lastS;
      actions[i] = lastA;
      gates[i] = lastG;
    }
    return top;
  }
}
