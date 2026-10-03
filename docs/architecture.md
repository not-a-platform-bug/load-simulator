# 엔진 설계

이 문서는 `packages/engine`에 **실제로 구현된** 모델을 설명한다. 기획 의도는 [spec.md](spec.md), 입력 형식은 [model-reference.md](model-reference.md)를 본다.
모델이 단순화한 부분은 숨기지 않고 [단순화와 알려진 한계](#단순화와-알려진-한계)에 모아 둔다.

## 1. 구성

```
packages/
  engine/        순수 TypeScript. simulate(model, scenario, seed) → result, advise(), 가져오기·보정. 브라우저·Node 공용
  web/           React + React Flow(캔버스) + uPlot(타임라인). 엔진·진단은 Web Worker에서 실행
  cli/           load-sim run | check | capacity | k6 | import | calibrate | compare | spring-env | toxiproxy
harness/         검증 하네스: Spring Boot 서비스 + docker-compose + Toxiproxy + Prometheus + run.mjs
gradle-plugin/   loadSimCheck · loadSimCapacity를 gradle check에 연결
action.yml       PR마다 정적 검사·용량 회귀 검사를 도는 GitHub Action
examples/        예제 시나리오 YAML (웹이 자동으로 읽는다 — 파일을 넣으면 예제가 늘어난다)
```

| 파일 | 역할 |
|---|---|
| `parse.ts` | YAML → 정규화된 `Model`. 단위 해석, 기본값, 참조 검증, 암묵적 연결선 생성 |
| `simulate.ts` | 이산 사건 시뮬레이션 본체 |
| `heap.ts` | 시간순 이진 힙 사건 큐 (동시각은 삽입 순서로 정렬 → 결정적) |
| `rng.ts` | xoshiro128** 시드 난수. 네트워크·서비스·트래픽 스트림을 분리 |
| `dist.ts` | 고정·지수·균등·로그정규(p50/p99 두 점으로 적합) 분포 |
| `metrics.ts` | 고정 메모리 지연 히스토그램(로그 구간, 상대 오차 ~1.5%), 시간 가중 게이지 |
| `check.ts` | 정적 검사 (timeout 역전, 재시도 증폭, …) |
| `capacity.ts` | SLO 기준 용량 이분 탐색과 병목 판정 |
| `k6.ts` | 같은 시나리오 → k6 스크립트, 장애 → Toxiproxy/tc 계획 |
| `report.ts` | 부하 테스트 리포트 형식 Markdown |
| `advisor.ts` | 진단(어디서 시작돼 어떻게 번졌나) → 해결책 후보 → 후보별 시뮬레이션 → 순위·단계별 계획 |
| `importers/` | application.yml, Spring 소스, OpenAPI, OpenTelemetry, Prometheus, k6 → 시나리오. `merge.ts`가 출처 우선순위로 합침 |
| `calibrate.ts`, `compare.ts` | 실측 지점에 맞춰 파라미터 보정, 실측 대비 오차표 |
| `springEnv.ts` | 시나리오 설정 → Spring 환경 변수 (실제 배포를 같은 설정으로) |

## 2. 사건 처리

- 사건은 `(시각, 순번, 동작)`이고, 동작은 클로저다. 매 프레임 전체를 계산하지 않고 사건이 있는 시각만 처리한다.
- **GC 정지는 사건 큐 수준에서 처리한다.** 인스턴스에 묶인 사건은 그 인스턴스를 `gate`로 달고 들어가고,
  꺼낼 때 인스턴스가 정지 중이면 정지가 끝나는 시각으로 다시 넣는다. 그래서 CPU 처리, 대기 시간, 호출자의 timeout 타이머까지
  정지 동안 모두 멈췄다가 한꺼번에 풀린다(실제 STW와 같다).
- 결정성: 모든 무작위성은 시드에서 파생된 스트림을 거친다. 같은 `(model, scenario, seed)`면 결과가 비트 단위로 같고
  (`summary.wallMs` 제외), 테스트가 이를 확인한다.

## 3. 요청 하나의 경로

A가 B를 호출할 때(연결선 `A->B`) Resilience4j의 기본 데코레이터 순서를 따른다.

```
Fallback( Retry( CircuitBreaker( RateLimiter( TimeLimiter( Bulkhead(
    커넥션풀 획득 → 네트워크(요청) → B 처리 → 네트워크(응답)
))))))
```

1. **Circuit Breaker** (호출자 인스턴스마다 하나): 횟수 기반 슬라이딩 윈도우. `minCalls` 이상 쌓이면 실패율·느린 호출 비율을 평가해 OPEN.
   `openFor`가 지나면 HALF_OPEN, `halfOpenCalls`개 시험 호출 결과로 CLOSED 또는 다시 OPEN. OPEN 중 거부(`cb_open`)는 기록하지 않는다.
2. **Rate Limiter** (호출자 인스턴스마다): 고정 주기 허용 수. 허용이 다음 주기에 생기면 `timeout` 안에서 기다린다.
3. **Bulkhead**: 세마포어 + `maxWait`.
4. **TimeLimiter(timeout)**: 시도마다 타이머. 만료되면 호출자는 포기하지만 **B는 아무것도 모른 채 계속 일한다(좀비 작업).**
5. **커넥션풀**: DB 대상이면 HikariCP, 그 외에는 HTTP 클라이언트 풀. 호출자 인스턴스마다 하나.
   - HTTP: timeout이 나면 연결을 닫고 즉시 풀에 반납한다.
   - JDBC: timeout이 나도 **DB가 문장을 끝낼 때까지 연결이 반납되지 않는다.** 그래서 DB 동시성은 풀 합계를 넘지 않는다.
6. **네트워크**: 편도 시간 = `RTT/2 × 지연배수 + 지터(지수분포) + 크기/대역폭` + 손실 시 재전송(최소 RTO부터 2배씩).
   keep-alive가 꺼져 있으면 핸드셰이크 RTT를 더하고, 첫 SYN이 손실되면 초기 RTO 1초를 기다린다. 단절(`down`) 연결선은 응답이 오지 않아
   connect timeout(없으면 무한 대기)으로 끝난다.
7. **Retry**: 실패 종류가 `on`에 있으면 백오프(고정·지수, 상한, jitter) 후 1부터 다시. 각 시도는 서킷브레이커를 다시 거친다.
8. **Fallback**: 최종 실패 시 대체 응답 시간 후 성공(`degraded`)으로 반환한다.

### 3.1 서비스(B) 내부

```
커널 소켓 큐 ─▶ Tomcat 연결 ─▶ 워커 스레드 ─▶ CPU 슬롯 ─▶ CPU 밖 시간 ─▶ 하위 호출(순차)
```

- **커널 소켓 큐**: 처리 중 연결이 `maxConnections` 미만이면 수락. 넘으면 listen backlog(`min(acceptCount, somaxconn)`)에서 대기.
  backlog도 차면 **SYN 드롭** → 클라이언트가 1s, 2s, 4s … 후 재전송(최대 6회, connect timeout까지).
- **워커 스레드**: `threads`개 슬롯, FIFO 대기열. 스레드는 응답을 보낼 때까지(하위 호출 대기 포함) 붙잡힌다.
- **CPU**: 인스턴스마다 `round(vcpu)`개 슬롯. 요청의 CPU 시간(`cpu` 또는 `cpuRatio × 자체 처리 시간`) 동안 슬롯을 잡는다.
  슬롯이 모자라면 FIFO로 기다리므로 사용률 70%를 넘으면 대기 시간이 급격히 는다(M/M/c와 같은 꺾임).
- **메모리·GC**: 요청마다 `alloc`만큼 young 영역이 찬다. young(힙의 30%)이 차면 young GC 정지(GC 종류별 로그정규 분포, 힙 크기의 제곱근에 비례).
  young GC마다 3%가 old로 승격되고, old가 힙의 65%에 닿으면 old/mixed GC 정지를 더한 뒤 live set(25%)으로 돌아간다.
- **하위 호출**: 엔드포인트의 `calls`를 순서대로 실행한다. 확률(`@30%`)과 반복(`x 3`, `x 1..5`, `x items`)을 지원하고,
  `optional` 호출의 실패는 무시, `async` 호출은 `@Async` 풀에서 실행되어 스레드를 붙잡지 않는다.
  캐시 호출의 `onMiss`는 미스일 때 호출자가 이어서 실행한다(cache-aside).
- 하위 호출이 실패하면 엔드포인트는 HTTP 500(`error`)으로 실패하고, 실패의 기원(`cause`, 예: `payment->payment-db pool_timeout`)을 보존한다.

### 3.2 다른 컴포넌트

| 컴포넌트 | 슬롯 | 대기열 | 지연 |
|---|---|---|---|
| DB 서버 | `maxConnections` | FIFO | 쿼리 분포 × 경합 배수(시작 시점 동시성 c 기준) × 장애 배수 |
| 캐시 | `threads` (Redis는 1) | FIFO | 명령 분포. 적중률로 hit/miss 결정 |
| 외부 API | `concurrency` | FIFO | 응답 분포. `failureRate`로 5xx, 1초 고정 창 `rateLimit` 초과 시 즉시 429 |

**경합 곡선**: `c ≤ saturation`이면 `1 + (latencyX − 1)·((c−1)/(saturation−1))^shape`, 넘으면 `latencyX · c / saturation`.
포화점을 넘으면 지연이 동시성에 비례해 늘고 처리량은 평평해진다(서버가 바쁜 것이지 무너지는 것이 아니다).
포화 후 처리량이 오히려 떨어지는 retrograde 구간은 아직 모델링하지 않는다.

### 3.3 트래픽

- 진입 요청은 `client` 노드에서 출발해 `client->서비스` 연결선을 탄다(기본 RTT 2ms, timeout = `clientTimeout`).
- 도착은 비균질 포아송(또는 균등). 스파이크 경계에서는 재표본해 계단을 놓치지 않는다.
- API 믹스는 가중치로 진입 엔드포인트를 고른다.
- `schedules`(@Scheduled 배치)는 인스턴스 0에서 Tomcat이 아닌 별도 스레드로 실행되지만 CPU·힙·커넥션풀은 공유한다.

## 4. 측정

- 시간 구간(기본 1초)마다: 도착·성공·실패·fallback 수, 실패 종류별 수, p50·p95·p99, 모든 자원의 **시간 가중 평균** 사용률과 대기 수,
  연결선별 시도·재시도·실패, 서킷 OPEN/HALF_OPEN 비율, 서비스별 CPU·GC 정지·backlog·SYN 드롭.
- 요약 지표는 측정 구간(`warmup` 이후)만 쓴다. 진입 API는 **클라이언트가 본 지연**, 내부 API는 서버 측 지연이다.
- 끝날 때 아직 처리 중인 진입 요청은 그때까지의 나이를 지연으로 넣는다(중도 절단 관측). 막힌 시스템이 빨라 보이지 않게 하기 위해서다.
- 입자: 진입 요청 N개 중 1개의 경로(`[시각, 노드]` 열)를 기록한다. 화면은 각 홉에 고정된 이동 시간을 더해 그리므로 짧은 요청도 보이고,
  오래 기다린 요청은 실제 시간만큼 블록 안에 머문다 — **입자가 쌓이는 곳이 곧 병목이다.**

## 5. 정적 검사 (`checkModel`)

| 코드 | 내용 |
|---|---|
| `timeout-inversion` | `A->B` timeout ≤ `B->C` timeout, 또는 `B->C`의 최악 소요(시도 × timeout + 백오프) ≥ `A->B` timeout |
| `pool-timeout-inversion` | B의 DB 풀 대기 timeout ≥ `A->B` timeout |
| `retry-amplification` | 진입 API에서 내려가는 경로마다 (시도 수 × 반복 수)의 곱. 8배 이상이면 경고 |
| `retry-no-jitter` | jitter 없는 재시도 (동기화된 재시도) |
| `no-timeout` | 서비스·외부 API 호출에 timeout이 없음 |
| `cb-no-fallback`, `cb-short-open`, `cb-slowcall-unreachable` | 서킷브레이커 설정 함정 |
| `retry-non-idempotent` | POST/PATCH 재시도 |
| `pool-exceeds-db` | 풀 합계 > DB `max_connections` |
| `cycle` | 호출 순환 |

## 6. 용량 산출 (`findCapacity`)

1. 시나리오의 API 믹스를 유지한 채 상수 트래픽으로 바꾸고 장애는 뺀다(옵션으로 유지 가능).
2. 100 RPS부터 두 배씩 올려 처음 SLO를 깨는 지점을 찾고, 통과·실패 사이를 이분 탐색한다(기본 정밀도 3%).
3. **어떤 API가 먼저 깨졌는가**: 실패한 가장 낮은 RPS에서 SLO 대비 가장 나쁜 진입 API.
4. **첫 병목**: 그 실행에서 측정 구간 평균 사용률 + 대기 여부로 자원을 정렬한다. 점수가 비슷하면
   CPU → DB → 커넥션풀 → 캐시 → 외부 API → Bulkhead → @Async → 워커 스레드 → backlog 순으로 원인 쪽을 고른다
   (스레드 고갈은 대개 다른 자원을 기다린 결과이기 때문이다).

## 7. 성능

- 데모 1~3: 진입 요청 4.5만~8만 건, 사건 50만~130만 개. 프로덕션 빌드 브라우저에서 약 0.2~0.4초, Node 번들에서 0.3~0.6초.
- 웹에서는 디바운스(120ms) 후 Worker에서 실행하고, 새 요청이 오면 실행 중인 Worker를 종료하고 새로 띄운다.
- 병목은 사건당 클로저 할당(GC)과 대부분 쓰이지 않는 timeout 타이머 사건이다. 개선 후보: 타이머 휠, 사건 객체 풀링, WASM.

## 8. 런타임 모델

| model | 요청이 붙잡는 것 | 블로킹 호출 |
|---|---|---|
| `tomcat` | 워커 스레드 1개 (응답할 때까지) | 스레드가 기다림 |
| `webflux` | 없음. CPU 작업은 이벤트 루프(기본 vCPU개)에서 실행 | 호출 동안 **이벤트 루프 하나가 멈춤** (`edges.*.blocking`, DB는 기본 true) |
| `virtual` | 가상 스레드(제한 없음), CPU 작업은 캐리어 스레드(vCPU개)에서 | `pinning` 확률만큼 캐리어를 붙잡음 |

## 9. OS 계층 (추가분)

- **컨텍스트 스위칭**: 실행 대기 스레드가 코어보다 많으면 CPU 시간 × (1 + `contextSwitch`·ln(대기/코어)). 스레드를 늘릴수록 처리량이 떨어지는 지점이 생긴다.
- **cgroup CPU limit**: CFS 주기(`cfsPeriod`)마다 `cpuLimit × 주기`만큼 CPU를 쓰면 다음 주기까지 인스턴스 전체가 멈춘다(GC 정지와 같은 게이트로 처리).
- **파일 디스크립터**: 받은 연결 + 진행 중 호출 수가 `ulimit`을 넘으면 새 연결 수락이 EMFILE로 실패한다.
- **임시 포트**: keep-alive가 꺼진 연결선은 호출마다 포트를 쓰고, 닫힌 포트는 `timeWait` 동안 묶인다. 고갈되면 EADDRNOTAVAIL.
- **패킷 손실**: 스트림 중간 세그먼트 손실은 빠른 재전송(+1 RTT), 마지막 3개 세그먼트(꼬리)와 SYN 손실만 RTO를 기다린다.

## 10. 클러스터

| 노드 | 멤버 (`faults[].instance`) | 동작 |
|---|---|---|
| 서비스 | 인스턴스 | 로드밸런서(라운드로빈·최소 연결). `healthCheck`가 있으면 연속 실패 시 제외, 없으면 죽은 인스턴스로 계속 보냄. `hang`이면 연결은 받고 응답하지 않음 |
| DB | 0 = primary, 1.. = replica | 쓰기는 primary, `readSplit`이면 읽기 쿼리는 살아 있는 레플리카로. primary 장애 → `failoverTime` 뒤 레플리카 승격, 그동안 쓰기 실패 |
| Redis Cluster | shard i | 키 → 해시 슬롯 → 샤드. 샤드마다 독립된 명령 스레드(핫 키 → 핫 샤드). 장애 샤드는 레플리카가 있으면 `failoverTime` 뒤 복구 |
| Kafka | broker i | 파티션 p의 레플리카 = 브로커 (p+j) mod B. 리더 장애 → `electionTime` 동안 그 파티션 발행·소비 정지(프로듀서는 기다림), acks=all에서 살아 있는 레플리카 < `minInsyncReplicas`면 쓰기 거부 |
| RabbitMQ | node i | 큐는 node 0에. classic: 그 노드가 죽으면 큐도 사라짐. quorum: 과반이 살면 `electionTime` 뒤 재선출, 발행 지연 2배 |
| NoSQL·검색·오브젝트 스토리지 | node i | 키 → 파티션(쏠림 `keySkew`) → 복제본. ring 배치(Cassandra·ES: 파티션 p는 노드 p, p+1, …) 또는 group 배치(Mongo: 샤드마다 복제 세트). 아래 14절 |

## 11. 메시지 큐

- **RabbitMQ**: 하나의 FIFO. 컨슈머 인스턴스마다 `concurrency`개 리스너 스레드가 다음 메시지를 가져간다. 메시지마다 브로커 왕복(`deliveryRtt`)을 `prefetch`로 나눠 낸다.
  manual ack 실패는 재전달(무한 재전달 = 독 메시지), `maxRetries`를 넘으면 DLQ.
- **Kafka**: 파티션별 로그. 파티션은 살아 있는 컨슈머 스레드에 라운드로빈으로 배정되고, 남는 스레드는 논다(병렬도 상한 = 파티션 수).
  파티션 안에서는 순서대로 하나씩 처리한다. `onError: retry`면 실패한 레코드를 제자리에서 재시도하는 동안 **그 파티션 전체가 멈춘다**(Spring Kafka DefaultErrorHandler).
  컨슈머 인스턴스가 빠지거나 돌아오면 `rebalanceTime` 동안 그룹 전체가 멈춘 뒤 다시 배정한다.
- 리스너는 그 서비스의 CPU·힙·커넥션풀을 Tomcat 요청과 함께 쓴다.

## 12. 진단과 권장 (`advise`)

1. **나쁨 점수**: 진입 API마다 `max(0, ln(p99/SLO))` + 30 × (에러율 + 0.1 × fallback 비율 − SLO 에러율)을 트래픽 비중으로 더하고, 큐 적체(발행 몇 초 분량인지)를 더한다. 0이면 SLO를 지킨다.
2. **진단**: 측정 구간에서 대기열이 생기며 포화된 자원을 시간순으로 정렬해 **처음 포화된 자원**과 전파 경로를 찾고, 그 직전 장애와 잇는다.
   그 밖의 서명: 동기 호출 연쇄, 재시도 폭증, 캐시 스탬피드, GC 정지, SYN 드롭, CPU 쓰로틀링, 큐 적체·핫 파티션·블로킹 재시도·리밸런스, 죽은 인스턴스 유입, 패킷 손실, EMFILE·임시 포트·429, 정적 검사 경고.
3. **후보**: 진단마다 해결책을 만든다(예: 연쇄 → 서킷브레이커 + fallback + 짧은 timeout, Bulkhead / CPU 포화 → 사용률 60% 목표 인스턴스 수 /
   DB 포화 → 읽기 레플리카, 사양 상향 / 스탬피드 → TTL jitter + lock / 핫 파티션 → 키 재설계 …). DB 호출에는 fallback을 제안하지 않는다(가짜 성공).
4. **평가**: 후보마다 같은 시나리오·시드로 시뮬레이션해 (점수 감소 − 비용)으로 순위를 매긴다. 비용은 인스턴스·레플리카 추가, 기능 저하, 코드 변경의 대가다.
5. **계획**: 가장 좋은 후보를 적용하고 다시 진단해 다음 후보를 고른다(최대 3단계).

예제 15개 모두 시나리오에 정답을 적지 않았고, 테스트(`advisor.test.ts`)가 권장 엔진이 스스로 해결책을 찾는지 확인한다.

## 13. 가져오기·보정·검증

- 가져오기는 [model-reference.md](model-reference.md#가져오기). 출처 우선순위 트레이스 > Prometheus > 설정 > 소스·OpenAPI, 미관측 API는 "추정".
- `calibrate`: 여러 부하 수준의 실측(p50·p99·처리량·에러율)과 시뮬레이션의 로그 오차 제곱합을 좌표 탐색으로 줄인다(기본: DB 경합 곡선).
- `compare`: [accuracy.md](accuracy.md)의 목표(처리량·SLO 한계 RPS ±10%, p99 ±15%, 첫 병목 일치, 서킷 OPEN ±2초)로 판정한다.
- 하네스는 [harness/README.md](../harness/README.md).

## 14. 분산 저장소 (`kind: nosql`, `objectstore`)

요청 하나는 파티션 하나(스캔·검색은 모든 파티션)로 가고, 파티션의 복제본 중 몇 개에 보낼지는 엔진과 일관성 수준이 정한다.

1. **파티션 처리량 한도**: 1초 창마다 파티션별 읽기·쓰기 수를 센다. 한도(`partitionRate`)를 넘으면 즉시 429 —
   DynamoDB의 ProvisionedThroughputExceeded, S3의 503 SlowDown. 테이블 전체 용량이 남아도 키가 쏠리면 한 파티션만 넘는다.
2. **리더 기반 쓰기**(Mongo·ES·DynamoDB): primary가 처리한 뒤 나머지 복제본에 보내고 `acks`(write concern)개가 확인하면 응답한다.
   primary가 죽으면 `failoverTime` 동안 그 파티션의 쓰기(와 primary 읽기)는 실패하고, 그 뒤 살아 있는 복제본이 선출된다.
3. **리더 없는 요청**(Cassandra): 쓰기는 살아 있는 복제본 모두에 보내고 `acks`개 확인을 기다린다. 읽기는 `acks`개 복제본에 보내 모두 기다린다.
   살아 있는 복제본이 `acks`보다 적으면 즉시 실패(Unavailable). 일관성 수준이 높을수록 k번째로 빠른 응답을 기다리므로 꼬리 지연이 길다.
4. **노드 슬롯과 대기열**: 노드마다 `concurrency`개 요청을 동시에 처리하고, 대기열이 `queue`를 넘으면 거절한다(ES는 429 es_rejected_execution).
   ES 검색은 샤드 수만큼 작업을 만들기 때문에 같은 노드 수에서 샤드가 많을수록 스레드풀이 빨리 찬다.
5. 지연 = 복제본 처리 시간 × 장애 배수 + 크기 / `bandwidth`(오브젝트 스토리지).

## 15. 진입·플랫폼 구성 요소

- **API 게이트웨이**: 라우트마다 엔드포인트를 만들어 백엔드 API를 호출한다. 라우트 정책(timeout·재시도·서킷브레이커)은 게이트웨이→백엔드 연결선이 되고, 라우트 rate limit은 429.
- **로드밸런서**: 대상의 엔드포인트를 그대로 비춘다. 분산 알고리즘과 헬스체크는 대상 서비스의 인스턴스 선택에 적용된다.
- **CDN**: 엔드포인트마다 `1 − 적중률` 확률로만 오리진을 호출한다. GET·HEAD가 아니면 항상 오리진. 엣지 자체는 용량이 사실상 무한하다.
- **커넥션 풀러**: DB 쿼리마다 엔드포인트를 만들고, 풀러→DB 연결선의 커넥션풀이 `poolSize`다. 앱 쪽 연결(`maxClientConn`까지)은 그 풀을 나눠 쓴다.
  풀러는 이벤트 루프이므로 DB를 기다리는 동안 루프를 막지 않는다.
- **서비스 메시**: 메시 안 서비스 사이 호출마다 사이드카를 두 번 지나며(지연 + 같은 파드 CPU), 메시 재시도는 이전에 시도한 호스트를 피한다. outlier detection은 연속 5xx 인스턴스를 일정 시간 제외한다.
- **가용 영역**: 노드의 인스턴스·멤버를 존에 번갈아 배치한다. 존을 넘는 호출은 `crossZoneRtt`가 더해지고, `zoneAware`면 같은 존의 정상 인스턴스를 우선한다. 존 장애는 그 존의 멤버를 모두 멈춘다.
- **WebSocket**: 연결은 핸드셰이크를 처리한 인스턴스에 고정된다. 메시지는 그 인스턴스로 가고, 브로드캐스트는 연결을 가진 모든 인스턴스에 CPU를 쓴다.
  인스턴스가 죽으면 그 연결은 heartbeat timeout 뒤 끊긴 것으로 판정되고, 재연결 정책(지연·배수·jitter)대로 다시 붙는다.

## 단순화와 알려진 한계

정확도 검증([accuracy.md](accuracy.md)) 전까지 아래 항목은 모두 "가설"이다.

- 엔드포인트의 `selfTime`은 첫 단계 앞에 한 번 쓴다. 호출 사이 처리는 `work` 단계로 명시해야 한다(트레이스 가져오기는 아직 이를 나누지 않는다).
- CPU는 FIFO 코어 슬롯이다. 컨텍스트 스위칭은 실행 대기 스레드 수에 따른 로그 비용으로, 프로세서 공유(타임 슬라이스)는 근사하지 않는다.
- GC 상수(young 30%, 승격 3%, old 임계 65%, live set 25%)는 G1 기본값을 단순화한 고정값이다.
- DB 경합 배수는 쿼리 **시작 시점**의 동시성으로 정한다. 실행 중 동시성 변화는 반영하지 않는다.
- 대역폭은 전송 시간만 더하고 링크 공유(대기)는 없다.
- 메시지 하나의 처리는 리스너 스레드 하나가 순서대로 한다. Kafka 배치 처리, 비블로킹 재시도 토픽(@RetryableTopic), 트랜잭션은 아직 없다.
- 장애 인스턴스에서 이미 처리 중이던 메시지·요청은 끝까지 처리된다(at-least-once 재처리는 모델링하지 않는다).
- DB 레플리카의 복제 지연(오래된 읽기)은 결과에 반영하지 않는다. failover는 레플리카 하나를 승격할 뿐 재구성 부하는 없다.
- 분산 저장소의 핫 키는 연속 분포(`keySkew`)로 근사한다. 키 하나에 몰리는 극단(단일 키 한도)은 파티션을 늘려도 남는 실제와 달리 완화될 수 있다.
  Cassandra 코디네이터 홉, 읽기 복구, 힌트 핸드오프, Mongo 청크 이동, ES 리프레시·병합은 모델링하지 않는다.
- CDN의 적중률은 입력값이다. TTL 만료·요청 병합(collapsing)·오리진 실드는 없다.
- 권장 엔진의 후보는 규칙 기반이다. 규칙에 없는 해결책(예: 쿼리 인덱스 추가, 코드 최적화)은 제안하지 못한다.
- Tomcat 대기열의 요청은 클라이언트가 떠나도 처리된다(실제와 같다). 연결 끊김 감지로 일찍 버리는 서버는 모델링하지 않는다.
