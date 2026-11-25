import {
  type IChartApi,
  type ISeriesPrimitive,
  type ISeriesPrimitiveAxisView,
  type IPanePrimitivePaneView,
  type Time,
} from 'lightweight-charts';

export function linkedCrosshair(chart: IChartApi) {
  const scale = chart.timeScale();
  const style = chart.options().crosshair.vertLine;
  let time: Time | undefined;
  let requestUpdate: (() => void) | undefined;

  function coordinate() {
    const x = time === undefined ? null : scale.timeToCoordinate(time);
    return x !== null && x >= 0 && x < scale.width() ? x : null;
  }

  // Draw only the time guide, even if the receiving chart has no value at this time.
  const paneViews: IPanePrimitivePaneView[] = [
    {
      zOrder: () => 'top',
      renderer: () => ({
        draw: (target) => {
          const x = coordinate();
          if (x === null) return;
          target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio }) => {
            const pixel = Math.round(x * horizontalPixelRatio) + 0.5;
            context.strokeStyle = style.color;
            context.lineWidth = Math.max(1, Math.floor(horizontalPixelRatio));
            context.setLineDash([4 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
            context.beginPath();
            context.moveTo(pixel, 0);
            context.lineTo(pixel, bitmapSize.height);
            context.stroke();
          });
        },
      }),
    },
  ];
  const timeAxisViews: ISeriesPrimitiveAxisView[] = [
    {
      visible: () => coordinate() !== null,
      coordinate: () => coordinate() ?? 0,
      text: () =>
        time === undefined ? '' : (chart.options().localization.timeFormatter?.(time) ?? ''),
      textColor: () => '#fff',
      backColor: () => style.labelBackgroundColor,
    },
  ];
  const primitive: ISeriesPrimitive<Time> = {
    attached: (params) => {
      requestUpdate = params.requestUpdate;
    },
    detached: () => {
      requestUpdate = undefined;
    },
    paneViews: () => paneViews,
    timeAxisViews: () => timeAxisViews,
  };
  return {
    primitive,
    setTime(next: Time | undefined) {
      if (time === next) return;
      time = next;
      requestUpdate?.();
    },
  };
}
