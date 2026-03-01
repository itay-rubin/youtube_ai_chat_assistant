import { useEffect, useMemo, useState } from 'react';
import {
  getYouTubeDownloadJob,
  getYouTubeDownloadUrl,
  startYouTubeDownloadJob,
} from '../services/mongoApi';
import './YouTubeDownloader.css';

export default function YouTubeDownloader() {
  const [url, setUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  const clampedMaxVideos = useMemo(
    () => Math.min(100, Math.max(1, Number(maxVideos) || 1)),
    [maxVideos]
  );

  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const current = await getYouTubeDownloadJob(jobId);
        if (cancelled) return;
        setJob(current);
        if (current.status === 'running') {
          timer = setTimeout(poll, 1200);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to fetch job status');
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const handleStart = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setJob(null);
    setJobId(null);
    try {
      const { jobId: createdJobId } = await startYouTubeDownloadJob(url.trim(), clampedMaxVideos);
      setJobId(createdJobId);
    } catch (err) {
      setError(err.message || 'Could not start download');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!jobId) return;
    setError('');
    setDownloading(true);
    try {
      // Prefer the completed payload already in memory so download doesn't depend
      // on backend in-memory job state still being available.
      if (job?.result) {
        const blob = new Blob([JSON.stringify(job.result, null, 2)], {
          type: 'application/json',
        });
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = job?.fileName || 'youtube_channel_data.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
        return;
      }

      // Fallback: fetch from backend download endpoint
      const res = await fetch(getYouTubeDownloadUrl(jobId));
      if (!res.ok) {
        throw new Error('Download file is no longer available. Please run the fetch again.');
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = job?.fileName || 'youtube_channel_data.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err.message || 'Failed to download JSON file');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="yt-downloader-wrap">
      <div className="yt-downloader-card">
        <h3>YouTube Channel Download</h3>
        <p className="yt-downloader-subtitle">
          Fetch channel videos, transcripts, and core stats as a downloadable JSON file.
        </p>

        <form onSubmit={handleStart} className="yt-downloader-form">
          <label>
            Channel URL or handle
            <input
              type="text"
              placeholder="https://www.youtube.com/@veritasium or @veritasium"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>

          <label>
            Max Videos (1-100)
            <input
              type="number"
              min={1}
              max={100}
              value={maxVideos}
              onChange={(e) => setMaxVideos(e.target.value)}
              required
            />
          </label>

          <button type="submit" disabled={loading || !url.trim()}>
            {loading ? 'Starting...' : 'Fetch Channel Data'}
          </button>
        </form>

        {error && <p className="yt-downloader-error">{error}</p>}

        {job && (
          <div className="yt-job-status">
            <div className="yt-job-head">
              <span>Status: {job.status}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="yt-progress-track">
              <div className="yt-progress-fill" style={{ width: `${job.progress || 0}%` }} />
            </div>
            {job.currentVideo && <p className="yt-current-video">Processing: {job.currentVideo}</p>}
            {job.status === 'completed' && (
              <div className="yt-job-actions">
                <p>
                  Download ready: <code>{job.fileName}</code>
                </p>
                <button type="button" onClick={handleDownload} disabled={downloading}>
                  {downloading ? 'Preparing...' : 'Download JSON'}
                </button>
              </div>
            )}
            {job.status === 'failed' && (
              <p className="yt-downloader-error">{job.error || 'Job failed. Try another channel URL.'}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
