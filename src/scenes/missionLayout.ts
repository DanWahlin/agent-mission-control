export interface MissionLayout {
  s: number;
  compact: boolean;
  leftX: number;
  opsY: number;
  opsH: number;
  topY: number;
  panelW: number;
  sessionH: number;
  replayH: number;
  replayY: number;
  bottomH: number;
  bottomY: number;
  inspectorX: number;
  inspectorW: number;
  centerX: number;
  centerY: number;
  hubY: number;
  radiusX: number;
  radiusY: number;
  quarterR: number;
  quarterSize: number;
  topLift: number;
}

export interface MissionLayoutInput {
  width: number;
  height: number;
  panelsHidden: boolean;
  sectorCount: number;
  centerRingDownNudgePx: number;
  focusRingUpLiftPx: number;
}

export function computeMissionLayout(input: MissionLayoutInput): MissionLayout {
  const { width, height, panelsHidden, sectorCount, centerRingDownNudgePx, focusRingUpLiftPx } = input;
  const s = sceneScale(width, height);
  const compact = width < 1600 || height < 900;

  const leftX = Math.max(20, width * 0.018);
  const opsY = Math.max(8, height * 0.012);
  const opsH = 0;
  const topY = opsY + opsH + (compact ? 10 : 14);

  const panelW = panelsHidden
    ? 0
    : compact
      ? Math.min(360, Math.max(300, width * 0.32))
      : Math.min(520, Math.max(420, width * 0.3));
  const sessionH = Math.min(compact ? 400 : 440, Math.max(390, height * 0.43));

  const replayH = panelsHidden ? 0 : (compact ? 48 : 56);
  const replayMargin = Math.max(12, height * 0.016);
  const replayY = panelsHidden ? height : height - replayH - replayMargin;

  const bottomH = Math.min(compact ? 172 : 196, Math.max(158, height * 0.18));
  const replayGap = 8;
  const bottomY = panelsHidden
    ? height - bottomH - replayMargin
    : replayY - replayGap - bottomH;

  const inspectorGutter = compact ? 20 : 32;
  const inspectorX = leftX + panelW + inspectorGutter;
  const inspectorW = Math.max(360, width - inspectorX - leftX);

  const wellGutterX = compact ? 18 : 28;
  const wellGutterY = panelsHidden ? (compact ? 6 : 8) : (compact ? 8 : 12);
  const wellLeft = leftX + panelW + wellGutterX;
  const wellRight = width - leftX - wellGutterX;
  const wellTop = opsY + opsH + wellGutterY;
  const wellBottom = bottomY - wellGutterY;

  const wellW = Math.max(220, wellRight - wellLeft);
  const wellH = Math.max(180, wellBottom - wellTop);

  const centerX = wellLeft + wellW / 2;
  const rawRadiusX = wellW / 2;
  const rawRadiusY = wellH / 2;
  const minRingRadius = Math.min(rawRadiusX, rawRadiusY);
  const quarterCap = panelsHidden ? 80 : 64;
  const startingQuarterR = Math.max(32, Math.min(quarterCap * s, minRingRadius * 0.42));
  const labelBlockH = Math.round(38 * Math.max(s, 0.85));
  const minQuarterR = 24;
  const layoutForQuarterR = (candidateR: number) => {
    const quarterSize = candidateR * 2;
    const sectorText = sectorTextMetrics(candidateR);
    const labelStackH = sectorText.labelStackH;
    const verticalShift = panelsHidden
      ? Math.max(0, (labelStackH - candidateR) / 2)
      : Math.max(18, (labelStackH - candidateR) / 2 + 12);
    const centerDownNudge = Math.round(centerRingDownNudgePx * Math.max(s, 0.85));
    const focusModeLift = panelsHidden ? Math.round(focusRingUpLiftPx * Math.max(s, 0.85)) : 0;
    const centerY = wellTop + wellH / 2 - verticalShift + centerDownNudge - focusModeLift;
    const horizontalRadius = Math.max(100, rawRadiusX - candidateR);
    const frameH = quarterSize + labelBlockH;
    const cardPadding = Math.max(4, Math.round(4 * Math.max(s, 0.85)));
    const maxCardRadius = Array.from({ length: sectorCount }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / sectorCount;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const bounds: number[] = [];
      if (cos > 0.001) bounds.push((wellRight - cardPadding - candidateR - centerX) / cos);
      else if (cos < -0.001) bounds.push((centerX - wellLeft - cardPadding - candidateR) / -cos);
      if (sin < -0.001) bounds.push((centerY - wellTop - cardPadding - candidateR) / -sin);
      else if (sin > 0.001) bounds.push((wellBottom - cardPadding + candidateR - frameH - centerY) / sin);
      return Math.min(...bounds);
    }).reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
    const radius = Math.max(100, Math.min(horizontalRadius, maxCardRadius));

    return {
      centerY,
      radiusX: radius,
      radiusY: radius,
      quarterR: candidateR,
      quarterSize,
      topLift: 0,
    };
  };
  const hasSectorCardOverlap = (candidate: ReturnType<typeof layoutForQuarterR>) => {
    const frameH = candidate.quarterSize + labelBlockH;
    const gap = Math.max(4, Math.round(6 * Math.max(s, 0.85)));
    const rects = Array.from({ length: sectorCount }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / sectorCount;
      const x = centerX + Math.cos(angle) * candidate.radiusX;
      const y = candidate.centerY + Math.sin(angle) * candidate.radiusY;
      return {
        left: x - candidate.quarterR,
        right: x + candidate.quarterR,
        top: y - candidate.quarterR,
        bottom: y - candidate.quarterR + frameH,
      };
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const xOverlap = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
        const yOverlap = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
        if (xOverlap > -gap && yOverlap > -gap) return true;
      }
    }
    return false;
  };
  let fitted = layoutForQuarterR(startingQuarterR);
  while (fitted.quarterR > minQuarterR && hasSectorCardOverlap(fitted)) {
    fitted = layoutForQuarterR(Math.max(minQuarterR, fitted.quarterR - 2));
  }
  const { centerY, radiusX, radiusY, quarterR, quarterSize, topLift } = fitted;
  const hubY = centerY + labelBlockH / 2;

  return {
    s,
    compact,
    leftX,
    opsY,
    opsH,
    topY,
    panelW,
    sessionH,
    replayH,
    replayY,
    bottomH,
    bottomY,
    inspectorX,
    inspectorW,
    centerX,
    centerY,
    hubY,
    radiusX,
    radiusY,
    quarterR,
    quarterSize,
    topLift,
  };
}

export function sceneScale(width: number, height: number) {
  return clamp(Math.min(width / 1920, height / 1080) * 1.24, 0.88, 1.45);
}

export function sectorTextMetrics(quarterR: number) {
  const quarterSize = quarterR * 2;
  const pedestalUnit = quarterR / 64;
  const labelSize = Math.max(12, Math.round(quarterSize * 0.115));
  const countSize = Math.max(16, Math.round(quarterSize * 0.16));
  return {
    labelSize,
    countSize,
    labelStackH: Math.round(42 * pedestalUnit + 14 + labelSize + countSize),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
