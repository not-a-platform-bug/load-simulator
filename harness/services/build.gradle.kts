plugins {
    id("org.springframework.boot") version "4.1.1" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

subprojects {
    apply(plugin = "java")
    apply(plugin = "org.springframework.boot")
    apply(plugin = "io.spring.dependency-management")

    repositories { mavenCentral() }

    tasks.withType<JavaCompile> {
        options.release.set(21)
        options.compilerArgs.add("-parameters")
    }

    dependencies {
        "implementation"("org.springframework.boot:spring-boot-starter-webmvc")
        "implementation"("org.springframework.boot:spring-boot-starter-actuator")
        "implementation"("org.springframework.boot:spring-boot-starter-jdbc")
        "implementation"("io.micrometer:micrometer-registry-prometheus")
        "runtimeOnly"("com.mysql:mysql-connector-j")
    }
}

project(":order") {
    dependencies {
        "implementation"("org.springframework.boot:spring-boot-starter-data-redis")
        "implementation"("org.springframework.boot:spring-boot-starter-amqp")
        "implementation"("org.springframework.boot:spring-boot-starter-kafka")
        "implementation"("org.springframework.boot:spring-boot-starter-aspectj")
        "implementation"("io.github.resilience4j:resilience4j-spring-boot4:2.4.0")
    }
}

project(":payment") {
    dependencies {
        "implementation"("org.springframework.boot:spring-boot-starter-amqp")
        "implementation"("org.springframework.boot:spring-boot-starter-kafka")
    }
}

subprojects {
    tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
        archiveFileName.set("${project.name}.jar")
    }
}
