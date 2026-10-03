plugins {
    `java-gradle-plugin`
    `maven-publish`
}

group = "dev.loadsim"
version = "0.1.0"

repositories { mavenCentral() }

java { toolchain { languageVersion.set(JavaLanguageVersion.of(System.getProperty("java.specification.version").substringBefore('.').toInt())) } }

tasks.withType<JavaCompile> { options.release.set(17) }

gradlePlugin {
    plugins {
        create("loadSim") {
            id = "dev.loadsim"
            implementationClass = "dev.loadsim.gradle.LoadSimPlugin"
            displayName = "load-simulator"
            description = "Static checks and SLO capacity regression for service configuration, run as part of `gradle check`."
        }
    }
}
