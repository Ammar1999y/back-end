import { workerMain } from '../shared/worker-main.mjs';
import { driver } from './adapter.mjs';

workerMain(driver);
