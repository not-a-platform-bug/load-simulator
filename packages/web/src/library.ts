// Scenario library in the browser: every scenario the user opens or creates is saved automatically.
// localStorage can be unavailable (private mode, blocked storage) — the app keeps working, just without persistence.
import type { RawDoc } from '@load-simulator/engine';

export interface SavedScenario {
  id: string;
  name: string;
  /** where it came from: "demo:<id>", "import", "blank", "file", "shared" */
  origin: string;
  /** full document including layout */
  doc: RawDoc;
  updatedAt: number;
}

const KEY = 'load-simulator:library:v1';
const CURRENT = 'load-simulator:current:v1';

function read(): SavedScenario[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedScenario[]) : [];
  } catch {
    return [];
  }
}

function write(list: SavedScenario[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function listScenarios(): SavedScenario[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getScenario(id: string): SavedScenario | undefined {
  return read().find((s) => s.id === id);
}

/** returns false when the browser refused to store it */
export function saveScenario(s: SavedScenario): boolean {
  const list = read().filter((x) => x.id !== s.id);
  list.push({ ...s, updatedAt: Date.now() });
  return write(list);
}

export function deleteScenario(id: string): void {
  write(read().filter((s) => s.id !== id));
}

export function newId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function getCurrentId(): string | null {
  try {
    return localStorage.getItem(CURRENT);
  } catch {
    return null;
  }
}

export function setCurrentId(id: string): void {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    // ignore
  }
}

export function storageAvailable(): boolean {
  try {
    localStorage.setItem('load-simulator:probe', '1');
    localStorage.removeItem('load-simulator:probe');
    return true;
  } catch {
    return false;
  }
}
