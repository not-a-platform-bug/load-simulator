// Spring source static analysis (Java/Kotlin, regex + brace matching — no compiler needed):
//   @RestController + @RequestMapping/@GetMapping… → APIs (including ones that never get traffic)
//   @RabbitListener / @KafkaListener              → queue consumer endpoints
//   @Scheduled                                    → schedules (batch jobs sharing the instance's resources)
//   @FeignClient interfaces, RestClient/WebClient/RestTemplate URLs → calls to other services
//   *Repository method calls                      → DB queries;  RabbitTemplate/KafkaTemplate sends → publishes
// Calls are followed through injected beans defined in the same code base (a few levels deep).
import { slug, type ImportReport } from './util';

export interface SourceFile {
  path: string;
  content: string;
}

export interface SpringSourceOptions {
  service: string;
  /** DB node name for repository calls (default "<service>-db") */
  db?: string;
}

interface Method {
  name: string;
  annotations: string;
  body: string;
}

interface Clazz {
  name: string;
  annotations: string;
  methods: Method[];
  /** field name → type */
  fields: Map<string, string>;
  isInterface: boolean;
}

const MAPPING = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(\(([^)]*)\))?/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** index of the brace matching the one at `open` */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return src.length - 1;
}

function parseClasses(src: string): Clazz[] {
  const out: Clazz[] = [];
  const re = /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:public\s+|private\s+|internal\s+|abstract\s+|open\s+|data\s+|final\s+)*(class|interface)\s+(\w+)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    const close = matchBrace(src, open);
    const body = src.slice(open + 1, close);
    const clazz: Clazz = { name: m[3], annotations: m[1], methods: [], fields: new Map(), isInterface: m[2] === 'interface' };
    // fields: "private final PaymentClient paymentClient;"  /  Kotlin "private val paymentClient: PaymentClient"
    for (const f of body.matchAll(/(?:private|protected|public)?\s*(?:final\s+)?([A-Z]\w*)(?:<[^>]*>)?\s+(\w+)\s*[;=]/g)) clazz.fields.set(f[2], f[1]);
    for (const f of body.matchAll(/(?:val|var)\s+(\w+)\s*:\s*([A-Z]\w*)/g)) clazz.fields.set(f[1], f[2]);
    // constructor parameters (constructor injection, records, Kotlin primary constructors)
    const ctor = new RegExp(`${m[3]}\\s*\\(([^)]*)\\)`).exec(src.slice(m.index, open + 1) + body);
    if (ctor) for (const p of ctor[1].matchAll(/([A-Z]\w*)(?:<[^>]*>)?\s+(\w+)|(\w+)\s*:\s*([A-Z]\w*)/g)) clazz.fields.set(p[2] ?? p[3], p[1] ?? p[4]);
    // methods
    const mre = /((?:@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?\s*)*)(?:public|private|protected|internal|override|suspend|fun|static|final|default|\s)*\s*(?:<[^>]*>\s*)?(?:[\w<>[\],.? ]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[\w<>?, ]+)?(?:throws [\w., ]+)?\s*(\{|;|=)/g;
    let mm: RegExpExecArray | null;
    while ((mm = mre.exec(body))) {
      const name = mm[2];
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', clazz.name].includes(name)) continue;
      let mbody = '';
      if (mm[4] === '{') {
        const o = mre.lastIndex - 1;
        const c = matchBrace(body, o);
        mbody = body.slice(o + 1, c);
        mre.lastIndex = c + 1;
      }
      clazz.methods.push({ name, annotations: mm[1], body: mbody });
    }
    out.push(clazz);
  }
  return out;
}

function firstString(args: string | undefined): string {
  if (!args) return '';
  const m = /(?:value|path|name|url)?\s*=?\s*\{?\s*"([^"]*)"/.exec(args);
  return m ? m[1] : '';
}

