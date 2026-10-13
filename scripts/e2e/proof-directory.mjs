/** Keep public test wallets and journals inside an explicit deployment run. */
export function isTestnetProofDirectory(directory) {
  return typeof directory === 'string'
    && /^tmp\/(?:live-markets(?:-v[2-9])?|redeploy-audit)-[0-9]{8}\/[a-z]+(?:-[a-z]+)*$/.test(directory);
}
