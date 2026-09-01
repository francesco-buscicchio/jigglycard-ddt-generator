const { createCanvas } = require("@napi-rs/canvas");

const FONT_FAMILY = "Arial";
const TITLE_COLOR = "#1F3145";
const AXIS_COLOR = "#5B6B7C";
const GRID_COLOR = "#E3E9F0";
const BACKGROUND_COLOR = "#FFFFFF";

const PLATFORM_COLORS = {
  cardtrader: "#2E75B6",
  cardmarket: "#ED7D31",
};

function platformColor(platform, fallback = "#7F8C9B") {
  return PLATFORM_COLORS[String(platform).toLowerCase()] ?? fallback;
}

function setupCanvas(width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

function drawTitle(ctx, title, width) {
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, 24, 16);
}

function drawLegend(ctx, series, width) {
  ctx.font = `13px ${FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  let x = width - 24;

  for (let i = series.length - 1; i >= 0; i -= 1) {
    const entry = series[i];
    const labelWidth = ctx.measureText(entry.label).width;
    x -= labelWidth;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "left";
    ctx.fillText(entry.label, x, 26);
    x -= 18;
    ctx.fillStyle = entry.color;
    roundRect(ctx, x, 20, 12, 12, 3);
    ctx.fill();
    x -= 22;
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  let niceNormalized;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 2.5) niceNormalized = 2.5;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;
  return niceNormalized * magnitude;
}

function drawAxesAndGrid(ctx, plot, maxValue, valueFormatter, steps = 5) {
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let step = 0; step <= steps; step += 1) {
    const value = (maxValue / steps) * step;
    const y = plot.y + plot.height - (plot.height / steps) * step;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.width, y);
    ctx.stroke();
    ctx.fillStyle = AXIS_COLOR;
    ctx.fillText(valueFormatter(value), plot.x - 10, y);
  }
}

function drawCategoryLabels(ctx, categories, plot) {
  ctx.fillStyle = AXIS_COLOR;
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const slot = plot.width / categories.length;

  const rotate = categories.length > 8;
  categories.forEach((category, index) => {
    const x = plot.x + slot * index + slot / 2;
    const y = plot.y + plot.height + 8;
    if (rotate) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 5);
      ctx.textAlign = "right";
      ctx.fillText(String(category), 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(String(category), x, y);
    }
  });
}

// Grafico a barre raggruppate: categories = etichette X,
// series = [{ label, color, values }]
function renderGroupedBarChart({
  title,
  categories,
  series,
  width = 900,
  height = 420,
  valueFormatter = (value) => String(Math.round(value)),
}) {
  const { canvas, ctx } = setupCanvas(width, height);
  drawTitle(ctx, title, width);
  drawLegend(ctx, series, width);

  const bottomPadding = categories.length > 8 ? 78 : 46;
  const plot = {
    x: 90,
    y: 62,
    width: width - 120,
    height: height - 62 - bottomPadding,
  };

  const rawMax = Math.max(
    1,
    ...series.flatMap((entry) => entry.values.map((value) => value || 0)),
  );
  const maxValue = niceMax(rawMax * 1.05);

  drawAxesAndGrid(ctx, plot, maxValue, valueFormatter);
  drawCategoryLabels(ctx, categories, plot);

  const slot = plot.width / categories.length;
  const groupWidth = slot * 0.66;
  const barWidth = groupWidth / series.length;

  series.forEach((entry, seriesIndex) => {
    ctx.fillStyle = entry.color;
    entry.values.forEach((value, categoryIndex) => {
      const barHeight = ((value || 0) / maxValue) * plot.height;
      if (barHeight <= 0) return;
      const x =
        plot.x +
        slot * categoryIndex +
        (slot - groupWidth) / 2 +
        barWidth * seriesIndex;
      const y = plot.y + plot.height - barHeight;
      roundRect(ctx, x + 1, y, barWidth - 2, barHeight, 3);
      ctx.fill();
    });
  });

  return canvas.toBuffer("image/png");
}

// Grafico a linee: categories = etichette X, series = [{ label, color, values }]
function renderLineChart({
  title,
  categories,
  series,
  width = 900,
  height = 420,
  valueFormatter = (value) => String(Math.round(value)),
}) {
  const { canvas, ctx } = setupCanvas(width, height);
  drawTitle(ctx, title, width);
  drawLegend(ctx, series, width);

  const bottomPadding = categories.length > 8 ? 78 : 46;
  const plot = {
    x: 90,
    y: 62,
    width: width - 120,
    height: height - 62 - bottomPadding,
  };

  const rawMax = Math.max(
    1,
    ...series.flatMap((entry) => entry.values.map((value) => value || 0)),
  );
  const maxValue = niceMax(rawMax * 1.05);

  drawAxesAndGrid(ctx, plot, maxValue, valueFormatter);
  drawCategoryLabels(ctx, categories, plot);

  const slot = plot.width / categories.length;

  for (const entry of series) {
    const points = entry.values.map((value, index) => ({
      x: plot.x + slot * index + slot / 2,
      y: plot.y + plot.height - ((value || 0) / maxValue) * plot.height,
    }));

    ctx.strokeStyle = entry.color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    ctx.fillStyle = entry.color;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas.toBuffer("image/png");
}

// Grafico a ciambella: slices = [{ label, value, color }]
function renderDonutChart({
  title,
  slices,
  width = 460,
  height = 420,
  valueFormatter = (value) => String(Math.round(value)),
}) {
  const { canvas, ctx } = setupCanvas(width, height);
  drawTitle(ctx, title, width);

  const total = slices.reduce((sum, slice) => sum + (slice.value || 0), 0);
  const centerX = width / 2;
  const centerY = (height - 60) / 2 + 52;
  const outerRadius = Math.min(width, height - 110) / 2 - 20;
  const innerRadius = outerRadius * 0.58;

  let startAngle = -Math.PI / 2;
  for (const slice of slices) {
    const fraction = total > 0 ? (slice.value || 0) / total : 0;
    const endAngle = startAngle + fraction * Math.PI * 2;
    ctx.fillStyle = slice.color;
    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, startAngle, endAngle);
    ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fill();

    if (fraction > 0.04) {
      const midAngle = (startAngle + endAngle) / 2;
      const labelRadius = (outerRadius + innerRadius) / 2;
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `bold 13px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `${Math.round(fraction * 100)}%`,
        centerX + Math.cos(midAngle) * labelRadius,
        centerY + Math.sin(midAngle) * labelRadius,
      );
    }

    startAngle = endAngle;
  }

  ctx.fillStyle = TITLE_COLOR;
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(valueFormatter(total), centerX, centerY - 8);
  ctx.fillStyle = AXIS_COLOR;
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.fillText("totale", centerX, centerY + 12);

  ctx.font = `13px ${FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  let legendY = height - 34;
  let legendX = 24;
  for (const slice of slices) {
    const label = `${slice.label} (${valueFormatter(slice.value || 0)})`;
    ctx.fillStyle = slice.color;
    roundRect(ctx, legendX, legendY - 6, 12, 12, 3);
    ctx.fill();
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "left";
    ctx.fillText(label, legendX + 18, legendY);
    legendX += 18 + ctx.measureText(label).width + 24;
    if (legendX > width - 140) {
      legendX = 24;
      legendY += 22;
    }
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  platformColor,
  renderGroupedBarChart,
  renderLineChart,
  renderDonutChart,
};