function mapping(annotations: string): { method: string; path: string } | null {
  const m = MAPPING.exec(annotations);
  if (!m) return null;
  let method = m[1].toUpperCase();
  if (method === 'REQUEST') {
    const rm = /method\s*=\s*\{?\s*(?:RequestMethod\.)?(\w+)/.exec(m[3] ?? '');
    method = rm ? rm[1].toUpperCase() : 'GET';
  }
  return { method, path: firstString(m[3]) };
}

const join = (a: string, b: string) => `/${[a, b].map((x) => x.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')}`;

export function analyzeSpringSource(files: SourceFile[], opts: SpringSourceOptions): ImportReport {
  const notes: string[] = [];
  const service = slug(opts.service);
  const dbNode = slug(opts.db ?? `${service}-db`);
  const classes = new Map<string, Clazz>();
  for (const f of files) {
    if (!/\.(java|kt)$/.test(f.path)) continue;
    for (const c of parseClasses(stripComments(f.content))) classes.set(c.name, c);
  }

  const kafkaTopics = new Set<string>();
  // Feign clients: interface method → "target:METHOD /path"
  const feign = new Map<string, Map<string, string>>();
  for (const c of classes.values()) {
    const fm = /@FeignClient\s*\(([^)]*)\)/.exec(c.annotations);
    if (!fm) continue;
    const target = slug(/(?:name|value)\s*=\s*"([^"]+)"/.exec(fm[1])?.[1] ?? firstString(fm[1]) ?? c.name);
    const base = /path\s*=\s*"([^"]*)"/.exec(fm[1])?.[1] ?? '';
    const ops = new Map<string, string>();
    for (const m of c.methods) {
      const mp = mapping(m.annotations);
      if (mp) ops.set(m.name, `${target}:${mp.method} ${join(base, mp.path)}`);
    }
    feign.set(c.name, ops);
  }
  const isRepo = (type: string) => /Repository$|Dao$|Mapper$/.test(type);

  /** calls made by a method body, following beans of this code base */
  const callsOf = (clazz: Clazz, body: string, depth: number, seen: Set<string>): string[] => {
    const out: string[] = [];
    // receiver.method( — in source order
    for (const m of body.matchAll(/\b(\w+)\s*\.\s*(\w+)\s*\(/g)) {
      const [, recv, meth] = m;
      const type = clazz.fields.get(recv);
      const messaging = /^(RabbitTemplate|AmqpTemplate|RabbitOperations|KafkaTemplate|StreamBridge)$/.test(type ?? '') || /^(rabbitTemplate|amqpTemplate|kafkaTemplate|streamBridge)$/.test(recv);
      if (messaging && /^(convertAndSend|send)$/.test(meth)) {
        const dest = /\(\s*"([^"]+)"/.exec(body.slice(m.index! + m[0].length - 1))?.[1] ?? 'events';
        out.push(`${slug(dest)}:publish`);
        if (/kafka|stream/i.test(type ?? recv)) kafkaTopics.add(slug(dest));
        continue;
      }
      if (!type) continue;
      const f = feign.get(type);
      if (f?.has(meth)) {
        out.push(f.get(meth)!);
        continue;
      }
      if (isRepo(type)) {
        out.push(`${dbNode}:${type.replace(/Repository$|Dao$|Mapper$/, '')}.${meth}`);
        continue;
      }
      if (/RedisTemplate|ValueOperations|Cache/.test(type)) {
        out.push(`redis:${meth.toUpperCase()} ${recv}`);
        continue;
      }
      const target = classes.get(type);
      const key = `${type}.${meth}`;
      if (target && depth < 4 && !seen.has(key)) {
        const tm = target.methods.find((x) => x.name === meth);
        if (tm) out.push(...callsOf(target, tm.body, depth + 1, new Set([...seen, key])));
      }
    }
    // literal HTTP URLs: restClient.get().uri("http://payment/payments/{id}") / webClient / restTemplate.getForObject("http://...")
    for (const m of body.matchAll(/"https?:\/\/([\w.-]+)(?::\d+)?(\/[^"]*)?"/g)) {
      const before = body.slice(Math.max(0, m.index! - 120), m.index!);
      const method = /\.(get|post|put|patch|delete)\s*\(/i.exec(before)?.[1] ?? /(get|post|put|patch|delete)For/i.exec(before)?.[1] ?? 'GET';
      out.push(`${slug(m[1])}:${method.toUpperCase()} ${(m[2] ?? '/').split('?')[0]}`);
    }
    return out;
  };

  const endpoints: Record<string, any> = {};
  const nodes: Record<string, any> = { [service]: { kind: 'service', endpoints } };
  const schedules: any[] = [];
  const queues: Record<string, any> = {};
  let apis = 0;
  for (const c of classes.values()) {
    if (feign.has(c.name)) continue;
    const controller = /@(Rest)?Controller\b/.test(c.annotations);
    const base = controller ? mapping(c.annotations)?.path ?? '' : '';
    for (const m of c.methods) {
      let name: string | null = null;
      if (controller) {
        const mp = mapping(m.annotations);
        if (mp) {
          name = `${mp.method} ${join(base, mp.path)}`;
          apis++;
        }
      }
      const rl = /@(Rabbit|Kafka)Listener\s*\(([^)]*)\)/.exec(m.annotations);
      if (rl) {
        const dest = /(?:queues|topics)\s*=\s*\{?\s*"([^"]+)"/.exec(rl[2])?.[1] ?? m.name;
        name = `@${rl[1]}Listener ${m.name}`;
        queues[slug(dest)] = {
          kind: 'queue',
          ...(rl[1] === 'Kafka' ? { broker: 'kafka', kafka: { partitions: 6 } } : {}),
          consumer: { service, endpoint: name },
        };
      }
      const sc = /@Scheduled\s*\(([^)]*)\)/.exec(m.annotations);
      if (sc) {
        name = `@Scheduled ${c.name}.${m.name}`;
        const rate = /fixed(?:Rate|Delay)\s*=\s*(\d+)/.exec(sc[1])?.[1];
        const rateStr = /fixed(?:Rate|Delay)String\s*=\s*"([^"]+)"/.exec(sc[1])?.[1];
        schedules.push({ endpoint: `${service}:${name}`, every: rate ? `${rate}ms` : rateStr && /^\d/.test(rateStr) ? rateStr : '60s' });
        if (/cron/.test(sc[1])) notes.push(`${name}: cron 표현식은 60초 주기로 가정했습니다.`);
      }
      if (!name) continue;
      const calls = callsOf(c, m.body, 0, new Set([`${c.name}.${m.name}`]));
      endpoints[name] = { observed: false, source: 'spring-source', selfTime: { p50: '5ms', p99: '25ms' }, calls: dedupeRuns(calls) };
      for (const call of calls) {
        const target = call.slice(0, call.indexOf(':'));
        if (target === dbNode) nodes[dbNode] ??= { kind: 'db' };
        else if (target === 'redis') nodes.redis ??= { kind: 'cache' };
        else if (!queues[target] && call.endsWith(':publish'))
          queues[target] = kafkaTopics.has(target) ? { kind: 'queue', broker: 'kafka', kafka: { partitions: 6 } } : { kind: 'queue' };
      }
    }
  }
  Object.assign(nodes, queues);
  notes.push(`소스 ${files.length}개에서 API ${apis}개, 리스너 ${Object.values(queues).filter((q: any) => q.consumer).length}개, 스케줄 ${schedules.length}개를 찾았습니다.`);
  notes.push('정적 분석은 동적 라우팅·리플렉션 호출을 놓칠 수 있습니다. 트레이스로 보완하세요. 모든 API는 처리 시간이 추정값("미관측")입니다.');
  const doc: any = { nodes };
  if (schedules.length) doc.scenario = { schedules };
  return { doc, notes };
}

/** "db:find", "db:find", "db:find" → "db:find x 3" */
function dedupeRuns(calls: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < calls.length; ) {
    let j = i;
    while (j < calls.length && calls[j] === calls[i]) j++;
    out.push(j - i > 1 ? `${calls[i]} x ${j - i}` : calls[i]);
    i = j;
  }
  return out;
}
