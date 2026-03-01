const MAX_TRANSCRIPT_CHARS = 15000;

const decodeHtmlEntities = (text = '') =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

const normalizeChannelUrl = (input) => {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('YouTube channel URL is required');
  if (raw.startsWith('@')) return `https://www.youtube.com/${raw}`;
  if (raw.includes('youtube.com')) {
    return raw.startsWith('http') ? raw : `https://${raw}`;
  }
  throw new Error('Please enter a valid YouTube channel URL or handle (e.g. @veritasium)');
};

const fetchText = async (url) => {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return res.text();
};

const extractJsonObject = (html, marker) => {
  const startMarker = html.indexOf(marker);
  if (startMarker < 0) return null;
  const startBrace = html.indexOf('{', startMarker);
  if (startBrace < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBrace; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) {
      const raw = html.slice(startBrace, i + 1);
      return JSON.parse(raw);
    }
  }
  return null;
};

const collectVideoRenderers = (node, out = []) => {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((item) => collectVideoRenderers(item, out));
    return out;
  }
  if (typeof node !== 'object') return out;

  if (node.videoRenderer?.videoId) out.push(node.videoRenderer);
  Object.values(node).forEach((value) => collectVideoRenderers(value, out));
  return out;
};

const parseTranscriptXml = (xml) => {
  const pieces = [];
  const regex = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let match = regex.exec(xml);
  while (match) {
    const clean = decodeHtmlEntities(match[1]).replace(/<[^>]*>/g, '').trim();
    if (clean) pieces.push(clean);
    match = regex.exec(xml);
  }
  return pieces.join(' ').slice(0, MAX_TRANSCRIPT_CHARS);
};

const parseCompactNumber = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;
  const cleaned = text
    .replace(/,/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[^0-9.kmbKMB-]/g, '')
    .trim();
  if (!cleaned) return null;

  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([kmbKMB])?$/);
  if (!match) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (match[2] || '').toLowerCase();
  const mult = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;
  return Math.round(base * mult);
};

const scanCountsFromObject = (node, out = { likeCount: null, commentCount: null }) => {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((item) => scanCountsFromObject(item, out));
    return out;
  }
  if (typeof node !== 'object') return out;

  Object.entries(node).forEach(([key, value]) => {
    const k = key.toLowerCase();

    // Prefer explicit keys when present in YouTube payloads
    if (out.likeCount === null && k.includes('likecount')) {
      if (typeof value === 'number') out.likeCount = value;
      else if (typeof value === 'string') out.likeCount = parseCompactNumber(value);
      else if (value && typeof value === 'object') {
        const fromSimple = parseCompactNumber(value.simpleText);
        if (fromSimple !== null) out.likeCount = fromSimple;
      }
    }

    if (out.commentCount === null && k.includes('commentcount')) {
      if (typeof value === 'number') out.commentCount = value;
      else if (typeof value === 'string') out.commentCount = parseCompactNumber(value);
      else if (value && typeof value === 'object') {
        const fromSimple = parseCompactNumber(value.simpleText);
        if (fromSimple !== null) out.commentCount = fromSimple;
      }
    }

    // Accessibility labels often contain values like "1,234 likes"
    if (typeof value === 'string') {
      if (out.likeCount === null) {
        const likeMatch = value.match(/([\d.,]+[kmbKMB]?)\s+likes?/i);
        if (likeMatch) out.likeCount = parseCompactNumber(likeMatch[1]);
      }
      if (out.commentCount === null) {
        const commentMatch = value.match(/([\d.,]+[kmbKMB]?)\s+comments?/i);
        if (commentMatch) out.commentCount = parseCompactNumber(commentMatch[1]);
      }
    }

    scanCountsFromObject(value, out);
  });

  return out;
};

const scanCountsFromHtml = (html) => {
  const likeRegexes = [
    /"label":"([\d.,kmbKMB]+)\s+likes?"/i,
    /"accessibilityText":"([\d.,kmbKMB]+)\s+likes?"/i,
    /"likeCount(?:IfLikedNumber|IfIndifferent)":"([^"]+)"/i,
  ];
  const commentRegexes = [
    /"commentCount":\{"simpleText":"([^"]+)"\}/i,
    /"countText":\{"simpleText":"([^"]*comments?)"\}/i,
    /"numCommentsText":\{"runs":\[\{"text":"([^"]+)"/i,
  ];

  let likeCount = null;
  let commentCount = null;

  for (const re of likeRegexes) {
    const m = html.match(re);
    if (m) {
      likeCount = parseCompactNumber(m[1]);
      if (likeCount !== null) break;
    }
  }
  for (const re of commentRegexes) {
    const m = html.match(re);
    if (m) {
      commentCount = parseCompactNumber(m[1]);
      if (commentCount !== null) break;
    }
  }

  return { likeCount, commentCount };
};

const fetchEngagementFromYouTubeDataApi = async (videoId) => {
  const apiKey = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
  if (!apiKey) return { likeCount: null, commentCount: null };
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}` +
      `&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return { likeCount: null, commentCount: null };
    const json = await res.json();
    const stats = json?.items?.[0]?.statistics || {};
    return {
      likeCount: parseCompactNumber(stats.likeCount),
      commentCount: parseCompactNumber(stats.commentCount),
    };
  } catch {
    return { likeCount: null, commentCount: null };
  }
};

