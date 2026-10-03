import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { applyAdvicePatch, type RawDoc, type Recommendation, type SimResult } from '@load-simulator/engine';
import { ArchitectureCanvas, autoLayout, type Layer, type Layout, type Selection } from './Canvas';
import { Inspector } from './Inspector';
import { Results } from './Results';
import { Timeline } from './Timeline';
import { YamlEditor } from './YamlEditor';
import { AdvisorPanel } from './Advisor';
import { AddMenu } from './AddMenu';
import { ImportWizard } from './ImportWizard';
import { ConnectDialog } from './ConnectDialog';
import { NodeCard } from './NodeCard';
import { DEMOS, type Demo } from './examples';
import { addNode, clone, connect, fromYaml, removeEdge, removeNode, toYaml, type NodeKind } from './doc';
import { readShareFromHash, shareUrl } from './share';
import { useSimulation } from './useSim';
import { clock } from './clock';
import { ms, toMs } from './format';
import { deleteScenario, getCurrentId, getScenario, listScenarios, newId, saveScenario, setCurrentId, storageAvailable, type SavedScenario } from './library';

type Tab = 'advice' | 'results' | 'settings' | 'yaml';

interface Meta {
  id: string;
  name: string;
  origin: string;
  /** saved to the library (demos and shared links are saved on the first edit) */
  persisted: boolean;
}

function splitLayout(full: RawDoc): { doc: RawDoc; layout: Layout } {
  const { layout, ...doc } = full;
  return { doc, layout: (layout ?? {}) as Layout };
}

const BLANK: RawDoc = {
  nodes: {
    api: { kind: 'service', instances: 2, runtime: { threads: 200 }, os: { vcpu: 2, heap: '1g' }, endpoints: { 'GET /items': { selfTime: { p50: '5ms', p99: '25ms' } } } },
  },
  scenario: { duration: '60s', traffic: { type: 'constant', rps: 200, mix: { 'GET /items': '100%' } }, slo: { p99: '300ms', errorRate: '0.1%' } },
};

/** Re-renders only when the whole second (or play state) changes. */
function usePlayhead(): { sec: number; playing: boolean } {
  const [s, setS] = useState({ sec: 0, playing: false });
  useEffect(
    () =>
      clock.subscribe((t) => {
        const sec = Math.floor(t / 1000);
        setS((p) => (p.sec === sec && p.playing === clock.playing ? p : { sec, playing: clock.playing }));
      }),
    [],
  );
  return s;
}

