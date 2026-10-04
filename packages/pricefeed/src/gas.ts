import { ceilDiv } from './math.js';

export type GasSizing={estimatedGas:bigint;gasLimit:bigint;marginBps:bigint};
/** Integer-only, upward-rounded diagnostic margin. A ceiling breach never clamps. */
export function sizeGas(estimatedGas:bigint|void,gasCap:bigint,marginBps:bigint):GasSizing {
  if(typeof estimatedGas!=='bigint'||estimatedGas<21000n)throw new Error('MONAD_GAS_ESTIMATE_REQUIRED');
  if(marginBps<100n||marginBps>5000n)throw new Error('BAD_GAS_SAFETY_MARGIN');
  const gasLimit=ceilDiv(estimatedGas*(10000n+marginBps),10000n);
  if(gasLimit>gasCap)throw new Error('MONAD_GAS_CAP_EXCEEDED');
  return {estimatedGas,gasLimit,marginBps};
}
