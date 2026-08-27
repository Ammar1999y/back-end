import { acquireWriterLock } from '@/lib/sqlite/writer-lock';

const directory = process.argv[2];
if (!directory) throw new Error('writer-lock child needs a directory');

const lock = acquireWriterLock(directory);
console.log(JSON.stringify({ held: true, pid: process.pid }));

await Bun.sleep(60_000);
lock.release();
