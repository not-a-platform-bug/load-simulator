package dev.loadsim.gradle;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.tasks.Exec;
import org.gradle.api.tasks.TaskProvider;

/** Adds loadSimCheck and loadSimCapacity, both wired into `check`. Runs the same engine as the web app and CI action. */
public class LoadSimPlugin implements Plugin<Project> {
    @Override
    public void apply(Project project) {
        LoadSimExtension ext = project.getExtensions().create("loadSim", LoadSimExtension.class);
        ext.getCli().convention("npx --yes load-sim");
        ext.getFailOnWarnings().convention(false);
        ext.getScenario().convention(project.getLayout().getProjectDirectory().file("load-sim.yaml"));

        TaskProvider<Exec> check = project.getTasks().register("loadSimCheck", Exec.class, t -> {
            t.setGroup("verification");
            t.setDescription("Static checks of the service configuration (timeouts, retries, breakers, pools)");
            t.doFirst(x -> t.setCommandLine(command(ext, "check", List.of())));
            t.setIgnoreExitValue(false);
        });

        TaskProvider<Exec> capacity = project.getTasks().register("loadSimCapacity", Exec.class, t -> {
            t.setGroup("verification");
            t.setDescription("Simulated SLO capacity; fails when it drops below loadSim.minRps");
            t.doFirst(x -> {
                List<String> extra = new ArrayList<>();
                if (ext.getMinRps().isPresent()) extra.addAll(List.of("--min-rps", String.valueOf(ext.getMinRps().get())));
                if (ext.getP99().isPresent()) extra.addAll(List.of("--p99", ext.getP99().get()));
                if (ext.getErrorRate().isPresent()) extra.addAll(List.of("--error-rate", ext.getErrorRate().get()));
                extra.addAll(List.of("--report", project.getLayout().getBuildDirectory().file("reports/load-sim/capacity.md").get().getAsFile().getAbsolutePath()));
                project.getLayout().getBuildDirectory().dir("reports/load-sim").get().getAsFile().mkdirs();
                t.setCommandLine(command(ext, "capacity", extra));
            });
            t.mustRunAfter(check);
        });

        project.getPlugins().withId("base", p -> project.getTasks().named("check").configure(c -> c.dependsOn(check, capacity)));
        project.getPlugins().withId("java", p -> project.getTasks().named("check").configure(c -> c.dependsOn(check, capacity)));
    }

    private static List<String> command(LoadSimExtension ext, String sub, List<String> extra) {
        List<String> cmd = new ArrayList<>(Arrays.asList(ext.getCli().get().trim().split("\\s+")));
        cmd.add(sub);
        cmd.add(ext.getScenario().get().getAsFile().getAbsolutePath());
        cmd.addAll(extra);
        return cmd;
    }
}
