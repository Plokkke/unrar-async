import type { UnrarModule } from './unrar';
import unrarFactory from './unrar';

let unrar: UnrarModule;
export async function getUnrar(options?: { wasmBinary?: ArrayBuffer }): Promise<UnrarModule> {
  return (unrar ??= await unrarFactory(options));
}
