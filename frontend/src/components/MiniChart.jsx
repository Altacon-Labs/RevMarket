import {useId} from 'react';

const money = value => `$${Number(value).toLocaleString(undefined, {minimumFractionDigits: value < 1 ? 3 : 0, maximumFractionDigits: value < 1 ? 5 : 2})}`;

export default function MiniChart({candles, asset, source, granularity, periodLabel}) {
  const reactId = useId();
  const gradientId = `price-chart-${reactId.replace(/[^a-z0-9]/gi, '')}`;
  const width = 960;
  const height = 300;
  const plot = {left: 72, right: 20, top: 20, bottom: 42};
  const values = candles.map(candle => candle.close);
  const padding = (Math.max(...values) - Math.min(...values)) * .12 || Math.max(values[0] * .01, .01);
  const minimum = Math.min(...values) - padding;
  const maximum = Math.max(...values) + padding;
  const spread = maximum - minimum || 1;
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const points = candles.map((candle, index) => ({
    x: plot.left + index * plotWidth / Math.max(candles.length - 1, 1),
    y: plot.top + (maximum - candle.close) / spread * plotHeight,
    time: candle.time,
  }));
  const line = points.map(({x, y}, index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const area = `${line} L ${points.at(-1).x} ${height - plot.bottom} L ${points[0].x} ${height - plot.bottom} Z`;
  const last = candles.at(-1);
  const first = candles[0];
  const change = (last.close - first.close) / first.close * 100;
  const intervalLabel = granularity < 3600 ? `${granularity / 60}m` : `${granularity / 3600}h`;
  const dateLabel = timestamp => new Date(timestamp).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
  const ticks = Array.from({length: 5}, (_, index) => maximum - spread * index / 4);
  const timeTicks = [0, Math.floor((candles.length - 1) / 3), Math.floor((candles.length - 1) * 2 / 3), candles.length - 1];

  return <div className="price-chart">
    <div className="price-chart-heading"><div><span className="price-chart-symbol">{asset}/USD</span><strong>{money(last.close)}</strong><span className={change >= 0 ? 'price-chart-change is-up' : 'price-chart-change is-down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span></div><span className="price-chart-source">{source} · {intervalLabel} candles · {periodLabel}</span></div>
    <svg className="price-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${asset} USD ${intervalLabel} candlestick close chart from ${source}`} preserveAspectRatio="none">
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={change >= 0 ? '#31d39a' : '#f06b77'} stopOpacity=".3" /><stop offset="100%" stopColor="#111416" stopOpacity="0" /></linearGradient></defs>
      {ticks.map((tick, index) => {
        const y = plot.top + index * plotHeight / 4;
        return <g key={tick}><line x1={plot.left} x2={width - plot.right} y1={y} y2={y} className="chart-grid-line" /><text x={plot.left - 12} y={y + 4} textAnchor="end" className="chart-axis-label">{money(tick)}</text></g>;
      })}
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} className={change >= 0 ? 'chart-price-line is-up' : 'chart-price-line is-down'} />
      {timeTicks.map(index => <text key={index} x={points[index].x} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="chart-axis-label">{dateLabel(points[index].time)}</text>)}
      <line x1={plot.left} x2={width - plot.right} y1={points.at(-1).y} y2={points.at(-1).y} className="chart-last-line" />
      <circle cx={points.at(-1).x} cy={points.at(-1).y} r="5" className={change >= 0 ? 'chart-last-point is-up' : 'chart-last-point is-down'} />
    </svg>
    <div className="price-chart-footnote">Hourly candles · last candle {new Date(last.time).toLocaleString()}</div>
  </div>;
}