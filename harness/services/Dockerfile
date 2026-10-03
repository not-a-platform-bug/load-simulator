# One image per service: docker build --build-arg SERVICE=order .
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
ARG SERVICE
RUN ./gradlew --no-daemon :${SERVICE}:bootJar -x test

FROM eclipse-temurin:21-jre
ARG SERVICE
COPY --from=build /src/${SERVICE}/build/libs/${SERVICE}.jar /app.jar
ENTRYPOINT ["java", "-jar", "/app.jar"]