function Player({ duration, playing }: { duration: number; playing: boolean }) {
  const [t, setT] = useState(clock.t);
  const [speed, setSpeed] = useState(clock.speed);
  useEffect(() => clock.subscribe((x) => setT((p) => (Math.abs(p - x) < 50 ? p : x))), []);
  return (
    <>
      <button className="play" onClick={() => (playing ? clock.pause() : clock.play())} aria-label={playing ? '일시정지' : '재생'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="clock">
        {(t / 1000).toFixed(1)}s <small>/ {duration ? (duration / 1000).toFixed(0) : '—'}s</small>
      </span>
      <input type="range" min={0} max={duration || 1} step={100} value={t} onChange={(e) => clock.seek(Number(e.target.value))} aria-label="재생 위치" />
      <select
        value={speed}
        onChange={(e) => {
          clock.speed = Number(e.target.value);
          setSpeed(clock.speed);
        }}
        aria-label="재생 속도"
      >
        {[1, 2, 4, 8, 16].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [doc, setDocRaw] = useState<RawDoc | null>(null);
  const [layout, setLayout] = useState<Layout>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [layer, setLayer] = useState<Layer>('app');
  const [tab, setTab] = useState<Tab>('advice');
  const [compare, setCompare] = useState<{ result: SimResult; label: string } | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [connectReq, setConnectReq] = useState<{ from: string; to: string } | null>(null);
  const [changedPaths, setChangedPaths] = useState<(string | number)[][]>([]);
  const [library, setLibrary] = useState<SavedScenario[]>(() => listScenarios());
  const [canvasKey, setCanvasKey] = useState(0);
  const autoplay = useRef(false);
  const autoAdvise = useRef(false);
  const undo = useRef<RawDoc[]>([]);
  const redo = useRef<RawDoc[]>([]);
  const dirty = useRef(false);
  const { run, cap, runCapacity, clearCapacity, adv, runAdvice, clearAdvice } = useSimulation(doc);
  const { sec, playing } = usePlayhead();
  const result = run.result && run.doc && sameNodes(run.doc, doc) ? run.result : null;

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 3500);
  }, []);

  /** every user edit goes through here: undo history + autosave */
  const setDoc = useCallback((d: RawDoc) => {
    setDocRaw((prev) => {
      if (prev && prev !== d) {
        undo.current.push(prev);
        if (undo.current.length > 100) undo.current.shift();
        redo.current = [];
      }
      return d;
    });
    dirty.current = true;
    setYamlError(null);
  }, []);

  const open = useCallback(
    (full: RawDoc, m: Meta) => {
      const { doc: nd, layout: nl } = splitLayout(clone(full));
      setMeta(m);
      setDocRaw(nd);
      setLayout(autoLayout(nd, nl));
      setSelection(null);
      setCardOpen(false);
      setCompare(null);
      setChangedPaths([]);
      undo.current = [];
      redo.current = [];
      dirty.current = false;
      setCanvasKey((k) => k + 1);
      clearCapacity();
      clearAdvice();
      autoAdvise.current = true;
      setTab('advice');
      clock.pause();
      clock.seek(0);
      autoplay.current = true;
      if (m.persisted) setCurrentId(m.id);
    },
    [clearCapacity, clearAdvice],
  );

  const openDemo = useCallback((d: Demo) => open(d.doc, { id: newId(), name: d.title, origin: `demo:${d.id}`, persisted: false }), [open]);

  // first load: shared link → last scenario → welcome
  useEffect(() => {
    readShareFromHash().then((shared) => {
      if (shared) return open(shared, { id: newId(), name: shared.demo?.title ?? '공유된 시나리오', origin: 'shared', persisted: false });
      const cur = getCurrentId();
      const saved = cur ? getScenario(cur) : undefined;
      if (saved) return open(saved.doc, { id: saved.id, name: saved.name, origin: saved.origin, persisted: true });
      openDemo(DEMOS[0]);
      setWelcome(true);
    });
  }, [open, openDemo]);

  // autosave (debounced) once the scenario has been edited
  useEffect(() => {
    if (!meta || !doc || !dirty.current) return;
    const t = setTimeout(() => {
      const ok = saveScenario({ id: meta.id, name: meta.name, origin: meta.origin, doc: { ...doc, layout }, updatedAt: Date.now() });
      if (ok) {
        if (!meta.persisted) {
          setMeta((m) => (m ? { ...m, persisted: true } : m));
          setCurrentId(meta.id);
          if (meta.origin.startsWith('demo:')) flash(`수정한 예제를 "${meta.name}"(으)로 내 시나리오에 저장했습니다.`);
        }
        setLibrary(listScenarios());
      } else if (!storageAvailable()) flash('이 브라우저는 저장소를 막고 있어 자동 저장할 수 없습니다. YAML로 내려받으세요.');
    }, 600);
    return () => clearTimeout(t);
  }, [doc, layout, meta, flash]);

  // keep the clock in step with results; autoplay newly opened scenarios; first diagnosis
  useEffect(() => {
    if (!result) return;
    clock.duration = result.duration;
    if (clock.t > result.duration) clock.seek(result.duration);
    else clock.seek(clock.t);
    if (autoplay.current) {
      autoplay.current = false;
      clock.seek(0);
      clock.play();
    }
    if (autoAdvise.current && doc && run.doc === doc) {
      autoAdvise.current = false;
      runAdvice(doc);
    }
  }, [result, doc, run.doc, runAdvice]);

  // undo / redo shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev || !doc) return;
    redo.current.push(doc);
    setDocRaw(prev);
    dirty.current = true;
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (!next || !doc) return;
    undo.current.push(doc);
    setDocRaw(next);
    dirty.current = true;
  };

  const fullDoc = useMemo(() => (doc ? { ...doc, layout } : null), [doc, layout]);
  const yamlText = useMemo(() => (fullDoc ? toYaml(fullDoc) : ''), [fullDoc]);

  const onYaml = (text: string) => {
    try {
      const { doc: nd, layout: nl } = splitLayout(fromYaml(text));
      setDoc(nd);
      setLayout(autoLayout(nd, nl));
    } catch (e) {
      setYamlError((e as Error).message);
    }
  };

  const share = async () => {
    if (!fullDoc) return;
    const url = await shareUrl(fullDoc);
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      flash('공유 링크를 복사했습니다. 같은 설정·시드로 같은 결과가 재현됩니다.');
    } catch {
      flash('주소창의 링크를 공유하세요.');
    }
  };

  const download = () => {
    if (!fullDoc || !meta) return;
    const blob = new Blob([yamlText], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.name.replace(/[^\w가-힣-]+/g, '-') || 'scenario'}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onDelete = (s: Selection) => {
    if (!s || !doc) return;
    setDoc(s.type === 'node' ? removeNode(doc, s.id) : removeEdge(doc, s.id));
    setSelection(null);
    setCardOpen(false);
  };

  const add = (kind: NodeKind) => {
    if (!doc) return;
    const xs = Object.values(layout).map((p) => p[0]);
    const ys = Object.values(layout).map((p) => p[1]);
    const pos: [number, number] = [xs.length ? Math.max(...xs) + 40 : 200, ys.length ? Math.max(...ys) + 160 : 200];
    const r = addNode(doc, kind, pos);
    setDoc(r.doc);
    setLayout((l) => ({ ...l, [r.name]: pos }));
    setSelection({ type: 'node', id: r.name });
    setCardOpen(false);
    setTab('settings');
    flash('블록 오른쪽의 점을 다른 블록으로 끌면, 어느 API가 무엇을 호출하는지 고를 수 있습니다.');
  };

  const select = (s: Selection) => {
    setSelection(s);
    setCardOpen(!!s);
  };

  const applyRecommendation = (recs: Recommendation[]) => {
    if (!doc) return;
    if (result && run.doc === doc) setCompare({ result, label: '적용 전' });
    let d = doc;
    for (const r of recs) d = applyAdvicePatch(d, r.patch);
    setDoc(d);
    setChangedPaths(recs.flatMap((r) => r.patch.map((p) => p.path)));
    const last = recs[recs.length - 1];
    if (last.target) {
      setSelection(last.target.includes('->') ? { type: 'edge', id: last.target } : { type: 'node', id: last.target });
      setCardOpen(true);
    }
    clock.seek(0);
    autoplay.current = true;
    // diagnose the new state as soon as its result is in
    autoAdvise.current = true;
    flash(`${recs.length > 1 ? `${recs.length}개 조치를` : `"${last.title}"을(를)`} 적용했습니다. 점선이 적용 전입니다. 되돌리기: ⌘Z`);
  };

  const createFrom = (d: RawDoc, name: string, origin: string) => {
    const m: Meta = { id: newId(), name, origin, persisted: true };
    saveScenario({ id: m.id, name, origin, doc: d, updatedAt: Date.now() });
    setLibrary(listScenarios());
    open(d, m);
    setImportOpen(false);
    setWelcome(false);
    setMenu(false);
  };

  if (!doc || !meta) return <div className="loading">불러오는 중…</div>;

  const sloP99 = toMs(doc.scenario?.slo?.p99, 300);
  const bottleneck = cap.result?.bottleneck ? cap.result.bottleneck.node : null;
  const demo = meta.origin.startsWith('demo:') ? DEMOS.find((d) => `demo:${d.id}` === meta.origin) : undefined;
  const adviceStale = !!adv.advice && adv.doc !== doc;
  const fresh = adviceStale ? null : adv.advice;
  const top = fresh?.findings.find((f) => f.code === 'saturation-chain') ?? fresh?.findings.find((f) => f.severity === 'critical');
  const healthy = !!fresh && !fresh.findings.some((f) => f.severity !== 'minor');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <h1>load-simulator</h1>
        </div>
        <div className="scenario-picker">
          <input
            className="scenario-name"
            value={meta.name}
            onChange={(e) => {
              setMeta({ ...meta, name: e.target.value });
              dirty.current = true;
            }}
            aria-label="시나리오 이름"
          />
          <button className="ghost" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            시나리오 ▾
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button className="menu-primary" onClick={() => (setImportOpen(true), setMenu(false))}>
                내 환경 가져오기…
                <small>application.yml · 소스 · 트레이스 · 지표 · k6</small>
              </button>
              <button onClick={() => createFrom(clone(BLANK), '새 시나리오', 'blank')}>빈 캔버스에서 시작</button>
              {library.length > 0 && <h4>내 시나리오</h4>}
              {library.map((s) => (
                <div key={s.id} className={`menu-item${s.id === meta.id ? ' current' : ''}`}>
                  <button onClick={() => (open(s.doc, { id: s.id, name: s.name, origin: s.origin, persisted: true }), setMenu(false))}>
                    {s.name}
                    <small>{new Date(s.updatedAt).toLocaleString()}</small>
                  </button>
                  <button
                    className="ghost small"
                    aria-label={`${s.name} 삭제`}
                    onClick={() => {
                      if (!confirm(`"${s.name}"을(를) 삭제할까요?`)) return;
                      deleteScenario(s.id);
                      setLibrary(listScenarios());
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <h4>예제 시나리오</h4>
              {DEMOS.map((d, i) => (
                <button key={d.id} className={meta.origin === `demo:${d.id}` ? 'current' : ''} onClick={() => (openDemo(d), setMenu(false))}>
                  {i + 1}. {d.title}
                </button>
              ))}
              <h4>파일</h4>
              <button onClick={() => (setImportOpen(true), setMenu(false))}>YAML 열기…</button>
              <button onClick={() => (download(), setMenu(false))}>YAML 내려받기</button>
            </div>
          )}
        </div>
        <div className="actions">
          <span className={`status${run.running ? ' busy' : ''}`}>{run.running ? '계산 중…' : result ? `엔진 ${ms(run.ms)}` : ''}</span>
          <button className="ghost icon" onClick={doUndo} disabled={!undo.current.length} title="되돌리기 (⌘Z)" aria-label="되돌리기">
            ↶
          </button>
          <button className="ghost icon" onClick={doRedo} disabled={!redo.current.length} title="다시 실행 (⇧⌘Z)" aria-label="다시 실행">
            ↷
          </button>
          {compare ? (
            <button className="ghost" onClick={() => setCompare(null)}>
              비교 해제
            </button>
          ) : (
            <button className="ghost" disabled={!result} onClick={() => result && setCompare({ result, label: '기준' })} title="현재 결과를 비교 기준으로 고정합니다. 이후 바꾼 결과와 타임라인에 겹쳐 보입니다.">
              비교 기준 고정
            </button>
          )}
          <button className="ghost" onClick={share}>
            공유 링크
          </button>
        </div>
      </header>

      {(top || healthy || adv.running || demo?.problem) && (
        <div className="scene">
          <span className={`scene-tag${top ? ' diag' : healthy ? ' ok' : ''}`}>{top ? '진단' : healthy ? '정상' : adv.running ? '진단 중' : '문제'}</span>
          <p>{top ? `${top.title} — ${top.detail}` : healthy ? 'SLO를 지키고 있고 포화된 자원이 없습니다.' : demo?.problem ?? '시나리오를 진단하는 중입니다…'}</p>
          {top && tab !== 'advice' && (
            <button className="link" onClick={() => setTab('advice')}>
              권장 조치 보기
            </button>
          )}
        </div>
      )}

      {run.error && (
        <div className="error-banner">
          모델 오류: {run.error.message}
          <button className="link" onClick={() => setTab('yaml')}>
            YAML 열기
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="canvas-area">
          <div className="canvas-tools">
            <div className="seg" role="tablist" aria-label="계층 보기">
              {(
                [
                  ['app', '앱'],
                  ['os', 'OS'],
                  ['net', '네트워크'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={layer === k} className={layer === k ? 'active' : ''} onClick={() => setLayer(k)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="legend" aria-label="범례">
              <span title="API마다 색이 다릅니다 (왼쪽 위 목록)">
                <i className="mk req" />
                요청
              </span>
              <span>
                <i className="mk resp" />
                응답
              </span>
              <span>
                <i className="mk err" />
                실패
              </span>
              <span>
                <i className="mk deg" />
                fallback
              </span>
              <span className="muted">블록 색 = 포화도</span>
            </div>
            <AddMenu onAdd={add} />
          </div>
          <div className="canvas">
            <ReactFlowProvider key={canvasKey}>
              <ArchitectureCanvas
                doc={doc}
                layout={layout}
                result={result}
                warnings={run.warnings}
                sec={sec}
                layer={layer}
                selection={selection}
                bottleneck={bottleneck}
                onSelect={select}
                onMove={(name, pos) => setLayout((l) => ({ ...l, [name]: pos }))}
                onConnect={(a, b) => setConnectReq({ from: a, to: b })}
                onDelete={onDelete}
              />
            </ReactFlowProvider>
            {selection && cardOpen && (
              <NodeCard
                doc={doc}
                selection={selection}
                result={result}
                sec={sec}
                findings={adv.advice?.findings ?? []}
                onEdit={() => setTab('settings')}
                onClose={() => (setCardOpen(false), setSelection(null))}
              />
            )}
          </div>
          <div className="player">
            <Player duration={result?.duration ?? 0} playing={playing} />
            {compare && (
              <span className="cmp-chip">
                <i className="dash" /> {compare.label} vs <b>현재</b>
              </span>
            )}
          </div>
          <Timeline result={result} compare={compare?.result ?? null} compareLabel={compare?.label ?? ''} sloP99={sloP99} cbEdge={demo?.focus} />
        </section>

        <aside className="panel">
          <div className="tabs" role="tablist">
            {(
              [
                ['advice', '진단·권장'],
                ['results', '결과'],
                ['settings', selection ? '설정' : '시나리오'],
                ['yaml', 'YAML'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {label}
                {k === 'advice' && adv.running && <span className="tab-dot" aria-label="진단 중" />}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {tab === 'advice' && (
              <AdvisorPanel
                adv={adv}
                stale={adviceStale}
                onRun={() => runAdvice(doc)}
                onApply={(r) => applyRecommendation([r])}
                onApplyPlan={() => adv.advice && applyRecommendation(adv.advice.plan.map((p) => p.step))}
                onSelect={select}
              />
            )}
            {tab === 'results' && (
              <Results
                key={`${meta.id}:${doc.scenario?.slo?.p99}:${doc.scenario?.slo?.errorRate}`}
                result={result}
                compare={compare?.result ?? null}
                warnings={run.warnings}
                cap={cap}
                sloDefaults={{ p99: doc.scenario?.slo?.p99, errorRate: doc.scenario?.slo?.errorRate }}
                onCapacity={(slo) => runCapacity(doc, slo)}
                onSelect={select}
              />
            )}
            {tab === 'settings' && (
              <>
                {selection && (
                  <button className="link back" onClick={() => (setSelection(null), setCardOpen(false))}>
                    ← 시나리오 설정
                  </button>
                )}
                <Inspector doc={doc} selection={selection} onDoc={setDoc} onDelete={onDelete} changed={changedPaths} />
              </>
            )}
            {tab === 'yaml' && <YamlEditor text={yamlText} error={yamlError ?? (run.error ? run.error.message : null)} onChange={onYaml} />}
          </div>
        </aside>
      </main>

      {welcome && (
        <div className="modal-backdrop">
          <div className="modal welcome" role="dialog" aria-modal="true" aria-label="시작하기">
            <h2>실제 환경을 옮겨와 부하 테스트 없이 시뮬레이션합니다</h2>
            <p className="muted">서비스 설정·소스·트레이스·지표를 가져오면 한계 처리량, 첫 병목, 장애 전파를 계산하고 무엇을 바꿔야 하는지 권장합니다.</p>
            <div className="welcome-actions">
              <button className="primary big" onClick={() => (setImportOpen(true), setWelcome(false))}>
                내 환경 가져오기
                <small>application.yml · 소스 폴더 · OpenTelemetry 트레이스 · Prometheus · k6</small>
              </button>
              <button className="ghost big" onClick={() => setWelcome(false)}>
                예제로 둘러보기
                <small>{DEMOS.length}개의 장애 시나리오</small>
              </button>
              <button className="ghost big" onClick={() => createFrom(clone(BLANK), '새 시나리오', 'blank')}>
                빈 캔버스에서 그리기
                <small>블록을 추가하고 연결해 아키텍처를 직접 그립니다</small>
              </button>
            </div>
          </div>
        </div>
      )}
      {importOpen && <ImportWizard onClose={() => setImportOpen(false)} onCreate={createFrom} />}
      {connectReq && (
        <ConnectDialog
          doc={doc}
          from={connectReq.from}
          to={connectReq.to}
          onCancel={() => setConnectReq(null)}
          onConfirm={(c) => {
            setDoc(connect(doc, c));
            setConnectReq(null);
            flash(`${c.from} ${c.fromEndpoint} → ${c.to}:${c.op} 호출을 추가했습니다.`);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function sameNodes(a: RawDoc, b: RawDoc | null): boolean {
  if (!b) return false;
  const ka = Object.keys(a.nodes ?? {});
  const kb = Object.keys(b.nodes ?? {});
  return ka.length === kb.length && ka.every((k) => k in (b.nodes ?? {}));
}
