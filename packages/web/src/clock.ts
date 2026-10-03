// Playback clock shared by the particle canvas and the timeline without re-rendering React every frame.
type Listener = (t: number) => void;

export class Clock {
  /** simulated time in ms */
  t = 0;
  playing = false;
  /** simulated seconds per real second */
  speed = 4;
  duration = 0;
  private listeners = new Set<Listener>();
  private raf = 0;
  private last = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  seek(t: number): void {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.emit();
  }

  play(): void {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(100, now - this.last);
      this.last = now;
      this.t += dt * this.speed;
      if (this.t >= this.duration) {
        this.t = this.duration;
        this.playing = false;
      }
      this.emit();
      if (this.playing) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.t);
  }
}

export const clock = new Clock();
