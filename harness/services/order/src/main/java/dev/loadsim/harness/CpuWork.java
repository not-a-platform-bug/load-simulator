package dev.loadsim.harness;

/**
 * Deterministic CPU burn per request. The harness uses it to give each API a known CPU cost,
 * so CPU contention in the real containers can be compared with the simulator's CPU model.
 */
public final class CpuWork {
    private static volatile long sink;

    private CpuWork() {}

    public static void burn(double millis) {
        if (millis <= 0) return;
        long end = System.nanoTime() + (long) (millis * 1_000_000);
        long x = 0;
        while (System.nanoTime() < end) {
            for (int i = 0; i < 1000; i++) x += i * 31L ^ (x >>> 3);
        }
        sink = x;
    }
}
