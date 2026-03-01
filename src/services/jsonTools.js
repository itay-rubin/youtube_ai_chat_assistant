const asVideos = (jsonData) => (Array.isArray(jsonData?.videos) ? jsonData.videos : []);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const median = (sorted) =>
  sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

const stdDev = (values, mean) => {
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const inferNumericFields = (videos) => {
  if (!videos.length) return [];
  const keys = [...new Set(videos.flatMap((v) => Object.keys(v || {})))];
  return keys.filter((key) => videos.some((v) => toNumber(v[key]) !== null));
};

const METRIC_ALIASES = {
  views: ['viewCount', 'views'],
  view: ['viewCount', 'views'],
  viewcount: ['viewCount', 'views'],
  likes: ['likeCount', 'likes', 'favoriteCount', 'favorites'],
  like: ['likeCount', 'likes', 'favoriteCount', 'favorites'],
  likecount: ['likeCount', 'likes', 'favoriteCount', 'favorites'],
  comments: ['commentCount', 'comments', 'replyCount'],
  comment: ['commentCount', 'comments', 'replyCount'],
  numberofcomments: ['commentCount', 'comments', 'replyCount'],
  commentcount: ['commentCount', 'comments', 'replyCount'],
  duration: ['lengthSeconds', 'durationSeconds'],
  length: ['lengthSeconds', 'durationSeconds'],
  transcriptlength: ['transcriptLength'],
};

const resolveMetricField = (videos, requested) => {
  const available = inferNumericFields(videos);
  const wanted = String(requested || '').trim();
  if (!wanted) return null;

  // exact
  if (available.includes(wanted)) return wanted;

  // normalized exact
  const wantedNorm = norm(wanted);
  const normalizedMatch = available.find((f) => norm(f) === wantedNorm);
  if (normalizedMatch) return normalizedMatch;

  // alias candidates
  const aliasCandidates = METRIC_ALIASES[wantedNorm] || [];
  for (const candidate of aliasCandidates) {
    const exact = available.find((f) => f === candidate);
    if (exact) return exact;
    const fuzzy = available.find((f) => norm(f) === norm(candidate));
    if (fuzzy) return fuzzy;
  }

  // partial match fallback
  const partial = available.find((f) => norm(f).includes(wantedNorm) || wantedNorm.includes(norm(f)));
  if (partial) return partial;

  return null;
};

const resolveVideoByTitle = (videos, title = '') => {
  const query = String(title || '').trim().toLowerCase();
  if (!query) return null;
  return (
    videos.find((v) => String(v.title || '').toLowerCase() === query) ||
    videos.find((v) => String(v.title || '').toLowerCase().includes(query))
  );
};

const buildThumbnailUrl = (video) =>
  video.thumbnailUrl ||
  (video.videoId ? `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg` : '');

const makeChartRows = (videos, metric, limit = 30) => {
  const rows = videos
    .map((v) => {
      const value = toNumber(v[metric]);
      const ts = v.publishedAt ? Date.parse(v.publishedAt) : NaN;
      return {
        title: v.title || '',
        url: v.url || '',
        publishedAt: v.publishedAt || '',
        timestamp: Number.isNaN(ts) ? 0 : ts,
        value,
      };
    })
    .filter((r) => r.value !== null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit)
    .map((r) => ({
      date: r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : 'Unknown',
      isoDate: r.publishedAt,
      title: r.title,
      url: r.url,
      [metric]: r.value,
    }));
  return rows;
};

export const JSON_TOOL_DECLARATIONS = [
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, standard deviation, min, max, and count for a numeric field in uploaded YouTube JSON video data.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description:
            'Numeric field from video objects, such as viewCount, lengthSeconds, or transcriptLength.',
        },
      },
      required: ['field'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Build chart data for metric over time using uploaded YouTube JSON videos. Use for trend requests like views over time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        metric: {
          type: 'STRING',
          description: 'Numeric field to chart (example: viewCount, lengthSeconds, transcriptLength).',
        },
        chart_type: {
          type: 'STRING',
          enum: ['line', 'bar'],
          description: 'Chart style. Use line for trend, bar for comparisons.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Number of most recent videos to include. Default 20, max 100.',
        },
      },
      required: ['metric'],
    },
  },
  {
    name: 'play_video',
    description:
      'Return a single video card from uploaded YouTube JSON. Use when user asks to play/open/watch a video, including most viewed or least viewed requests.',
    parameters: {
      type: 'OBJECT',
      properties: {
        video_title: {
          type: 'STRING',
          description: 'Video title (or partial title) to open. If omitted, use rank by views.',
        },
        rank: {
          type: 'NUMBER',
          description:
            '1-based rank by viewCount when video_title is omitted. rank=1 opens most viewed video.',
        },
        order: {
          type: 'STRING',
          enum: ['most_viewed', 'least_viewed'],
          description:
            'When video_title is omitted, choose ranking direction: most_viewed (default) or least_viewed.',
        },
      },
    },
  },
];

