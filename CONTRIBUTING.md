# 기여 가이드

load-simulator는 "예쁘지만 틀린 장난감"이 되지 않는 것을 가장 중요하게 여깁니다. 그래서 모델을 바꾸는 기여에는 근거가 필요합니다.

## 개발 환경

```bash
npm install
npm run dev          # 웹 UI (http://localhost:5173)
npm test             # 엔진 테스트
npm run typecheck
npm run build        # CLI 번들 + 웹 정적 빌드
npm run sim -- run examples/01-cascading-failure.yaml
```

Node.js 20 이상이 필요합니다.

## 구조

- `packages/engine` — 순수 함수 엔진. DOM·Node API를 쓰지 않습니다(브라우저와 Node 양쪽에서 돕니다).
- `packages/web` — React UI. 엔진은 Web Worker에서 돌립니다.
- `packages/cli` — `load-sim` 명령.
- `examples` — 데모 시나리오. 웹과 CLI가 같은 파일을 씁니다.
- `docs` — 기획서, 설계, YAML 레퍼런스, 정확도, 로드맵.

## 모델을 바꿀 때

1. **결정성 유지**: 모든 난수는 `Rng`을 거칩니다. `Math.random()`, `Date.now()`를 시뮬레이션 로직에 쓰지 마세요.
2. **근거 남기기**: 새 현상을 모델링하면 그 동작을 재현하는 테스트를 `packages/engine/test`에 추가하세요.
   해석해가 있는 경우(큐잉 이론 등) 해석해와 비교하는 테스트가 가장 좋습니다.
3. **단순화 공개**: 실제와 다르게 단순화한 부분은 `docs/architecture.md`의 "단순화와 알려진 한계"에 적어 주세요.
4. **성능 확인**: 데모 시나리오의 실행 시간이 크게 늘지 않는지 `npm run sim -- run examples/02-retry-storm.yaml`로 확인하세요.
5. **입력 형식**: YAML 필드를 추가하면 `docs/model-reference.md`도 갱신하세요.

## 커밋·PR

- 한 PR에는 한 가지 변경을 담아 주세요.
- CI(타입 검사, 테스트, 빌드, 데모 정적 검사·용량 회귀)가 통과해야 합니다.
