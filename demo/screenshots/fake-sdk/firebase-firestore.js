const firestoreByApp = new WeakMap();
let fixtureStorePromise;
let generatedId = 0;

// Fixture compatibility for timerClocks generated with structure: "standard".
// The browser app reads the published shape { id, levels }; these levels are
// copied from public/clock-structures.js, STRUCTURES.standard.levels.
const STANDARD_CLOCK_LEVELS = [
  { level: 0, name: "Draw for Seats", duration: 5, small: 0, big: 0, isBreak: false, isPreGame: true, display: "Next: Announcements" },
  { level: 0, name: "Announcements", duration: 5, small: 0, big: 0, isBreak: false, isPreGame: true, display: "Next: 25 / 50" },
  { level: 1, name: "Round 1", duration: 12, small: 25, big: 50, isBreak: false },
  { level: 2, name: "Round 2", duration: 12, small: 50, big: 100, isBreak: false },
  { level: "B1", name: "Break", duration: 8, small: 0, big: 0, isBreak: true },
  { level: 3, name: "Round 3", duration: 12, small: 100, big: 200, isBreak: false },
  { level: 4, name: "Round 4", duration: 12, small: 200, big: 400, isBreak: false },
  { level: "B2", name: "Break & Chip Up", duration: 10, small: 0, big: 0, isBreak: true, chipUp: "Red, White & Blue into stacks of 500" },
  { level: 5, name: "Round 5", duration: 12, small: 500, big: 1000, isBreak: false },
  { level: 6, name: "Round 6", duration: 12, small: 1000, big: 2000, isBreak: false },
  { level: 7, name: "Round 7", duration: 12, small: 2000, big: 4000, isBreak: false },
  { level: "B3", name: "Quick Chip-up", duration: 3, small: 0, big: 0, isBreak: true, chipUp: "Convert to 5K chips" },
  { level: 8, name: "Round 8", duration: 12, small: 5000, big: 10000, isBreak: false, displayChips: "1/2" },
  { level: 9, name: "Round 9", duration: 12, small: 10000, big: 20000, isBreak: false, displayChips: "2/4" },
  { level: 10, name: "Round 10", duration: 12, small: 20000, big: 40000, isBreak: false, displayChips: "4/8" },
  { level: 11, name: "Round 11", duration: 12, small: 40000, big: 80000, isBreak: false, displayChips: "8/16" },
  { level: 12, name: "Round 12", duration: 12, small: 80000, big: 160000, isBreak: false, displayChips: "16/32" },
  { level: 13, name: "Round 13", duration: 12, small: 160000, big: 320000, isBreak: false, displayChips: "32/64" }
];

export class DemoTimestamp {
  constructor(date = new Date()) {
    const milliseconds = date instanceof Date ? date.getTime() : new Date(date).getTime();
    this.seconds = Math.floor(milliseconds / 1000);
    this.nanoseconds = (milliseconds - this.seconds * 1000) * 1_000_000;
  }

  toDate() {
    return new Date(this.toMillis());
  }

  toMillis() {
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }

  valueOf() {
    return this.toMillis();
  }

  isEqual(other) {
    return other instanceof DemoTimestamp && this.toMillis() === other.toMillis();
  }
}

function unsupported(method) {
  throw new Error(`Unsupported Firestore method: ${method}`);
}

function makeId() {
  generatedId += 1;
  return `demo-${Date.now().toString(36)}-${generatedId.toString(36)}`;
}

function splitPath(value) {
  return String(value || "").split("/").filter(Boolean);
}

function getPathValue(object, path) {
  return String(path).split(".").reduce((value, key) => value == null ? undefined : value[key], object);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function convertTimestamps(value) {
  if (isIsoTimestamp(value)) return new DemoTimestamp(new Date(value));
  if (Array.isArray(value)) return value.map(convertTimestamps);
  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof DemoTimestamp)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convertTimestamps(item)]));
  }
  return value;
}

async function fixtureStore() {
  if (!fixtureStorePromise) {
    fixtureStorePromise = fetch("/__demo/fixtures").then(async response => {
      if (!response.ok) throw new Error(`Could not load demo fixtures (${response.status})`);
      const payload = await response.json();
      const collections = payload?.fixtures || payload?.collections || payload;
      if (!collections || typeof collections !== "object") throw new Error("Demo fixtures response must be an object of collections");
      return Object.fromEntries(Object.entries(collections).map(([name, docs]) => [
        name,
        docs && typeof docs === "object" ? { ...docs } : {}
      ]));
    });
  }
  return fixtureStorePromise;
}

