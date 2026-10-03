# 검증 하네스

"부하 테스트를 대체한다"는 주장은 실측과 비교해야 성립합니다. 이 하네스는 **시뮬레이터가 쓰는 같은 시나리오 파일로**
실제 시스템에 부하를 걸고, 저부하 측정으로 보정한 모델이 고부하·장애 상황을 얼마나 맞히는지 오차표를 만듭니다.

## 구성

| 구성 | 내용 |
|---|---|
| `services/` | Spring Boot 4.1 서비스 3개 — order(Tomcat, Redis 캐시, Resilience4j 서킷브레이커, RabbitMQ/Kafka 발행), payment(결제 + 정산 리스너), stock |
| `docker-compose.yml` | MySQL, Redis, RabbitMQ, Kafka(`--profile kafka`), Toxiproxy, Prometheus. 컨테이너마다 CPU·메모리 limit 고정 |
| `infra/toxiproxy.json` | 장애를 넣을 경로: `mysql-orders`, `mysql-payments`, `payment`, `stock` |
| `scenarios/cascading.yaml` | 이 하네스를 그대로 옮긴 시뮬레이터 모델 |
| `run.mjs` | 측정 → 보정 → 외삽 검증 → 장애 검증 → 오차표 |

`order`의 API마다 일정한 CPU를 쓰도록 `app.cpu.*-ms`가 들어 있습니다. CPU 경합 모델을 실제 컨테이너와 비교하기 위해서입니다.

## 실행

필요한 것: Docker(또는 OrbStack), k6, Node.js 20+.

```bash
npm install && npm run build -w @load-simulator/cli
node harness/run.mjs --calibrate 60,90,120 --validate 200,300 --fault
```

1. 시나리오 설정을 `load-sim spring-env`로 Spring 환경 변수로 바꿔 `out/env/*.env`에 쓰고, `docker compose up`으로 띄웁니다.
   — **시뮬레이션과 실제 배포가 같은 설정으로 돈다**는 보장입니다.
2. 낮은 부하(`--calibrate`)에서 k6로 측정하고 `load-sim calibrate`로 DB 경합 곡선 등을 맞춥니다.
3. 보정에 쓰지 않은 높은 부하(`--validate`)를 시뮬레이터로 예측하고 실측과 비교합니다(외삽 = 부하 테스트 대체 능력).
4. `--fault`: 시나리오의 장애를 `load-sim toxiproxy`가 실시간으로 Toxiproxy에 적용하는 동안 k6를 돌리고,
   Prometheus에서 서킷브레이커 OPEN 시점을 읽어 비교합니다.
5. `harness/out/accuracy-<날짜>.md`에 오차표가 남습니다. 결과는 [docs/accuracy.md](../docs/accuracy.md)에 옮겨 공개합니다.

`--keep`을 주면 끝난 뒤 컨테이너를 남겨 둡니다(Prometheus: http://localhost:9090, RabbitMQ: `docker compose exec rabbitmq`).

## 안전장치

- k6 스크립트는 `BASE_URL`이 허용 목록(`localhost`, `127.0.0.1`, `staging`)에 없으면 시작하지 않고, `prod`처럼 보이는 호스트를 거부합니다.
- 최대 RPS 상한과 "에러율이 SLO를 넘으면 중단(`abortOnFail`)" 조건이 스크립트에 들어갑니다.
- 운영 환경에는 쓰지 마세요. 이 하네스는 로컬·전용 스테이징용입니다.
