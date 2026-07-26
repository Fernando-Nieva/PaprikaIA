export default function PdfCard({ attachment }) {
  const { title, url, description, source } = attachment;
  const filename = (() => { try { return url.split('/').pop().split('?')[0]; } catch { return 'Documento'; } })();

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="rich-card pdf-card">
      <div className="pdf-card-icon">PDF</div>
      <div className="pdf-card-body">
        <div className="pdf-card-title">{title || filename}</div>
        {source && <div className="pdf-card-source">{source}</div>}
        {description && (
          <div className="pdf-card-desc">{description.substring(0, 150)}</div>
        )}
      </div>
    </a>
  );
}
