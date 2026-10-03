# 시나리오 YAML 레퍼런스

시뮬레이션 입력은 YAML 파일 하나다. 웹 캔버스·설정 패널과 양방향으로 동기화되고, 공유 URL에도 이 문서가 그대로 담긴다.
예제는 [`examples/`](../examples)를 본다.

직접 쓰기보다 **가져오기**로 만드는 것을 권장합니다(웹의 "내 환경 가져오기" 또는 `load-sim import`, [아래](#가져오기)).

```yaml
nodes:      # 서비스·DB·캐시·메시지 큐·외부 API
edges:      # "호출자->피호출자" 연결선: 네트워크와 회복성 정책
scenario:   # 트래픽, 장애, SLO
layout:     # (선택) 캔버스 위치 { 노드: [x, y] }
demo:       # (선택) 웹 데모 메타데이터. 엔진은 무시한다
```

## 단위

| 종류 | 쓰는 법 | 숫자만 쓰면 |
|---|---|---|
| 시간 | `500us`, `8ms`, `2s`, `1m` | ms |
| 처리율 | `500rps`, `30rpm` | 초당 |
| 비율 | `0.1%`, `0.001` | 1 이하는 비율, 1 초과는 % |
| 크기 | `512`, `4kb`, `1mb` | 바이트 |
| 메모리 | `512m`, `2g` | MB |
| 대역폭 | `100mbps`, `1gbps` | Mbps |

## 분포

처리 시간은 평균 하나가 아니라 분포로 받는다. p99를 예측하려면 꼬리가 필요하기 때문이다.

```yaml
selfTime: 8ms                                   # 고정
selfTime: { p50: 8ms, p99: 40ms }               # 로그정규 (두 분위수로 적합) — 권장
selfTime: { dist: lognormal, mean: 10ms, sigma: 0.5 }
selfTime: { dist: exp, mean: 5ms }
selfTime: { dist: uniform, min: 1ms, max: 3ms }
```

## nodes

### service (기본값)

```yaml
order:
  kind: service
  instances: 2                 # 기본 1
  lb: round-robin              # round-robin | least-conn | random | p2c (호출하는 쪽이 인스턴스를 고르는 방식)
  zones: [a, b]                # 인스턴스를 존에 번갈아 배치 (topology 참고)
  healthCheck: { interval: 5s, threshold: 3, riseThreshold: 2 }   # 로드밸런서 헬스체크 (없으면 죽은 인스턴스로도 계속 보냄)
  runtime:
    model: tomcat              # tomcat (요청당 스레드) | webflux (이벤트 루프) | virtual (가상 스레드)
    eventLoops: 4              # webflux: 이벤트 루프 수 (기본 vCPU)
    pinning: 20%               # virtual: 블로킹 호출이 캐리어 스레드를 붙잡는 비율 (synchronized 안의 I/O)
    threads: 200               # server.tomcat.threads.max
    maxConnections: 8192       # server.tomcat.max-connections
    acceptCount: 100           # server.tomcat.accept-count (listen backlog)
    asyncThreads: 8            # @Async 풀
  os:
    vcpu: 2
    heap: 2g                   # 기본 1g
    gc: g1                     # g1 | parallel | serial | zgc
    somaxconn: 4096
    cpuLimit: 1.5              # 컨테이너 CPU limit (cgroup CFS 쿼터). 쿼터를 다 쓰면 다음 주기까지 정지
    cfsPeriod: 100ms
    contextSwitch: 0.05        # CPU 시간 × (1 + 0.05·ln(실행 대기 스레드 / 코어))
    ulimit: 65535              # ulimit -n: 열린 소켓 수 한도 (넘으면 EMFILE)
    ephemeralPorts: 28232      # keep-alive 없는 호출용 임시 포트 수
    timeWait: 60s              # 닫힌 포트의 TIME_WAIT 유지
    gcPause: { young: { p50: 8ms, p99: 30ms }, old: { p50: 60ms, p99: 250ms } }   # 선택: GC 정지 분포 직접 지정
  endpoints:
    POST /orders:
      selfTime: { p50: 8ms, p99: 40ms }   # 하위 호출을 뺀 자체 처리 시간
      cpu: 4ms                 # 요청당 CPU 시간 (미지정 시 cpuRatio × selfTime)
      cpuRatio: 0.3            # 기본 0.3
      alloc: 1mb               # 요청당 힙 할당 (기본 256kb)
      requestSize: 512         # 기본 512 바이트
      responseSize: 2kb        # 기본 2kb
      observed: true           # 트레이스에서 측정된 프로파일인지 (가져오기가 채움; false면 결과에 "추정"으로 표시)
      rateLimit: 500rps        # 이 API의 초당 한도 (Bucket4j 등). 넘으면 429
      handshake: false         # WebSocket 업그레이드 API (scenario.websocket 참고)
      broadcast: { fanout: 30, cpu: 0.02ms }   # 메시지 처리 뒤 구독자 fanout명에게 전달 (WebSocket)
      calls:
        - "order-db:insertOrder"                       # 노드:오퍼레이션
        - "payment:POST /payments/approve"
        - "stock:GET /stocks/{id} x items"             # 반복: 숫자, a..b, scenario.vars 이름
        - "notify:POST /send @30%"                     # 확률
        - { call: "redis:GET product", onMiss: [ "order-db:selectProduct" ] }   # cache-aside
        - { call: "audit:POST /log", async: true }     # @Async: 스레드를 붙잡지 않음
        - { call: "reco:GET /reco", optional: true }   # 실패해도 엔드포인트는 성공
        - { work: 5ms, cpu: 50% }                      # 호출 사이 자체 처리 (직렬화·계산·락 대기). cpu 기본 30%
        - parallel:                                    # 동시에 보내고 모두 끝날 때까지 대기 (CompletableFuture.allOf, Mono.zip)
            - "stock:GET /stocks/{id}"
            - { call: "redis:GET coupon", onMiss: [ "order-db:selectCoupon" ] }
          optional: false                              # true면 그룹 안 실패를 무시
        - "events:publish"                             # 큐 발행
```

`calls`는 **위에서부터 순서대로** 실행되는 단계 목록이다. `selfTime`은 첫 단계 전에 한 번 쓰이고, 호출 사이의 처리는 `work`
단계로 원하는 위치에 넣는다. 그래서 DB·캐시·큐·다른 서비스를 어떤 순서로든 섞을 수 있다(예: 캐시 조회 → 미스면 DB → 처리 → 큐 발행).
`parallel` 그룹은 가장 느린 가지만큼 걸리고, 필수 가지가 하나라도 실패하면 그룹이 실패한다. 각 단계에는 `prob`·`count`(반복)를 붙일 수 있다.
웹 UI에서는 서비스의 설정 패널 → API → **호출 흐름**에서 단계를 추가·정렬하고, 아래 입력란으로 새 API를 추가한다.

호출 대상이 서비스면 오퍼레이션은 그 서비스의 엔드포인트 이름이어야 한다. DB는 `queries`의 이름(없으면 기본 쿼리), 캐시·외부 API는 임의의 이름이다.

### db

```yaml
order-db:
  kind: db
  maxConnections: 151          # 동시 실행 슬롯 (MySQL max_connections)
  contention:                  # 경합 곡선: 동시성 1 → 1배, saturation → latencyX배, 그 뒤로는 동시성에 비례
    saturation: 32
    latencyX: 3
    shape: 1.5
    retrograde: 0              # 0보다 크면 포화 뒤 처리량이 오히려 떨어짐
  cluster:
    replicas: 2                # 읽기 레플리카 (멤버 0 = primary, 1.. = replica)
    readSplit: true            # select/find/get… 쿼리를 레플리카로 (read: true/false로 쿼리마다 지정 가능)
    failoverTime: 30s          # primary 장애 → 레플리카 승격까지. 그동안 쓰기는 실패
    shards: 4                  # 수평 샤딩: 샤드마다 primary + replicas (멤버 = 샤드 × (1+replicas))
    keySkew: 0.3               # 샤드 키 쏠림 (핫 샤드)
  latency: { p50: 2ms, p99: 10ms }          # 정의되지 않은 쿼리의 기본 지연
  queries:
    insertOrder: { latency: { p50: 4ms, p99: 20ms }, responseSize: 256 }
    selectProducts: { p50: 3ms, p99: 15ms } # latency 키 생략 가능
    findHot: { p50: 1ms, read: true }
    searchAll: { p50: 8ms, read: true, scatter: true }   # 모든 샤드를 조회하고 가장 느린 샤드를 기다림
```

### cache

```yaml
redis:
  kind: cache
  hitRate: 92%                 # 기본 90% (TTL 모델을 쓰지 않는 명령)
  threads: 1                   # Redis 명령 처리 스레드 (샤드마다)
  opTime: { p50: 0.15ms, p99: 0.6ms }
  cluster: { shards: 3, replicas: 1, failoverTime: 15s }   # Redis Cluster: 키 → 해시 슬롯 → 샤드 (멤버 i = shard i)
  ops:
    GET cart: { hitRate: 99% } # 오퍼레이션별 고정 적중률
    GET product:               # 키 공간 모델: 실제로 만료·재적재되는 항목
      ttl: 30s
      keys: 2000
      ttlJitter: 0%            # 0이면 함께 채워진 항목이 같은 순간 만료 (스탬피드)
      singleFlight: false      # true면 같은 키는 한 요청만 원본을 다시 읽고 나머지는 기다림 (lock)
      skew: 0.6                # 키 인기 쏠림 (핫 키 → 핫 샤드)
```

TTL이 있는 명령은 `onMiss` 경로가 끝나면 그 키를 다시 채웁니다(cache-aside).

### queue

```yaml
order-events:
  kind: queue
  broker: rabbitmq             # rabbitmq | kafka
  publishTime: { p50: 0.5ms, p99: 3ms }
  capacity: 0                  # 최대 메시지 (0 = 무제한). 넘으면 발행 실패
  cluster: { nodes: 3, queueType: quorum, electionTime: 5s }   # RabbitMQ: classic은 노드 장애 동안 사라지고, quorum은 과반이 살아 있으면 재선출
  consumer:
    service: settlement        # 리스너가 도는 서비스 (인스턴스마다 concurrency개 스레드, CPU·힙·커넥션풀 공유)
    endpoint: "@RabbitListener settle"
    concurrency: 4
    prefetch: 50               # 브로커 왕복이 prefetch만큼 분산됨
    ack: manual                # manual: 실패 시 nack·재전달 / auto: 실패하면 유실
    maxRetries: 3              # 넘으면 DLQ. 생략(infinite)하면 영원히 재전달
    dlq: true
    retryDelay: 0ms
    deliveryRtt: 2ms
```

```yaml
order-events:
  kind: queue
  broker: kafka
  kafka:
    partitions: 12             # 컨슈머 병렬도의 상한
    keySkew: 0                 # 0 = 키 고르게 / 클수록 핫 파티션
    brokers: 3                 # 파티션 리더가 브로커에 분산 (멤버 i = broker i)
    replicationFactor: 3
    minInsyncReplicas: 2       # acks=all에서 살아 있는 레플리카가 이보다 적으면 쓰기 거부
    acks: all                  # all | 1
    replicationTime: { p50: 1ms, p99: 5ms }
    electionTime: 5s           # 브로커 장애 → 리더 재선출. 그동안 해당 파티션 발행·소비 정지 (프로듀서는 기다림)
    deliveryTimeout: 30s       # 프로듀서가 기다리는 최대 시간
    rebalanceTime: 10s         # 컨슈머 인스턴스가 빠지거나 돌아오면 그룹 전체가 이 시간 동안 정지
  consumer:
    service: settlement
    endpoint: "@KafkaListener settle"
    concurrency: 3             # 인스턴스당 컨슈머 스레드. 스레드 합이 파티션보다 많으면 남는 스레드는 놂
    maxPollRecords: 500
    onError: retry             # retry: 제자리 재시도 (그 파티션 전체가 멈춤) / skip
    retryBackoff: 1s
    maxRetries: 9              # Spring Kafka DefaultErrorHandler 기본값
    dlq: true                  # DLT
```

### external

```yaml
pg:
  kind: external
  concurrency: 400             # 상대 측 동시 처리량 (기본 무제한)
  latency: { p50: 120ms, p99: 450ms }
  failureRate: 0.05%           # 5xx 비율
  rateLimit: 1000rps           # 초과 시 429 (too_many_requests)
```

### gateway

API 게이트웨이(Spring Cloud Gateway, Kong 등). 라우트마다 백엔드로 넘기고, 라우트 정책이 연결선이 된다.

```yaml
gateway:
  kind: gateway
  instances: 2
  cpu: 0.5ms                   # 요청당 게이트웨이 자체 CPU (필터·라우팅·직렬화)
  routes:
    "/orders/**": { to: order, timeout: 2s, retry: { max: 2 } }      # 경로 패턴 → 같은 이름의 API
    "GET /products/{id}": { to: "catalog:GET /items/{id}", rateLimit: 200rps }   # 다른 API로 매핑, 라우트 rate limit → 429
```

### loadbalancer

```yaml
alb:
  kind: loadbalancer
  target: gateway              # 서비스 또는 게이트웨이
  algorithm: least-conn        # round-robin | least-conn | random | p2c
  layer: 7                     # 4 = TCP (NLB), 7 = HTTP (ALB)
  healthCheck: { interval: 5s, threshold: 2 }
  timeout: 60s                 # idle / request timeout → 504
```

### cdn

캐시 적중은 엣지에서 바로 응답하고, 미스와 GET·HEAD가 아닌 요청만 오리진으로 간다.

```yaml
cdn:
  kind: cdn
  origin: alb                  # 서비스·게이트웨이·로드밸런서
  hitRate: 90%                 # GET·HEAD 기본 적중률
  rules:
    "GET /search": 0%          # 개인화·실시간 응답은 캐시하지 않음
    "GET /products/**": 98%
  edgeLatency: { p50: 1ms, p99: 6ms }
  originRtt: 30ms              # 엣지 → 오리진 왕복
  originTimeout: 30s
```

### pooler

DB 커넥션 풀러(PgBouncer, ProxySQL, RDS Proxy). 호출하는 쪽은 DB 쿼리 이름을 그대로 쓰고(`pgbouncer:insertOrder`),
여러 앱의 연결이 `poolSize`개의 DB 연결로 나뉘어 쓰인다(트랜잭션 풀링). 앱이 많아도 DB 동시 쿼리가 늘지 않는다.

```yaml
pgbouncer:
  kind: pooler
  engine: pgbouncer            # pgbouncer (단일 이벤트 루프) | proxysql | rds-proxy
  target: orders-db
  poolSize: 40                 # default_pool_size: DB로 가는 연결 수
  maxClientConn: 1000          # 넘는 클라이언트 연결은 거절
  queryWaitTimeout: 120s       # DB 연결을 기다리는 최대 시간
```

### nosql

파티션·복제가 있는 저장소. `engine`이 프리셋을 고르고, 아래 키로 무엇이든 덮어쓸 수 있다. 인스턴스 i = 노드 i.

```yaml
orders-table:
  kind: nosql
  engine: dynamodb             # dynamodb | cassandra | mongodb | elasticsearch
  nodes: 3                     # 노드 수 (Cassandra 노드, ES 데이터 노드)
  partitions: 8                # 키 범위: DynamoDB 파티션, Mongo 샤드, ES 프라이머리 샤드
  replication: 3               # 복제 계수 / 복제 세트 크기 / ES는 1 + replicas
  consistency: { read: ONE, write: QUORUM }   # ONE | QUORUM | ALL | 숫자 | majority (Mongo write concern)
  readPreference: primary      # mongodb: primary | secondary
  concurrency: 128             # 노드당 동시 처리 (ES search 스레드풀 7, Cassandra native transport 128)
  queue: 1000                  # 노드당 대기열. 넘치면 거절 (ES는 429)
  partitionRate: { read: 3000rps, write: 1000rps }   # 파티션당 처리량 한도. 넘으면 ProvisionedThroughputExceeded (429)
  keySkew: 0.8                 # 0 = 고르게, 1 = 소수의 핫 키 → 핫 파티션
  failoverTime: 12s            # primary가 죽은 뒤 새 primary 선출까지 (그동안 그 파티션의 쓰기는 실패)
  ops:
    GetItem: { latency: { p50: 3ms, p99: 9ms } }
    PutItem: { write: true }   # 이름이 Put·Insert·Update·Delete·Save·Index…면 쓰기로 추정
    search: { scatter: true }  # 모든 파티션에 보내고 가장 느린 응답을 기다림 (ES의 search는 기본)
```

| 엔진 | 기본값 | 모델 |
|---|---|---|
| dynamodb | 파티션 4, 쓰기 QUORUM, 파티션당 읽기 3000/s · 쓰기 1000/s | 테이블 전체가 남아도 뜨거운 파티션 하나가 한도를 넘으면 스로틀링 |
| cassandra | 노드 3, RF 3, QUORUM, 노드당 128 · 큐 1024 | 리더 없음. 일관성 수준만큼의 복제본 중 가장 느린 응답을 기다림. 복제본이 모자라면 실패 |
| mongodb | 복제 세트 3, w: majority, readPreference primary, 선출 12s | 쓰기는 primary → 과반 복제. primary 장애 시 선출 동안 쓰기 실패 |
| elasticsearch | 노드 3, 샤드 5 × 복사본 2, search 스레드풀 7 · 큐 1000 | 검색은 모든 샤드로 퍼지고 가장 느린 샤드를 기다림. 큐가 넘치면 429 |

### objectstore

S3 같은 오브젝트 스토리지 (`kind: nosql, engine: s3`와 같다).

```yaml
media:
  kind: objectstore
  prefixes: 1                  # 키 앞부분으로 나뉘는 범위. prefix마다 GET 5500/s · PUT 3500/s (넘으면 503 SlowDown)
  bandwidth: 640mbps           # 요청 하나의 전송 속도 (크기 / 대역폭이 지연에 더해짐)
  ops:
    GetObject: { size: 200kb } # 첫 바이트 지연 기본 p50 15ms · p99 80ms
    PutObject: { size: 2mb }   # 쓰기 기본 p50 30ms · p99 150ms
```

## edges

키는 `호출자->피호출자`다. 호출 관계가 있는데 연결선을 적지 않으면 기본값으로 만들어진다(timeout 없음 — 정적 검사가 경고한다).
트래픽 진입은 `client->서비스` 연결선이다.

```yaml
order->payment:
  network:
    rtt: 1ms                   # 기본 0.5ms (client에서는 2ms)
    jitter: 0.2ms              # 기본 0.1ms
    loss: 0.1%                 # 패킷 손실률
    rtoMin: 200ms              # 최소 재전송 timeout
    bandwidth: 1gbps
    keepAlive: true            # false면 호출마다 핸드셰이크
    tls: false                 # true면 핸드셰이크 RTT 2회
  timeout: 2s                  # 읽기 timeout (TimeLimiter). 기본 없음
  connectTimeout: 1s           # 기본 = timeout
  pool: { size: 10, timeout: 3s }      # DB 대상은 HikariCP(기본 10, 30s), 그 외는 HTTP 커넥션풀(기본 없음). 인스턴스마다
  retry:
    max: 3                     # 최대 시도 수 (첫 시도 포함)
    wait: 100ms                # 기본 500ms
    backoff: exponential       # fixed | exponential
    multiplier: 2
    maxWait: 2s
    jitter: true               # true = ±50%, 또는 비율(0.2)
    on: [timeout, error, conn] # 재시도 대상. 기본 전부
  circuitBreaker:              # 기본값은 Resilience4j와 같다
    failureRate: 50            # %
    slowCall: 1s               # 느린 호출 기준
    slowCallRate: 100          # %
    windowType: count          # count: 최근 N회 / time: 최근 N초
    window: 100                # 윈도우 크기
    minCalls: 100
    openFor: 60s
    halfOpenCalls: 10
  bulkhead: { maxConcurrent: 25, maxWait: 0ms }
  blocking: true               # 호출이 스레드를 막는지 (webflux·가상 스레드에서 의미). 기본: DB(JDBC)는 true, 나머지 false
  fallback: { latency: 2ms }   # 최종 실패 시 대체 응답 (성공으로 집계, degraded 표시)
  rateLimiter: { limit: 50, period: 1s, timeout: 0ms }
```

모든 정책 객체는 `enabled: false`로 값을 남긴 채 끌 수 있다. 웹의 스위치가 이 방식을 쓴다.

**오류 종류** (`retry.on`과 결과의 `byKind`): `timeout`, `error`(5xx), `conn`(연결 실패·SYN 드롭·단절), `rejected`(bulkhead),
`cb_open`, `pool_timeout`, `rate_limited`(클라이언트 측 rate limiter), `too_many_requests`(429).

## network

시스템이 놓인 환경의 기본 네트워크. 연결선에 `network.rtt`를 적지 않으면 이 값을 쓴다.

```yaml
network:
  rtt: 0.5ms                   # 서비스 사이 (기본 0.5ms; 같은 호스트 ~0.05ms, 같은 AZ ~0.3ms, 다른 AZ ~1ms)
  jitter: 0.1ms
  clientRtt: 2ms               # 클라이언트 → 진입점 (기본 2ms)
  clientJitter: 0.5ms
```

`load-sim calibrate`는 서비스·DB·캐시의 기본 지연 배율, 네트워크 RTT 배율, DB 경합 곡선을 실측에 맞춘다.
명시한 `cpu`는 측정된 사실로 보고 바꾸지 않는다. 부하가 높은 지점에 더 큰 가중치를 준다.

## mesh

서비스 메시(Istio·Linkerd). 켜면 서비스 사이 호출에 사이드카 지연·CPU가 붙고, 메시 정책이 적용된다.

```yaml
mesh:
  sidecarLatency: { p50: 0.3ms, p99: 2ms }   # 사이드카 한 번 통과
  sidecarCpu: 0.2ms            # 요청마다 사이드카가 같은 파드 CPU를 씀 (들어올 때 + 나갈 때)
  retries: { attempts: 2, perTryTimeout: 500ms, on: [conn, error] }   # 다른 인스턴스로 재시도 (previous_hosts)
  outlierDetection: { consecutive5xxErrors: 5, baseEjectionTime: 30s, maxEjectionPercent: 50 }
  timeout: 3s
  connectionPool: { maxRequests: 100 }       # 넘으면 즉시 거절 (bulkhead)
  exclude: [legacy]            # 메시 밖의 서비스
```

## topology

```yaml
topology:
  zones: [a, b, c]
  crossZoneRtt: 1ms            # 존 사이 추가 왕복 지연
  zoneAware: true              # 같은 존의 정상 인스턴스를 우선
```

노드마다 `zones: [a, b]`로 배치를 정한다(인스턴스·멤버를 번갈아). 장애에 `{ target: '*', zone: a, down: true }`로 존 전체를 멈출 수 있다.

## scenario

```yaml
scenario:
  duration: 90s                # 기본 60s
  warmup: 5s                   # 요약 지표에서 제외할 앞부분 (기본 min(10s, 10%))
  seed: 42                     # 같은 시드 = 같은 결과
  clientTimeout: 10s           # 클라이언트가 기다리는 최대 시간 (기본 30s)
  arrival: poisson             # poisson | uniform
  vars:
    items: { dist: uniform, min: 1, max: 5 }   # 호출 반복 횟수에 쓰는 변수
  traffic:
    type: spike                # constant | ramp | spike | steps
    base: 200rps
    peak: 2000rps
    at: 30s
    hold: 40s
    rampUp: 0s
    mix: { "GET /products": 70%, "POST /carts": 20%, "POST /orders": 10% }   # 같은 이름이 여러 서비스에 있으면 "서비스:API"
  # type: constant  → rps
  # type: ramp      → from, to, start, end
  # type: steps     → steps: [ { at: 0s, rps: 100 }, { at: 30s, rps: 500 } ]
  schedules:
    - { endpoint: "order:POST /admin/report", every: 10s, at: 5s }   # @Scheduled 배치
  faults:
    - { target: payment-db, at: 20s, until: 70s, latencyX: 20 }      # 노드 지연 배수
    - { target: payment-db, at: 20s, for: 15s, errorRate: 100% }     # 노드 오류율
    - { target: order->payment, at: 30s, loss: 1% }                  # 연결선 손실
    - { target: order->payment, at: 30s, until: 40s, down: true }    # 네트워크 파티션
    - { target: stock, at: 10s, down: true, enabled: false }         # 꺼 둔 장애
    - { target: payment, instance: 1, at: 20s, down: true, hang: true }   # 인스턴스 하나가 무응답 (헬스체크 공백)
    - { target: order-db, instance: 0, at: 30s, down: true }         # DB primary 장애 → failover
    - { target: redis, instance: 2, at: 30s, down: true }            # Redis 샤드 2 장애
    - { target: order-events, instance: 0, at: 30s, down: true }     # Kafka 브로커 0 / RabbitMQ 노드 0 장애
    - { target: product-cache, at: 40s, flush: true }                # 캐시 전체 만료 (재시작)
    - { target: order-events, at: 20s, until: 40s, pause: true }     # 컨슈머 정지
  websocket:                   # 실시간 연결: 연결을 유지한 채 메시지를 주고받는 클라이언트
    clients: 8000
    connectOver: 20s           # 처음 연결이 퍼지는 시간
    connect: "chat:GET /ws"    # handshake: true인 API
    message: "chat:MESSAGE chat.send"
    messageRate: 0.2           # 클라이언트당 초당 메시지
    heartbeatTimeout: 30s      # 이 시간 동안 응답이 없으면 끊긴 것으로 봄
    connMemory: 50kb           # 연결당 힙
    reconnect: { delay: 1s, multiplier: 2, maxDelay: 30s, jitter: true }   # 끊기면 재연결
  slo:
    p99: 300ms
    errorRate: 0.1%
    endpoints:
      POST /orders: { p99: 1s }                                      # API별 SLO
```

## 가져오기

실제 환경에서 시나리오를 만듭니다. 웹은 "시나리오 ▾ → 내 환경 가져오기", CLI는 `load-sim import`입니다.

| 입력 | 채우는 것 |
|---|---|
| application.yml / .properties | Tomcat 스레드·accept-count, 가상 스레드, HikariCP 풀·대기 timeout과 DB 노드, Redis, Resilience4j(서킷브레이커·재시도·TimeLimiter·Bulkhead·RateLimiter), Feign timeout, RabbitMQ·Kafka 리스너 설정. 프로필 문서 지원 |
| Spring 소스 폴더 | `@RestController` 매핑 전부(트래픽이 없는 API 포함), `@RabbitListener`·`@KafkaListener`, `@Scheduled`, Feign 클라이언트, RestClient/WebClient URL, Repository 호출, RabbitTemplate/KafkaTemplate 발행 — 주입된 빈을 따라 호출 순서대로 |
| OpenAPI (springdoc) | API 목록과 응답 크기 추정 ("미관측") |
| OpenTelemetry 트레이스 (OTLP JSON) | API별 자체 처리 시간 분포(p50/p99), API·쿼리·캐시·발행 단위 호출 그래프와 확률·반복 횟수, 쿼리·외부 API 지연, 트래픽 믹스와 rps |
| Prometheus 스크랩 2개 (간격 n초) | API별 rps·믹스·지연, 요청당 CPU 시간과 힙 할당량, 스레드·HikariCP 풀 크기, vCPU·힙 |
| k6 스크립트 | 트래픽 패턴(arrival-rate 단계), API 믹스, SLO(thresholds) |

같은 API를 여러 출처가 말하면 **트레이스 > Prometheus > 설정 > 소스·OpenAPI** 순으로 믿습니다.
트레이스에 없는 API는 `observed: false`로 표시되고 결과에 "추정"이 붙습니다.

```bash
load-sim import --service order --spring-src ./order --application ./order/src/main/resources/application.yml \
  --traces traces.json --prometheus before.txt,after.txt --seconds 60 --k6 load.js --out scenario.yaml
```
