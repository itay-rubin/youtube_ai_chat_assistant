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
  if (!player) throw new Error(`Could not parse video details for ${videoId}`);

  const details = player.videoDetails || {};
  let transcript = '';
  try {
    transcript = await getTranscript(player);
  } catch {
    transcript = '';
  }

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
