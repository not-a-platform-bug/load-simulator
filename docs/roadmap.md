# 로드맵

기획서([spec.md](spec.md)) 11장의 "단계마다 게이트를 통과해야 다음으로 넘어간다"는 원칙을 마일스톤으로 옮긴 것이다.
체크 표시는 저장소에 실제로 들어가 테스트된 것만 한다. 일정은 정하지 않았다.

**제품의 중심은 "실제 환경을 그대로 옮겨와 실제 동작을 시뮬레이션하고 부하 테스트하는 것"이다.**
예제 시나리오는 학습·시연용이고, 가져오기·보정·검증이 우선이다.

## M0. 엔진 골격 ✅

- [x] 시드 고정 난수, 이진 힙 사건 큐, 선언형 YAML과 단위 해석
- [x] 분포(고정·지수·로그정규·균등), 컴포넌트(서비스·DB·캐시·외부 API·메시지 큐), API 단위 호출 그래프(확률·반복)
- [x] 트래픽 믹스, 패턴(상수·램프·스파이크·계단), 스케줄 잡
- [x] 초 단위 타임라인, API별 지표·SLO, 자원별 포화도

**게이트:** M/M/c 해석해(Erlang C)와 5% 이내 일치 → `test/queueing.test.ts` 통과.

## M1. MVP 데모 1~3 ✅

- [x] 회복성 정책(Timeout, Retry, Circuit Breaker — 횟수·시간 윈도우, Bulkhead, Fallback, Rate Limiter)과 필수 다섯 동작
- [x] 정적 검사, OS 계층(CPU·GC·소켓 큐), 네트워크 계층, 장애 주입, 용량 산출
- [x] 웹 UI, CLI, 데모 3종

**게이트:** 세 데모의 문제와 해결이 한 화면에서 재현, 재계산 0.5초 이내(프로덕션 빌드 약 0.2~0.4초).

## M2. 검증 하네스 — 구현 완료, 첫 실측 대기

- [x] `harness/`: Spring Boot 4.1 order·payment·stock, MySQL, Redis, RabbitMQ, Kafka, Toxiproxy, Prometheus (CPU·메모리 limit 고정)
- [x] 시나리오 → k6 스크립트(`load-sim k6`), 장애 → Toxiproxy 실시간 적용(`load-sim toxiproxy`), 설정 → Spring 환경 변수(`load-sim spring-env`)
- [x] 저부하 측정 → `calibrate` → 고부하 외삽·장애 실행 → `compare` 오차표 (`harness/run.mjs`)
- [ ] **첫 실측 실행과 [accuracy.md](accuracy.md) 오차표 공개** ← 게이트

**게이트:** 데모급 시나리오에 대해 오차표가 채워진다(목표 달성 여부와 무관하게 공개).

## M3. 실제 환경 가져오기·보정 ✅

- [x] application.yml/.properties (Tomcat, 가상 스레드, HikariCP, Redis, Resilience4j, Feign, RabbitMQ, Kafka, 프로필)
- [x] Spring 소스 정적 분석 (컨트롤러, 리스너, 스케줄, Feign, RestClient/WebClient, Repository, 메시지 발행 — 빈을 따라 호출 순서대로)
- [x] OpenAPI, OpenTelemetry 트레이스(OTLP JSON), Prometheus 스크랩, k6 스크립트
- [x] 출처 우선순위 병합, "미관측(추정)" API 표시
- [x] 실측 지점에 맞춘 파라미터 보정(`calibrate`)
- [x] 웹 "내 환경 가져오기" (브라우저 안에서 처리)

## M4. 2단계 시나리오와 모델 ✅

- [x] 4 GC 일시정지 / 5 소켓 backlog / 6 패킷 손실(꼬리 손실 RTO) / 7 캐시 스탬피드(TTL·lock) / 8 큐 컨슈머 지연과 회복
- [x] WebFlux·가상 스레드 런타임, 컨텍스트 스위칭, cgroup 쓰로틀링, 파일 디스크립터, 임시 포트
- [x] RabbitMQ(prefetch, ack, 재전달, DLQ)와 Kafka(파티션, 핫 키, 블로킹 재시도, 리밸런스, DLT)
- [x] 10 Kafka 파티션 지연

## M5. 3단계·생태계 ✅ (일부 보류)

- [x] 9 헬스체크 공백, 인스턴스 단위 장애(무응답 포함)
- [x] 클러스터: DB primary/레플리카·failover, Redis Cluster 샤드, Kafka 브로커·리더 선출·min ISR, RabbitMQ classic/quorum
- [x] **권장 엔진**: 진단 → 후보 → 후보별 시뮬레이션 → 단계별 계획 (예제 10개 모두 스스로 해결책을 찾는지 테스트)
- [x] GitHub Action(`action.yml`), Gradle 플러그인(`gradle-plugin/`)
- [x] 시나리오 라이브러리(자동 저장), 되돌리기, 예제 자동 인식(`examples/*.yaml`)
- [ ] PixiJS(WebGL) 입자 렌더링 — 보류: 표본 2,500개는 Canvas 2D로 60fps가 나와 이득이 없다
- [ ] Rust → WASM 엔진 — 보류: 기획서 조건("필요 시")에 해당하지 않는다(재계산 0.5초 이내 충족)

## M6. 실제 시스템 구성 요소 확장 ✅

- [x] 진입: API 게이트웨이(라우트·rate limit), 로드밸런서(L4/L7·분산 알고리즘·헬스체크), CDN(경로별 적중률)
- [x] 플랫폼: 서비스 메시(사이드카·메시 재시도·outlier detection), 가용 영역(존 장애·존 인지 라우팅), WebSocket(연결 고정·브로드캐스트·재연결)
- [x] 분산: DB 샤딩·scatter 쿼리, Redis Cluster 샤드, 커넥션 풀러(PgBouncer·ProxySQL)
- [x] NoSQL·검색·오브젝트 스토리지: DynamoDB(파티션 처리량), Cassandra(일관성 수준), MongoDB(primary 선출), Elasticsearch(샤드 fan-out·429), S3(prefix 한도)
- [x] API 호출 흐름 편집: 순차·병렬 그룹·호출 사이 처리·캐시 미스 경로
- [x] 예제 12~15와 권장 규칙(게이트웨이 증설, 재연결 백오프, 키 분산, 노드 증설, 일관성 조정, CDN)

## 다음

- [ ] 첫 하네스 실측 → 오차표 공개 → 오차가 큰 모델 보정
- [ ] 권장 엔진 규칙 확장(쿼리 인덱스·캐시 도입 같은 구조 변경, 비용 모델 정교화)
- [ ] Jaeger/Zipkin 트레이스, Grafana Tempo 직접 연동, Prometheus API 직접 조회
- [ ] DB 레플리카 복제 지연, Kafka 배치 처리·@RetryableTopic, at-least-once 재처리
- [ ] npm·Gradle Plugin Portal 배포
