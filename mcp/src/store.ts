/**
 * SideTrip local store — a tiny JSON-file store for the shared errand
 * list and for "already notified" trigger state (so the watcher never
 * calls twice about the same trigger).
 *
 * Location: $SIDETRIP_DATA_DIR, or ~/.sidetrip by default.
 * Nothing here ever holds a secret.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ListItem {
  id: string;
  item: string;
  store?: string;
  addedBy?: string;
  addedAt: string;
  done: boolean;
}

export interface StoreState {
  notified: Record<string, string>; // triggerId -> ISO timestamp notified
}

export function dataDir(): string {
  return (
    process.env.SIDETRIP_DATA_DIR ?? path.join(homedir(), ".sidetrip")
  );
}

function listPath(dir = dataDir()): string {
  return path.join(dir, "list.json");
}

function statePath(dir = dataDir()): string {
  return path.join(dir, "state.json");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function getList(dir = dataDir()): Promise<ListItem[]> {
  return readJson<ListItem[]>(listPath(dir), []);
}

export async function addListItem(
  item: string,
  store?: string,
  addedBy?: string,
  dir = dataDir(),
): Promise<ListItem> {
  const list = await getList(dir);
  const entry: ListItem = {
    id: `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    item,
    store,
    addedBy,
    addedAt: new Date().toISOString(),
    done: false,
  };
  list.push(entry);
  await writeJson(listPath(dir), list);
  return entry;
}

export async function markListItem(
  id: string,
  done: boolean,
  dir = dataDir(),
): Promise<ListItem | null> {
  const list = await getList(dir);
  const entry = list.find((i) => i.id === id);
  if (!entry) return null;
  entry.done = done;
  await writeJson(listPath(dir), list);
  return entry;
}

export async function removeListItem(
  id: string,
  dir = dataDir(),
): Promise<boolean> {
  const list = await getList(dir);
  const next = list.filter((i) => i.id !== id);
  if (next.length === list.length) return false;
  await writeJson(listPath(dir), next);
  return true;
}

export async function clearDoneItems(dir = dataDir()): Promise<number> {
  const list = await getList(dir);
  const remaining = list.filter((i) => !i.done);
  const cleared = list.length - remaining.length;
  await writeJson(listPath(dir), remaining);
  return cleared;
}

export async function getState(dir = dataDir()): Promise<StoreState> {
  return readJson<StoreState>(statePath(dir), { notified: {} });
}

export async function markNotified(
  triggerId: string,
  dir = dataDir(),
): Promise<void> {
  const state = await getState(dir);
  state.notified[triggerId] = new Date().toISOString();
  await writeJson(statePath(dir), state);
}

export async function wasNotified(
  triggerId: string,
  dir = dataDir(),
): Promise<boolean> {
  const state = await getState(dir);
  return triggerId in state.notified;
}
