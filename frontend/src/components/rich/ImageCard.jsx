import { useState } from 'react';

export default function ImageCard({ attachment }) {
  const { title, url, thumbnail, description } = attachment;
  const [expanded, setExpanded] = useState(false);

  const imgSrc = thumbnail || url;

  return (
    <>
      <div className="rich-card image-card" onClick={() => setExpanded(true)}>
        <div className="image-card-img-wrap">
          <img src={imgSrc} alt={title || 'Imagen'} loading="lazy" />
        </div>
        <div className="image-card-body">
          {title && <div className="image-card-title">{title}</div>}
          {description && (
            <div className="image-card-desc">{description.substring(0, 150)}</div>
          )}
        </div>
      </div>

      {expanded && (
        <div className="image-modal-overlay" onClick={() => setExpanded(false)}>
          <div className="image-modal" onClick={e => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setExpanded(false)}>&times;</button>
            <img src={url || imgSrc} alt={title || 'Imagen'} className="image-modal-img" />
          </div>
        </div>
      )}
    </>
  );
}