export const executeJsonTool = (toolName, args, jsonData) => {
  const videos = asVideos(jsonData);
  if (!videos.length) {
    return { error: 'No JSON video data is loaded. Attach a YouTube JSON file first.' };
  }

  switch (toolName) {
    case 'compute_stats_json': {
      const field = String(args.field || '').trim();
      if (!field) return { error: 'field is required' };
      const resolvedField = resolveMetricField(videos, field);
      if (!resolvedField) {
        return {
          error: `Could not find numeric field for "${field}". Available numeric fields: ${inferNumericFields(videos).join(', ')}`,
        };
      }
      const values = videos.map((v) => toNumber(v[resolvedField])).filter((v) => v !== null);
      if (!values.length) {
        return {
          error: `No numeric values found for "${resolvedField}". Available numeric fields: ${inferNumericFields(videos).join(', ')}`,
        };
      }
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return {
        field: resolvedField,
        count: values.length,
        mean: Number(mean.toFixed(4)),
        median: Number(median(sorted).toFixed(4)),
        std: Number(stdDev(values, mean).toFixed(4)),
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }

    case 'plot_metric_vs_time': {
      const metric = String(args.metric || '').trim();
      if (!metric) return { error: 'metric is required' };
      const resolvedMetric = resolveMetricField(videos, metric);
      if (!resolvedMetric) {
        return {
          error: `Could not find numeric metric for "${metric}". Available numeric fields: ${inferNumericFields(videos).join(', ')}`,
        };
      }
      const chartType = args.chart_type === 'bar' ? 'bar' : 'line';
      const limit = Math.min(100, Math.max(2, Number(args.limit) || 20));
      const data = makeChartRows(videos, resolvedMetric, limit);
      if (!data.length) {
        return {
          error: `No plottable numeric data for "${resolvedMetric}". Available numeric fields: ${inferNumericFields(videos).join(', ')}`,
        };
      }
      return {
        _chartType: 'metric_time',
        metric: resolvedMetric,
        chartType,
        data,
      };
    }

    case 'play_video': {
      const byTitle = resolveVideoByTitle(videos, args.video_title);
      let chosen = byTitle;
      if (!chosen) {
        const rank = Math.max(1, Number(args.rank) || 1);
        const wantLeastViewed = String(args.order || '').toLowerCase() === 'least_viewed';
        const sorted = [...videos].sort((a, b) => {
          const av = toNumber(a.viewCount) || 0;
          const bv = toNumber(b.viewCount) || 0;
          return wantLeastViewed ? av - bv : bv - av;
        });
        chosen = sorted[Math.min(sorted.length - 1, rank - 1)];
      }
      if (!chosen) return { error: 'No matching video found.' };
      return {
        _chartType: 'video_card',
        title: chosen.title || 'Untitled video',
        url: chosen.url || '',
        thumbnailUrl: buildThumbnailUrl(chosen),
        publishedAt: chosen.publishedAt || '',
        viewCount: toNumber(chosen.viewCount) || 0,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
};
