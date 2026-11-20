export async function pollDueMarkets({store, network, contract, count, process, now = () => Math.floor(Date.now()/1000), batchSize = 25, onError = () => {}}) {
  for (let market = 0; market < count; market++) store.ensureJob(network, contract, market, now());
  const due = store.dueJobs(network, contract, now(), batchSize);
  for (const job of due) {
    let marketInfo;
    try {
      const result = await process(job.market, info => {
        marketInfo = info;
        store.setWindow(network, contract, job.market, {...info, now:now()});
        if (info.status >= 2) store.completeJob(network, contract, job.market);
      });
      if (marketInfo?.status >= 2 || result === 'settled' || result === 'failed' || result === 'expired') {
        store.completeJob(network, contract, job.market, result === 'expired' ? 'expired' : 'complete');
      } else if (result === 'skipped' && marketInfo && now() < marketInfo.closesAt) {
        // setWindow has scheduled it exactly at close.
      } else {
        // Pending/unknown results are polled with backoff; processMarket reconciles W14 first.
        store.defer(network, contract, job.market, {now:now(), error:result === 'unknown' ? 'transaction status unknown' : result === 'pending' ? 'transaction pending' : ''});
      }
    } catch (error) {
      if (marketInfo?.status >= 2 || (marketInfo && now() > marketInfo.deadline)) {
        store.completeJob(network, contract, job.market, marketInfo.status >= 2 ? 'complete' : 'expired');
      } else {
        store.defer(network, contract, job.market, {now:now(), error:error?.message || 'market processing failed'});
      }
      onError(job.market, error);
    }
  }
  return due.map(job => job.market);
}
