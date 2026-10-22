const apps = new Map();

export function initializeApp(options = {}, name = "[DEFAULT]") {
  const existing = apps.get(name);
  if (existing) return existing;

  const app = { name, options: { ...options }, automaticDataCollectionEnabled: false };
  apps.set(name, app);
  return app;
}

export function getApps() {
  return [...apps.values()];
}

export function getApp(name = "[DEFAULT]") {
  const app = apps.get(name);
  if (!app) throw new Error(`Firebase app "${name}" has not been initialized`);
  return app;
}
