import { promises as fs } from 'fs';
import path from 'path';
import { isPubKey } from './auth.js';

const COLLECTIONS = ['status', 'delegates'];

export const createStore = (baseDir) => {
  const fileFor = (collection, key) => {
    if(!COLLECTIONS.includes(collection) || !isPubKey(key)) {
      throw new Error('invalid store key');
    }
    return path.join(baseDir, collection, `${key}.json`);
  };

  return {
    get: async (collection, key) => {
      try {
        return JSON.parse(await fs.readFile(fileFor(collection, key), 'utf8'));
      } catch(err) {
        if(err.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },

    put: async (collection, key, value) => {
      const file = fileFor(collection, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file);
    },

    remove: async (collection, key) => {
      try {
        await fs.unlink(fileFor(collection, key));
      } catch(err) {
        if(err.code !== 'ENOENT') {
          throw err;
        }
      }
    },

    list: async (collection) => {
      fileFor(collection, '0'.repeat(66));
      try {
        const names = await fs.readdir(path.join(baseDir, collection));
        return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
      } catch(err) {
        if(err.code === 'ENOENT') {
          return [];
        }
        throw err;
      }
    }
  };
};
