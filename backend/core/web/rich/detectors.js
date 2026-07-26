/**
 * URL detectors — classify URLs into attachment types.
 *
 * Each detector receives a URL string and optional context (title, snippet)
 * and returns an attachment object or null.
 *
 * Detectors are evaluated in order; first match wins.
 */

const yt = require('./attachments');

// ─── YouTube ──────────────────────────────────────
const YT_PATTERNS = [
  /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
];

function detectYouTube(url, ctx) {
  if (!url) return null;
  for (const p of YT_PATTERNS) {
    const m = url.match(p);
    if (m) {
      return yt.youtube({
        title: ctx?.title || '',
        url,
        videoId: m[1],
        description: ctx?.snippet || '',
        channel: ctx?.channel || '',
        duration: ctx?.duration || null,
      });
    }
  }
  return null;
}

// ─── Images ───────────────────────────────────────
const IMG_EXT = /\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;

function detectImage(url, ctx) {
  if (!url) return null;
  if (IMG_EXT.test(url)) {
    return yt.image({
      title: ctx?.title || '',
      url,
      thumbnail: ctx?.thumbnail || url,
      description: ctx?.snippet || '',
      source: ctx?.engine || '',
    });
  }
  return null;
}

// ─── GitHub ───────────────────────────────────────
const GH_PATTERN = /github\.com\/([^/]+)\/([^/]+)(?:\/|$)/;

function detectGitHub(url, ctx) {
  if (!url) return null;
  const m = url.match(GH_PATTERN);
  if (m) {
    return yt.github({
      title: ctx?.title || `${m[1]}/${m[2]}`,
      url: `https://github.com/${m[1]}/${m[2]}`,
      description: ctx?.snippet || '',
      owner: m[1],
      repo: m[2],
      stars: ctx?.stars || null,
      language: ctx?.language || null,
      forks: ctx?.forks || null,
    });
  }
  return null;
}

// ─── PDF ──────────────────────────────────────────
const PDF_EXT = /\.pdf(\?.*)?$/i;

function detectPDF(url, ctx) {
  if (!url) return null;
  if (PDF_EXT.test(url)) {
    return yt.pdf({
      title: ctx?.title || '',
      url,
      description: ctx?.snippet || '',
      source: ctx?.engine || '',
    });
  }
  return null;
}

// ─── News (heuristic: if engine is news-related) ──
const NEWS_ENGINES = /google\s*news|bing\s*news|duckduckgo\s*news|noticias|news/i;

function detectNews(url, ctx) {
  if (!ctx) return null;
  const engine = ctx.engine || '';
  const title = ctx.title || '';
  if (NEWS_ENGINES.test(engine) || NEWS_ENGINES.test(ctx?.category || '')) {
    return yt.news({
      title,
      url,
      description: ctx?.snippet || '',
      source: engine,
      date: ctx?.publishedDate || null,
      image: ctx?.thumbnail || '',
    });
  }
  return null;
}

// ─── Audio ────────────────────────────────────────
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|aac|m4a|wma)(\?.*)?$/i;

function detectAudio(url, ctx) {
  if (!url) return null;
  if (AUDIO_EXT.test(url)) {
    return yt.audio({
      title: ctx?.title || '',
      url,
      description: ctx?.snippet || '',
      source: ctx?.engine || '',
    });
  }
  return null;
}

// Ordered list of detectors
const DETECTORS = [
  detectYouTube,
  detectImage,
  detectGitHub,
  detectPDF,
  detectAudio,
  detectNews,
];

module.exports = { DETECTORS, detectYouTube, detectImage, detectGitHub, detectPDF, detectAudio, detectNews };
