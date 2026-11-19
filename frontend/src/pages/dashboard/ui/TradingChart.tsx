import { useEffect, useMemo, useRef, useState } from "react";
import { useDisplayTimeZone } from "@/shared/api";
import { displayTimeFormatter } from "@/shared/lib/display-time";
import { Button } from "@/shared/ui";
import { chartTime } from "@/shared/lib/price-chart";
import { createPriceChart } from "../lib/create-price-chart";
import type { ChartCandle } from "../model/market-data";
import { CandleDetails } from "./CandleDetails";

export default function TradingChart({
  candles,
  dark,
}: {
  candles: ChartCandle[];
  dark: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<ReturnType<typeof createPriceChart>>(null);
  const pointerInside = useRef(false);
  const [hoverTime, setHoverTime] = useState<number>();
  const timeZone = useDisplayTimeZone();
  const formatTime = useMemo(() => displayTimeFormatter(timeZone), [timeZone]);
  const hovered = candles.find(
    (candle) => chartTime(candle.time) === hoverTime,
  );
  const selected = hovered ?? candles.at(-1);

  useEffect(() => {
    if (!container.current) return;
    const chart = createPriceChart(container.current, (time) => {
      if (pointerInside.current) setHoverTime(time);
    });
    plot.current = chart;
    return () => {
      plot.current = null;
      chart.dispose();
    };
  }, []);
  useEffect(() => {
    plot.current?.setTheme();
  }, [dark]);
  useEffect(() => {
    plot.current?.setTimeZone(timeZone);
  }, [timeZone]);
  useEffect(() => {
    plot.current?.setCandles(candles);
  }, [candles]);

  return (
    <figure className="grid min-w-0 gap-2">
      <div className="min-w-0 overflow-hidden rounded-md border">
        <div
          ref={container}
          role="group"
          aria-label="График свечей"
          className="h-80 w-full sm:h-96"
          onPointerEnter={() => {
            pointerInside.current = true;
          }}
          onPointerLeave={() => {
            pointerInside.current = false;
            setHoverTime(undefined);
          }}
        />
      </div>
      {selected && (
        <CandleDetails candle={selected} hovered={Boolean(hovered)} timeLabel={formatTime(selected.time)} />
      )}
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {candles.length} св. · Время: {timeZone} · Сплошная EMA брокера, пунктир —
          предварительная
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => plot.current?.goToLatest()}
        >
          К последней свече
        </Button>
        <span className="basis-full">
          TradingView Lightweight Charts™ · Copyright (с) 2025{" "}
          <a
            className="underline underline-offset-2"
            href="https://www.tradingview.com/"
          >
            TradingView, Inc.
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
