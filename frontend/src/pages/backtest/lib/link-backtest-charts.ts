import {
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type IRange,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { chartTime } from '@/shared/lib/price-chart';
import { linkedCrosshair } from './linked-crosshair';

type Range = IRange<number>;
type Endpoint = {
  scale: ReturnType<IChartApi['timeScale']>;
  guide: ReturnType<typeof linkedCrosshair>;
  requestedRange?: Range;
};

function sameRange(a: Range, b: Range) {
  return Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;
}

export type BacktestChartLink = ReturnType<typeof linkBacktestCharts>;

export function linkBacktestCharts(equity: readonly { time: number }[], candles: typeof equity) {
  const times = Array.from(
    new Set([
      ...equity.map(({ time }) => chartTime(time)),
      ...candles.map(({ time }) => chartTime(time)),
    ]),
  ).sort((a, b) => a - b);
  // The hidden series adds time slots without changing the visible series or their scales.
  // Its last point anchors both charts' scroll limits at the same index.
  const timeline = times.map((time, index) =>
    index === times.length - 1 ? { time, value: 0 } : { time },
  );
  const endpoints = new Set<Endpoint>();
  let range: Range = { from: 0, to: Math.max(0, timeline.length - 1) };
  let hovered: Endpoint | undefined;

  function requestRange(endpoint: Endpoint, next: Range) {
    const current = endpoint.requestedRange ?? endpoint.scale.getVisibleLogicalRange();
    if (current && sameRange(current, next)) return;
    endpoint.requestedRange = next;
    endpoint.scale.setVisibleLogicalRange(next);
  }

  return {
    connect(chart: IChartApi, series: Pick<ISeriesApi<SeriesType>, 'attachPrimitive'>) {
      chart.applyOptions({
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { minimumWidth: 96 },
        timeScale: { lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.0001 },
      });
      const axis = chart.addSeries(LineSeries, { visible: false, priceScaleId: 'timeline' });
      axis.setData(timeline);
      const scale = chart.timeScale();
      const guide = linkedCrosshair(chart);
      series.attachPrimitive(guide.primitive);
      const endpoint: Endpoint = { scale, guide };
      endpoints.add(endpoint);
      if (timeline.length) requestRange(endpoint, range);

      const syncRange = (next: LogicalRange | null) => {
        if (!next) return;
        const requested = endpoint.requestedRange;
        endpoint.requestedRange = undefined;
        // Range writes are applied on a later chart frame, so a synchronous guard wouldn't work.
        if (requested && sameRange(requested, next)) return;
        range = next;
        for (const peer of endpoints) {
          if (peer !== endpoint) requestRange(peer, next);
        }
      };
      const syncHover = ({ point, time, sourceEvent }: MouseEventParams<Time>) => {
        if (sourceEvent && point) hovered = endpoint;
        if (hovered !== endpoint) return;
        if (!point) hovered = undefined;
        for (const peer of endpoints) {
          peer.guide.setTime(peer === endpoint || !point ? undefined : time);
        }
      };
      scale.subscribeVisibleLogicalRangeChange(syncRange);
      chart.subscribeCrosshairMove(syncHover);
      return () => {
        endpoints.delete(endpoint);
        if (hovered === endpoint) {
          hovered = undefined;
          for (const peer of endpoints) peer.guide.setTime(undefined);
        }
        scale.unsubscribeVisibleLogicalRangeChange(syncRange);
        chart.unsubscribeCrosshairMove(syncHover);
      };
    },
  };
}
