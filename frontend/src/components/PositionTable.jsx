import {useState} from 'react';
import {formatAmount} from '../../../shared/amount.mjs';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

function compareRows(a, b, sort) {
  if (sort === 'largest') {
    const first = BigInt(a.position.amount);
    const second = BigInt(b.position.amount);
    return first === second ? 0 : first > second ? -1 : 1;
  }
  if (sort === 'closing') return Number(a.market.closes_at) - Number(b.market.closes_at);
  return b.market.id - a.market.id;
}

export default function PositionTable({rows, busy, onClaim, onRequest, limit}) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent');
  const displayed = rows.filter(row => filter === 'open' ? row.market.status < 2 && !row.timedOut : filter === 'claimable' ? row.claimable : filter === 'settled' ? row.market.status >= 2 || row.timedOut : true).sort((a, b) => compareRows(a, b, sort)).slice(0, limit || rows.length);
  return <>
    <div className="table-toolbar"><label className="select-control">Position filter<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All positions</option><option value="open">Open</option><option value="claimable">Ready to claim</option><option value="settled">Settled or refundable</option></select></label><label className="select-control">Sort positions<select value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Most recent</option><option value="largest">Largest stake</option><option value="closing">Closing soon</option></select></label></div>
    <div className="table-scroll"><table className="positions-table"><thead><tr><th>Market</th><th>Position</th><th>Stake</th><th>Closes</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {displayed.map(({market, position, claimable, timedOut, statusLabel}) => <tr key={market.id}><td><div className="market-cell"><span className="market-kind">{market.kind === 'Price' ? market.asset : 'EV'}</span><div><strong>{market.question}</strong><small>Market #{market.id}</small></div></div></td><td><span className={`side-pill side-${position.side === 0 ? 'yes' : 'no'}`}>{position.side === 0 ? 'YES' : 'NO'}</span></td><td className="amount-cell">{formatAmount(position.amount)} <small>XLM</small></td><td>{new Date(Number(market.closes_at) * 1000).toLocaleDateString()}</td><td><span className={`status-pill${claimable ? ' status-ready' : ''}`}>{timedOut ? 'Refundable' : statusLabel}</span></td><td className="action-cell">{claimable ? <button className="button button-small button-primary" disabled={busy} onClick={() => onClaim(market.id)}>Claim</button> : market.status === 0 && Number(market.closes_at) <= Math.floor(Date.now() / 1000) && !timedOut ? <button className="button button-small button-secondary" disabled={busy} onClick={() => onRequest(market.id)}>Request</button> : <span className="no-action">—</span>}</td></tr>)}
    </tbody></table>{!displayed.length && <div className="empty-state"><span className="empty-icon"><PhosphorIcon name="chart" size={20} /></span><strong>No positions to show</strong><p>Connect Freighter and take a position in a market to see it here.</p></div>}</div>
  </>;
}