const extractInnertubeConfig = (html) => {
  const apiKeyMatch = html.match(/\"INNERTUBE_API_KEY\":\"([^\"]+)\"/);
  const clientVersionMatch = html.match(/\"INNERTUBE_CLIENT_VERSION\":\"([^\"]+)\"/);
  return {
    apiKey: apiKeyMatch?.[1] || '',
    clientVersion: clientVersionMatch?.[1] || '',
  };
};

const fetchEngagementFromInnertube = async (videoId, apiKey, clientVersion) => {
  if (!apiKey || !clientVersion) return { likeCount: null, commentCount: null };
  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion,
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
        }),
      }
    );
    if (!res.ok) return { likeCount: null, commentCount: null };
    const payload = await res.json();
    const fromObject = scanCountsFromObject(payload, { likeCount: null, commentCount: null });
    const fromText = scanCountsFromHtml(JSON.stringify(payload));
    return {
      likeCount: fromObject.likeCount ?? fromText.likeCount,
      commentCount: fromObject.commentCount ?? fromText.commentCount,
    };
  } catch {
    return { likeCount: null, commentCount: null };
  }
};

const getTranscript = async (playerResponse) => {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return '';
  const preferred =
    tracks.find((track) => track.languageCode === 'en') ||
    tracks.find((track) => track.vssId?.includes('.en')) ||
    tracks[0];
  if (!preferred?.baseUrl) return '';

  const xml = await fetchText(preferred.baseUrl);
  return parseTranscriptXml(xml);
};

const fetchVideoDetails = async (videoId) => {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchText(watchUrl);
  const player =
    extractJsonObject(html, 'var ytInitialPlayerResponse =') ||
    extractJsonObject(html, 'ytInitialPlayerResponse =');
  const initialData =
    extractJsonObject(html, 'var ytInitialData =') ||
    extractJsonObject(html, 'window["ytInitialData"] =') ||
    extractJsonObject(html, 'ytInitialData =');
  if (!player) throw new Error(`Could not parse video details for ${videoId}`);

  const details = player.videoDetails || {};
  let transcript = '';
  try {
    transcript = await getTranscript(player);
  } catch {
    transcript = '';
  }

  const { apiKey, clientVersion } = extractInnertubeConfig(html);
  const fromApi = await fetchEngagementFromYouTubeDataApi(videoId);
  const fromInitialData = scanCountsFromObject(initialData, { likeCount: null, commentCount: null });
  const fromHtml = scanCountsFromHtml(html);
  const fromInnertube = await fetchEngagementFromInnertube(videoId, apiKey, clientVersion);
  const likeCount =
    fromApi.likeCount ??
    fromInitialData.likeCount ??
    fromHtml.likeCount ??
    fromInnertube.likeCount;
  const commentCount =
    fromApi.commentCount ??
    fromInitialData.commentCount ??
    fromHtml.commentCount ??
    fromInnertube.commentCount;

  return {
    videoId,
    url: watchUrl,
    title: details.title || '',
    description: details.shortDescription || '',
    channelTitle: details.author || '',
    channelId: details.channelId || '',
    publishedAt: player.microformat?.playerMicroformatRenderer?.publishDate || '',
    lengthSeconds: Number(details.lengthSeconds || 0),
    viewCount: Number(details.viewCount || 0),
    likeCount,
    commentCount,
    keywords: details.keywords || [],
    transcript,
    transcriptLength: transcript.length,
  };
};

const fetchChannelVideos = async (channelUrl, maxVideos, onProgress) => {
  const normalized = normalizeChannelUrl(channelUrl);
  const pageUrl = `${normalized.replace(/\/+$/, '')}/videos`;
  const html = await fetchText(pageUrl);

  const initialData =
    extractJsonObject(html, 'var ytInitialData =') || extractJsonObject(html, 'window["ytInitialData"] =');
  if (!initialData) throw new Error('Unable to parse YouTube channel page data');

  const meta = initialData?.metadata?.channelMetadataRenderer || {};
  const renderers = collectVideoRenderers(initialData, []);
  const ids = [...new Set(renderers.map((r) => r.videoId).filter(Boolean))].slice(0, maxVideos);
  if (!ids.length) throw new Error('No videos found on this channel URL');

  const videos = [];
  for (let i = 0; i < ids.length; i += 1) {
    const video = await fetchVideoDetails(ids[i]);
    videos.push(video);
    if (onProgress) {
      onProgress({
        completed: i + 1,
        total: ids.length,
        progress: Math.round(((i + 1) / ids.length) * 100),
        currentVideo: video.title || video.videoId,
      });
    }
  }

  return {
    channel: {
      inputUrl: channelUrl,
      resolvedUrl: normalized,
      title: meta.title || '',
      description: meta.description || '',
      channelId: meta.externalId || '',
      generatedAt: new Date().toISOString(),
    },
    totals: {
      requested: maxVideos,
      downloaded: videos.length,
    },
    videos,
  };
};

module.exports = {
  fetchChannelVideos,
};
