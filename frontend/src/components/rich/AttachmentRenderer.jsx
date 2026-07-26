import registry from './registry';

/**
 * AttachmentRenderer — renders a list of rich content attachments.
 *
 * Usage:
 *   <AttachmentRenderer attachments={msg.attachments} />
 */
export default function AttachmentRenderer({ attachments }) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="rich-attachments">
      {attachments.map((att, i) => {
        const Component = registry[att.type];
        if (!Component) {
          // Unknown type — render as generic website link
          return (
            <a
              key={i}
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rich-card generic-card"
            >
              {att.title || att.url}
            </a>
          );
        }
        return <Component key={i} attachment={att} />;
      })}
    </div>
  );
}