function fieldValueSentinel(value) {
  return value && typeof value === "object" && value.__demoFieldValue;
}

function resolveWriteValue(value, previous) {
  const sentinel = fieldValueSentinel(value);
  if (sentinel === "serverTimestamp") return new Date().toISOString();
  if (sentinel === "increment") return (typeof previous === "number" ? previous : 0) + Number(value.operand || 0);
  if (Array.isArray(value)) return value.map((item, index) => resolveWriteValue(item, previous?.[index]));
  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof DemoTimestamp)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveWriteValue(item, previous?.[key]);
    return result;
  }
  if (value instanceof DemoTimestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function deepMerge(target, incoming) {
  const result = { ...target };
  for (const [key, value] of Object.entries(incoming)) {
    const old = target[key];
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !fieldValueSentinel(value) && old && typeof old === "object" && !Array.isArray(old)) {
      result[key] = deepMerge(old, value);
    } else {
      result[key] = resolveWriteValue(value, old);
    }
  }
  return result;
}

function collectionName(reference) {
  if (!reference || reference.type !== "collection") unsupported("collection reference");
  return reference.path;
}

function docLocation(reference) {
  if (!reference || reference.type !== "document") unsupported("document reference");
  return { collection: reference.collectionPath, id: reference.id };
}

function makeDocumentSnapshot(reference, record) {
  const exists = record !== undefined;
  const materialize = () => {
    if (!exists) return undefined;
    const data = convertTimestamps(record);
    if (reference.collectionPath === "timerClocks" && data.structure === "standard") {
      data.structure = { id: "standard", levels: STANDARD_CLOCK_LEVELS.map(level => ({ ...level })) };
    }
    return data;
  };
  return {
    id: reference.id,
    ref: reference,
    metadata: { hasPendingWrites: false, fromCache: false },
    exists: () => exists,
    data: materialize,
    get: field => exists ? convertTimestamps(getPathValue(materialize(), field)) : undefined
  };
}

