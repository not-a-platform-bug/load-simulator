// "블록 추가" menu, grouped by where a component sits in a typical system.
import { useEffect, useRef, useState } from 'react';
import type { NodeKind } from './doc';

const GROUPS: { title: string; items: { kind: NodeKind; label: string; hint: string }[] }[] = [
  {
    title: '진입',
    items: [
      { kind: 'cdn', label: 'CDN', hint: '캐시 적중은 엣지에서 응답' },
      { kind: 'loadbalancer', label: '로드밸런서', hint: 'ALB · NLB · Nginx' },
      { kind: 'gateway', label: 'API 게이트웨이', hint: '라우팅 · rate limit' },
    ],
  },
  { title: '애플리케이션', items: [{ kind: 'service', label: '서비스', hint: 'Spring Boot 등' }] },
  {
    title: '데이터',
    items: [
      { kind: 'db', label: 'RDB', hint: 'MySQL · PostgreSQL' },
      { kind: 'pooler', label: '커넥션 풀러', hint: 'PgBouncer · ProxySQL' },
      { kind: 'cache', label: '캐시', hint: 'Redis · Memcached' },
      { kind: 'nosql', label: 'NoSQL · 검색', hint: 'DynamoDB · Cassandra · MongoDB · ES' },
      { kind: 'objectstore', label: '오브젝트 스토리지', hint: 'S3 · GCS' },
    ],
  },
  { title: '메시징', items: [{ kind: 'queue', label: '메시지 큐', hint: 'RabbitMQ · Kafka' }] },
  { title: '외부', items: [{ kind: 'external', label: '외부 API', hint: '결제 · 알림 등' }] },
];

export function AddMenu({ onAdd }: { onAdd: (k: NodeKind) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="add-menu" ref={ref}>
      <button className={open ? 'primary small' : 'ghost small'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        + 블록 추가
      </button>
      {open && (
        <div className="add-pop" role="menu">
          {GROUPS.map((g) => (
            <div key={g.title} className="add-group">
              <div className="add-title">{g.title}</div>
              {g.items.map((it) => (
                <button
                  key={it.kind}
                  role="menuitem"
                  className={`add-item kind-${it.kind}`}
                  onClick={() => {
                    onAdd(it.kind);
                    setOpen(false);
                  }}
                >
                  <i />
                  <span>{it.label}</span>
                  <small>{it.hint}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
