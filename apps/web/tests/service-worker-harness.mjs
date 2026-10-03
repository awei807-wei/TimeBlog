import fs from 'node:fs/promises';
import vm from 'node:vm';

export const origin = 'https://blog.example.test';
export const workerSource = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

/** 在内存中运行真实 worker，并等待事件生命周期内的缓存写入。 */
export function workerFixture(source = workerSource) {
  const listeners = {};
  const storage = new Map();
  const network = [];
  const actions = [];
  const key = request => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        addAll: async paths => { for (const path of paths) entries.set(key(path), new Response('预缓存')); },
        match: async request => entries.get(key(request))?.clone(),
        put: async (request, response) => { entries.set(key(request), response.clone()); },
        keys: async () => [...entries.keys()].map(url => ({ url })),
        delete: async request => entries.delete(key(request)),
      };
    },
    keys: async () => [...storage.keys()],
    delete: async name => storage.delete(name),
    async match(request) {
      for (const entries of storage.values()) if (entries.has(key(request))) return entries.get(key(request)).clone();
    },
  };
  const scope = {
    self: {
      location: { origin }, addEventListener: (name, listener) => { listeners[name] = listener; },
      skipWaiting: async () => { actions.push('skipWaiting'); },
      registration: { unregister: async () => { actions.push('unregister'); return true; } },
      clients: { claim: async () => { actions.push('claim'); }, matchAll: async () => [] },
    },
    caches, URL, Response, Promise,
    fetch: async request => { network.push(key(request)); return fixture.respond(request); },
  };
  vm.runInNewContext(source, scope);
  const fixture = {
    caches, storage, network, actions, scope,
    respond: () => new Response('网络内容'),
    async dispatch(type, data = {}) {
      const pending = [];
      let response;
      listeners[type]({ ...data, waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
      const result = await response;
      while (pending.length) await Promise.all(pending.splice(0));
      return result;
    },
    fetch(path, options = {}) {
      return fixture.dispatch('fetch', { request: {
        url: new URL(path, origin).href, method: 'GET', mode: 'cors', destination: '', headers: new Headers(), ...options,
      } });
    },
  };
  return fixture;
}
