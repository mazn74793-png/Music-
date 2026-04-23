import { openDB, IDBPDatabase } from 'idb';

export interface Song {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
  audioBlob?: Blob;
  type: 'online' | 'offline' | 'local';
  dateAdded: number;
}

const DATABASE_NAME = 'mystreamer-db';
const STORE_NAME = 'songs';

export async function initDB(): Promise<IDBPDatabase> {
  return openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    },
  });
}

export async function saveSong(song: Song) {
  const db = await initDB();
  return db.put(STORE_NAME, song);
}

export async function getAllSongs(): Promise<Song[]> {
  const db = await initDB();
  return db.getAll(STORE_NAME);
}

export async function deleteSong(id: string) {
  const db = await initDB();
  return db.delete(STORE_NAME, id);
}

export async function getSong(id: string): Promise<Song | undefined> {
  const db = await initDB();
  return db.get(STORE_NAME, id);
}
