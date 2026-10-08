import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { revertMessage } from '../src/lib/transaction-errors.ts';

// tsx loads this package's .ts modules through CommonJS. Use the same viem
// constructor instances here so instanceof exercises the application's path.
const { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult, parseAbi } = createRequire(import.meta.url)('viem');

const vaultErrors = parseAbi(['error Unauthorized()', 'error BadUnits()', 'error Reentrant()', 'error TransferFailed()']);
const engineErrors = parseAbi(['error BadState()', 'error Coverage()', 'error Rejected()', 'error Stale()']);
const nested = error => new BaseError('Transaction could not be prepared', {
  cause: new BaseError('Contract call failed', { cause: error }),
});
const reverted = (data, abi = vaultErrors, functionName = 'allocate') =>
  new ContractFunctionRevertedError({ abi, data, functionName });

test('the verified BadState selector is decoded when bubbled through a vault call', () => {
  assert.equal(encodeErrorResult({ abi: engineErrors, errorName: 'BadState' }), '0x8523b62a');
  const error = reverted('0x8523b62a');
  assert.equal(error.data, undefined, 'the vault ABI cannot decode the engine error');
  assert.match(error.shortMessage, /0x8523b62a/);
  const message = revertMessage(nested(error), { functionName: 'allocate' });
  assert.match(message, /cannot accept collateral in its current state/);
  assert.match(message, /maintenance may be required/);
  assert.doesNotMatch(message, /0x|rollover|funds (?:lost|safe)/i);
});

test('decoded BadState uses the same explanation without asserting a specific maintenance cause', () => {
  const error = reverted('0x8523b62a', engineErrors, 'placeOrder');
  assert.equal(error.data.errorName, 'BadState');
  const message = revertMessage(nested(error));
  assert.match(message, /cannot process this action in its current state/);
  assert.match(message, /maintenance may be required/);
  assert.doesNotMatch(message, /accept collateral|rollover|0x/i);
});

test('verified vault and engine errors receive messages whether originally decoded or bubbled', () => {
  for (const [errorName, abi, expected] of [
    ['TransferFailed', vaultErrors, /collateral transfer failed/],
    ['Unauthorized', vaultErrors, /selected wallet and the market status/],
    ['BadUnits', vaultErrors, /amount or input values/],
    ['Reentrant', vaultErrors, /transaction safety check/],
    ['Coverage', engineErrors, /reserve coverage/],
    ['Rejected', engineErrors, /risk checks did not approve/],
    ['Stale', engineErrors, /state changed or is no longer current/],
  ]) {
    const data = encodeErrorResult({ abi, errorName });
    for (const suppliedAbi of [abi, []]) {
      assert.match(revertMessage(nested(reverted(data, suppliedAbi))), expected);
    }
  }
});

test('unknown and malformed selectors keep the original viem fallback', () => {
  for (const raw of ['0xdeadbeef', '0x8523b62b', '0x85', '0x']) {
    const error = reverted(raw);
    assert.equal(revertMessage(nested(error), { functionName: 'allocate' }), error.shortMessage);
  }
  const unknownAbi = parseAbi(['error FutureContractError(uint256 value)']);
  const error = reverted(encodeErrorResult({ abi: unknownAbi, errorName: 'FutureContractError', args: [7n] }), unknownAbi);
  assert.equal(revertMessage(nested(error)), 'Reverted: FutureContractError');
});

test('network failures, wallet rejection, ordinary errors and text retain their original messages', () => {
  const network = new BaseError('Unable to reach the RPC server');
  const rejection = new UserRejectedRequestError(new Error('User declined'));
  assert.equal(revertMessage(network), network.shortMessage);
  assert.equal(revertMessage(rejection), rejection.shortMessage);
  assert.equal(revertMessage(new Error('Wallet disconnected')), 'Wallet disconnected');
  assert.equal(revertMessage('No transaction was sent'), 'No transaction was sent');
  assert.equal(revertMessage(new BaseError('RPC reply mentioned 0x8523b62a')), 'RPC reply mentioned 0x8523b62a');
});