function comparable(value) {
  if (value instanceof DemoTimestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (isIsoTimestamp(value)) return Date.parse(value);
  return value;
}

function equal(left, right) {
  const a = comparable(left), b = comparable(right);
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function matchesWhere(record, constraint) {
  const actual = getPathValue(record, constraint.field);
  const expected = constraint.value;
  switch (constraint.op) {
    case "==": return equal(actual, expected);
    case "!=": return !equal(actual, expected);
    case "<": return comparable(actual) < comparable(expected);
    case "<=": return comparable(actual) <= comparable(expected);
    case ">": return comparable(actual) > comparable(expected);
    case ">=": return comparable(actual) >= comparable(expected);
    case "array-contains": return Array.isArray(actual) && actual.some(item => equal(item, expected));
    case "array-contains-any": return Array.isArray(actual) && Array.isArray(expected) && actual.some(item => expected.some(candidate => equal(item, candidate)));
    case "in": return Array.isArray(expected) && expected.some(candidate => equal(actual, candidate));
    case "not-in": return Array.isArray(expected) && !expected.some(candidate => equal(actual, candidate));
    default: return unsupported(`where(${constraint.op})`);
  }
}

async function recordsFor(queryRef) {
  const store = await fixtureStore();
  const path = collectionName(queryRef.collection || queryRef);
  const collection = store[path] || {};
  let entries = Object.entries(collection);

  for (const constraint of queryRef.constraints || []) {
    if (constraint.kind === "where") entries = entries.filter(([, record]) => matchesWhere(record, constraint));
  }

  const orderings = (queryRef.constraints || []).filter(item => item.kind === "orderBy");
  if (orderings.length) {
    entries.sort(([, left], [, right]) => {
      for (const ordering of orderings) {
        const a = comparable(getPathValue(left, ordering.field));
        const b = comparable(getPathValue(right, ordering.field));
        if (a === b) continue;
        if (a === undefined) return ordering.direction === "desc" ? 1 : -1;
        if (b === undefined) return ordering.direction === "desc" ? -1 : 1;
        const result = a < b ? -1 : 1;
        return ordering.direction === "desc" ? -result : result;
      }
      return 0;
    });
  }

  const countLimit = (queryRef.constraints || []).find(item => item.kind === "limit");
  if (countLimit) entries = entries.slice(0, Math.max(0, countLimit.count));
  return entries;
}

function makeQuerySnapshot(queryRef, entries) {
  const docs = entries.map(([id, record]) => makeDocumentSnapshot(
    { type: "document", db: queryRef.db, collectionPath: queryRef.collection.path, path: `${queryRef.collection.path}/${id}`, id },
    record
  ));
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    metadata: { fromCache: false, hasPendingWrites: false },
    forEach(callback) { docs.forEach(callback); }
  };
}

export function getFirestore(app) {
  const key = app || globalThis;
  if (!firestoreByApp.has(key)) firestoreByApp.set(key, { app, type: "demo-firestore" });
  return firestoreByApp.get(key);
}

export function collection(parent, ...segments) {
  let db = parent?.type === "collection" || parent?.type === "document" ? parent.db : parent;
  const pathParts = parent?.path ? splitPath(parent.path) : [];
  pathParts.push(...segments.flatMap(splitPath));
  if (pathParts.length === 0) unsupported("collection(path)");
  return { type: "collection", db, path: pathParts.join("/") };
}

export function doc(parent, ...segments) {
  const parentPath = parent?.path ? splitPath(parent.path) : [];
  const parts = [...parentPath, ...segments.flatMap(splitPath)];
  if (parts.length === 0) unsupported("doc(path)");
  if (parts.length === parentPath.length && parent?.type === "collection") parts.push(makeId());
  if (parts.length < 2) unsupported("doc(collection, id)");
  const id = parts.pop();
  const collectionPath = parts.join("/");
  const db = parent?.db || parent;
  return { type: "document", db, collectionPath, id, path: `${collectionPath}/${id}` };
}

export function where(field, op, value) {
  return { kind: "where", field, op, value };
}

export function orderBy(field, direction = "asc") {
  if (direction !== "asc" && direction !== "desc") unsupported(`orderBy direction ${direction}`);
  return { kind: "orderBy", field, direction };
}

export function limit(count) {
  return { kind: "limit", count: Number(count) };
}

export function query(reference, ...constraints) {
  if (reference?.type !== "collection" && reference?.type !== "query") unsupported("query(reference)");
  const collectionRef = reference.type === "query" ? reference.collection : reference;
  return {
    type: "query",
    db: reference.db || collectionRef.db,
    collection: collectionRef,
    constraints: [...(reference.constraints || []), ...constraints]
  };
}

export async function getDocs(reference) {
  const queryRef = reference?.type === "query" ? reference : query(reference);
  return makeQuerySnapshot(queryRef, await recordsFor(queryRef));
}

export async function getDoc(reference) {
  const location = docLocation(reference);
  const store = await fixtureStore();
  return makeDocumentSnapshot(reference, store[location.collection]?.[location.id]);
}

export function onSnapshot(reference, optionsOrCallback, callbackOrError, errorCallback) {
  let active = true;
  let callback;
  let onError;
  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    onError = callbackOrError;
  } else if (typeof optionsOrCallback?.next === "function") {
    callback = optionsOrCallback.next.bind(optionsOrCallback);
    onError = optionsOrCallback.error?.bind(optionsOrCallback);
  } else if (typeof callbackOrError === "function") {
    callback = callbackOrError;
    onError = errorCallback;
  } else if (typeof callbackOrError?.next === "function") {
    callback = callbackOrError.next.bind(callbackOrError);
    onError = errorCallback || callbackOrError.error?.bind(callbackOrError);
  }
  const read = reference?.type === "document" ? getDoc(reference) : getDocs(reference);
  read.then(snapshot => {
    if (active && callback) callback(snapshot);
  }).catch(error => {
    if (active && onError) onError(error);
    else if (active) console.error("Demo Firestore onSnapshot failed:", error);
  });
  return () => { active = false; };
}

export function serverTimestamp() {
  return { __demoFieldValue: "serverTimestamp" };
}

export function increment(operand) {
  return { __demoFieldValue: "increment", operand };
}

export async function setDoc(reference, data, options = {}) {
  const { collection: path, id } = docLocation(reference);
  const store = await fixtureStore();
  store[path] ||= {};
  const prior = store[path][id];
  store[path][id] = options.merge && prior
    ? deepMerge(prior, data)
    : resolveWriteValue(data, prior);
}

export async function addDoc(reference, data) {
  const target = doc(reference);
  await setDoc(target, data);
  return target;
}

export async function updateDoc(reference, data) {
  const { collection: path, id } = docLocation(reference);
  const store = await fixtureStore();
  const prior = store[path]?.[id];
  if (!prior) throw new Error(`Document does not exist: ${path}/${id}`);
  store[path][id] = deepMerge(prior, data);
}

export async function deleteDoc(reference) {
  const { collection: path, id } = docLocation(reference);
  const store = await fixtureStore();
  if (store[path]) delete store[path][id];
}

export function runTransaction() { return unsupported("runTransaction"); }
export function writeBatch() { return unsupported("writeBatch"); }
