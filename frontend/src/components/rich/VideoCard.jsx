export default function VideoCard({ attachment }) {
  const { title, url, videoId, thumbnail, description, channel } = attachment;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="rich-card video-card">
      <div className="video-card-thumbnail">
        {videoId ? (
          <img
            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
            alt={title || 'Video'}
            loading="lazy"
          />
        ) : thumbnail ? (
          <img src={thumbnail} alt={title || 'Video'} loading="lazy" />
        ) : (
          <div className="video-card-placeholder">Video</div>
        )}
        <div className="video-card-play">&#9654;</div>
      </div>
      <div className="video-card-body">
        <div className="video-card-title">{title || 'Video de YouTube'}</div>
        {channel && <div className="video-card-channel">{channel}</div>}
        {description && (
          <div className="video-card-desc">{description.substring(0, 150)}</div>
        )}
      </div>
    </a>
  );
}
