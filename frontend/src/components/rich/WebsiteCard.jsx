export default function WebsiteCard({ attachment }) {
  const { title, url, description, favicon, siteName } = attachment;
  const domain = siteName || (() => { try { return new URL(url).hostname; } catch { return ''; } })();

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="rich-card website-card">
      <div className="website-card-header">
        {favicon && <img src={favicon} alt="" className="website-card-favicon" />}
        <span className="website-card-domain">{domain}</span>
      </div>
      <div className="website-card-title">{title || url}</div>
      {description && (
        <div className="website-card-desc">{description.substring(0, 200)}</div>
      )}
    </a>
  );
}
