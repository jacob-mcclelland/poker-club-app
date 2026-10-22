const storageByApp = new WeakMap();

function unsupported(method) {
  throw new Error(`Unsupported Storage method: ${method}`);
}

export function getStorage(app, bucketUrl) {
  const key = app || globalThis;
  if (!storageByApp.has(key)) storageByApp.set(key, { app, bucket: bucketUrl || app?.options?.storageBucket || null });
  return storageByApp.get(key);
}

export function ref(storageOrReference, path = "") {
  if (storageOrReference?.storage) {
    return { storage: storageOrReference.storage, fullPath: [storageOrReference.fullPath, path].filter(Boolean).join("/") };
  }
  return { storage: storageOrReference, fullPath: String(path).replace(/^\/+/, "") };
}

export async function uploadBytes() {
  return unsupported("uploadBytes");
}

export async function getDownloadURL() {
  return unsupported("getDownloadURL");
}
