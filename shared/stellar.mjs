import { Account, Address, Contract, Networks, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr } from '@stellar/stellar-sdk';
export { Networks };
export const sc = {
  address: value => new Address(value).toScVal(),
  u32: value => nativeToScVal(value, {type: 'u32'}),
  u64: value => nativeToScVal(BigInt(value), {type: 'u64'}),
  i128: value => nativeToScVal(BigInt(value), {type: 'i128'}),
  text: value => nativeToScVal(value, {type: 'string'}),
  hash: value => nativeToScVal(value, {type: 'bytes'}),
  kind: (asset, threshold) => xdr.ScVal.scvVec(asset
    ? [nativeToScVal('Price', {type:'symbol'}), nativeToScVal(asset, {type:'symbol'}), nativeToScVal(BigInt(threshold), {type:'i128'})]
    : [nativeToScVal('Event', {type:'symbol'})]),
};
export function normalizeMarket(m) {
  return { ...m, kind: m.kind[0], asset: m.kind[1], threshold: m.kind[2] };
}
export function createClient({rpcUrl, contractId, networkPassphrase = Networks.TESTNET, maxFee = 10_000_000n}) {
  if (networkPassphrase !== Networks.TESTNET) throw new Error('This release supports Stellar testnet only');
  if (!rpcUrl?.startsWith('https://')) throw new Error('HTTPS RPC URL required');
  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(contractId);
  const build = (source, method, args) => new TransactionBuilder(source, {fee:'10000', networkPassphrase})
    .addOperation(contract.call(method, ...args)).setTimeout(120).build();
  const inspect = async hash => {
    const receipt = await server.getTransaction(hash);
    if (receipt.status === 'SUCCESS') return {status:'confirmed', hash, value:receipt.returnValue ? scValToNative(receipt.returnValue) : null};
    if (receipt.status === 'FAILED') return {status:'failed', hash};
    if (receipt.status === 'NOT_FOUND') return {status:'unknown', hash};
    return {status:'pending', hash};
  };
  return {
    async prepare(source, sign, method, args = []) {
      const account = await server.getAccount(source);
      const tx = build(account, method, args);
      const prepared = await server.prepareTransaction(tx);
      if (BigInt(prepared.fee) > maxFee) throw new Error('Estimated transaction fee exceeds 1 XLM limit');
      const signed = await sign(prepared.toXDR(), networkPassphrase);
      const signedTx = TransactionBuilder.fromXDR(signed, networkPassphrase);
      return {hash:signedTx.hash().toString('hex'), xdr:signed, sequence:account.sequenceNumber()};
    },
    async submit(signedXdr) {
      const result = await server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, networkPassphrase));
      if (!['PENDING','DUPLICATE'].includes(result.status)) throw new Error(`Submission rejected: ${result.status}`);
      return result.hash;
    },
    inspect,
    async writePrepared(signedXdr, hash) {
      const submittedHash = await this.submit(signedXdr);
      if (submittedHash !== hash) throw new Error(`Submitted transaction hash mismatch: ${submittedHash}`);
      for (let i = 0; i < 45; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const state = await inspect(hash);
        if (state.status === 'confirmed') return state;
        if (state.status === 'failed') throw new Error(`Transaction failed: ${hash}`);
      }
      throw new Error(`Confirmation timed out; check hash before retrying: ${hash}`);
    },
    async read(source, method, args = []) {
      // Read-only simulation needs no wallet signature. RPC checks source existence.
      const tx = build(new Account(source, '0'), method, args);
      const sim = await server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`Read ${method} failed: ${sim.error || 'no result'}`);
      return scValToNative(sim.result.retval);
    },
    async write(source, sign, method, args = []) {
      const prepared = await this.prepare(source, sign, method, args);
      for (let i = 0; i < 45; i++) {
        if (i === 0) await this.submit(prepared.xdr);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const state = await inspect(prepared.hash);
        if (state.status === 'confirmed') return state;
        if (state.status === 'failed') throw new Error(`Transaction failed: ${prepared.hash}`);
      }
      throw new Error(`Confirmation timed out; check hash before retrying: ${prepared.hash}`);
    },
  };
}
