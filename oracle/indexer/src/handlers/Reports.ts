// KeystoneForwarder reports to this oracle → ReportAttempt; the testnet sandbox DVM → SandboxRequest.
import { indexer } from 'envio'
import { OWN } from '../addresses'
import { lc, logId, ts } from '../lib'

indexer.onEvent(
  {
    contract: 'KeystoneForwarder',
    event: 'ReportProcessed',
    where: ({ chain }) => {
      const oracle = OWN[chain.id]?.oracle
      return oracle ? { params: { receiver: oracle } } : false
    },
  },
  async ({ event, context }) => {
    const p = event.params
    if (lc(p.receiver) !== lc(OWN[event.chainId]?.oracle ?? '')) return // test simulations bypass `where`
    context.ReportAttempt.set({
      id: logId(event), forwarder: event.srcAddress, receiver: p.receiver, workflowExecutionId: p.workflowExecutionId, reportId: p.reportId,
      result: p.result, relayer: event.transaction.from, block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash,
    })
  },
)

indexer.onEvent({ contract: 'ErosSandboxOracle', event: 'PriceRequested' }, async ({ event, context }) => {
  const p = event.params
  context.SandboxRequest.set({ id: lc(p.requestId), identifier: p.identifier, time: p.time, ancillaryData: p.ancillaryData, requestedAt: ts(event), price: undefined, pushedAt: undefined })
})

indexer.onEvent({ contract: 'ErosSandboxOracle', event: 'PricePushed' }, async ({ event, context }) => {
  const r = await context.SandboxRequest.get(lc(event.params.requestId))
  if (r) context.SandboxRequest.set({ ...r, price: event.params.price, pushedAt: ts(event) })
})
