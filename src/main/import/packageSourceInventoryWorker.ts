import { parentPort, workerData } from 'worker_threads'
import {
  inspectIsolatedPackageInWorker,
  type IsolatedPackageInspection
} from './packageSourceInventory'
import type { DatasetCatalogSource } from './sngTrainingExporter'

interface InventoryWorkerData {
  source: DatasetCatalogSource
}

async function inspect(): Promise<IsolatedPackageInspection> {
  const { source } = workerData as InventoryWorkerData
  return await inspectIsolatedPackageInWorker(source)
}

void inspect()
  .then((result) => parentPort?.postMessage({ ok: true, ...result }))
  // Deliberately omit the parser error: a package source path or entry name
  // must never cross this worker/main/renderer boundary.
  .catch(() => parentPort?.postMessage({ ok: true, outcome: 'rejected' }))
