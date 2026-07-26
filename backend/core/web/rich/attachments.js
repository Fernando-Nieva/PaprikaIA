/**
 * Attachment type definitions and factory functions.
 *
 * Each attachment is a plain JSON object with a `type` field.
 * The frontend uses `type` to dispatch to the correct renderer.
 *
 * Types: youtube | image | website | github | news | pdf | audio | video | map
 */

function youtube({ title, url, videoId, thumbnail, description, duration, channel }) {
  return {
    type: 'youtube',
    title: title || '',
    url: url || '',
    videoId: videoId || '',
    thumbnail: thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : ''),
    description: description || '',
    duration: duration || null,
    channel: channel || '',
  };
}

function image({ title, url, thumbnail, description, source }) {
  return {
    type: 'image',
    title: title || '',
    url: url || '',
    thumbnail: thumbnail || url || '',
    description: description || '',
    source: source || '',
  };
}

function website({ title, url, description, favicon, siteName }) {
  const domain = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const faviconUrl = favicon || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '');
  return {
    type: 'website',
    title: title || '',
    url: url || '',
    description: description || '',
    favicon: faviconUrl,
    siteName: siteName || domain,
  };
}

function github({ title, url, description, owner, repo, stars, language, forks }) {
  return {
    type: 'github',
    title: title || '',
    url: url || '',
    description: description || '',
    owner: owner || '',
    repo: repo || '',
    stars: stars || null,
    language: language || null,
    forks: forks || null,
  };
}

function news({ title, url, description, source, date, image }) {
  return {
    type: 'news',
    title: title || '',
    url: url || '',
    description: description || '',
    source: source || '',
    date: date || null,
    image: image || '',
  };
}

function pdf({ title, url, description, source }) {
  return {
    type: 'pdf',
    title: title || '',
    url: url || '',
    description: description || '',
    source: source || '',
  };
}

function audio({ title, url, description, source, duration }) {
  return {
    type: 'audio',
    title: title || '',
    url: url || '',
    description: description || '',
    source: source || '',
    duration: duration || null,
  };
}

function website_from_search(result) {
  const url = result.url || '';
  const domain = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  return {
    type: 'website',
    title: result.title || '',
    url,
    description: (result.snippet || '').substring(0, 300),
    favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '',
    siteName: result.engine || domain,
  };
}

module.exports = { youtube, image, website, github, news, pdf, audio, website_from_search };
