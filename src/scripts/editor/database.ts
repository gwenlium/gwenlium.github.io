/** One IndexedDB database for the owner editor: private drafts and the saved sign-in. */
let database: Promise<IDBDatabase> | undefined;

export function editorDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  database = promise;
  try {
    const request = indexedDB.open('gwenlium-site-editor', 2);
    let failed = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth', { keyPath: 'key' });
    };
    request.onerror = () => { failed = true; reject(request.error ?? new Error('Browser storage could not be opened.')); };
    request.onblocked = () => { failed = true; reject(new Error('Close other tabs of this website, then reload.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  } catch (error) { reject(error); }
  void promise.catch(() => { if (database === promise) database = undefined; });
  return promise;
}

export async function readRecord<T>(store: string, key: string): Promise<T | undefined> {
  const db = await editorDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
  const transaction = db.transaction(store, 'readonly');
  const request = transaction.objectStore(store).get(key);
  transaction.oncomplete = () => resolve(request.result as T | undefined);
  transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage could not be read.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage read was interrupted.'));
  return promise;
}

export async function writeRecord(store: string, value: { key: string } | undefined, key?: string): Promise<void> {
  const db = await editorDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = db.transaction(store, 'readwrite');
  if (value) transaction.objectStore(store).put(value);
  else transaction.objectStore(store).delete(key!);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage could not be saved.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage save was interrupted.'));
  return promise;
}

/** Write (or delete) a record only if its saved revision still matches: two tabs never overwrite each other. */
export async function writeIfRevision(store: string, key: string, expected: number, value: ({ key: string; revision: number }) | undefined): Promise<void> {
  const db = await editorDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = db.transaction(store, 'readwrite');
  const objects = transaction.objectStore(store);
  const request = objects.get(key);
  let conflict: Error | undefined;
  request.onsuccess = () => {
    if ((request.result?.revision ?? 0) !== expected) {
      conflict = new Error('Another tab changed your drafts. Reload this page to continue from the latest version.');
      transaction.abort();
      return;
    }
    if (value) objects.put(value);
    else objects.delete(key);
  };
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(conflict ?? transaction.error ?? new Error('Browser storage could not be saved.'));
  transaction.onabort = () => reject(conflict ?? transaction.error ?? new Error('Browser storage save was interrupted.'));
  return promise;
}
