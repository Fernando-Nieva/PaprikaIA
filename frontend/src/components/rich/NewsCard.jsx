export default function NewsCard({ attachment }) {
  const { title, url, description, source, date, image } = attachment;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="rich-card news-card">
      {image && (
        <div className="news-card-img">
          <img src={image} alt={title || 'Noticia'} loading="lazy" />
        </div>
      )}
      <div className="news-card-body">
        {source && <div className="news-card-source">{source}</div>}
        <div className="news-card-title">{title || 'Noticia'}</div>
        {description && (
          <div className="news-card-desc">{description.substring(0, 200)}</div>
        )}
        {date && <div className="news-card-date">{date}</div>}
      </div>
    </a>
  );
}
