package dev.loadsim.gradle;

import org.gradle.api.file.RegularFileProperty;
import org.gradle.api.provider.Property;

/**
 * <pre>
 * loadSim {
 *     scenario = file("load/scenario.yaml")
 *     minRps = 1500          // fail `check` when the SLO capacity drops below this
 *     p99 = "300ms"          // optional SLO override
 *     cli = "npx load-sim"   // or "node /path/to/load-sim.cjs"
 * }
 * </pre>
 */
public abstract class LoadSimExtension {
    public abstract RegularFileProperty getScenario();

    public abstract Property<Integer> getMinRps();

    public abstract Property<String> getP99();

    public abstract Property<String> getErrorRate();

    /** command that runs the load-sim CLI */
    public abstract Property<String> getCli();

    /** fail on static-check warnings (timeout inversion, retry amplification, …) */
    public abstract Property<Boolean> getFailOnWarnings();
}
