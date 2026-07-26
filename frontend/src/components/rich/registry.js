/**
 * RendererRegistry — maps attachment type to React component.
 *
 * To add a new type: just add an entry here.
 * No need to modify AttachmentRenderer or Chat.jsx.
 */
import VideoCard from './VideoCard';
import ImageCard from './ImageCard';
import WebsiteCard from './WebsiteCard';
import GithubCard from './GithubCard';
import NewsCard from './NewsCard';
import PdfCard from './PdfCard';

const registry = {
  youtube: VideoCard,
  video: VideoCard,
  image: ImageCard,
  website: WebsiteCard,
  github: GithubCard,
  news: NewsCard,
  pdf: PdfCard,
  audio: null,   // future
  map: null,     // future
};

export default registry;
