import type { CustomDataSource } from '../../../shared/data-sources';
import type { SourceCapabilities } from './SourceComponents';
export const managedSourceCapabilities: SourceCapabilities = {edit:false,collection:true,interval:'inline',storage:'account',destination:false};
export function customSourceCapabilities(source:CustomDataSource):SourceCapabilities {
  const destination=source.config.feeds.some(feed=>feed.destination&&feed.destination.kind!=='custom-feed');
  return {edit:source.config.feeds.length===1,collection:source.validated&&source.config.collection!=='off'&&(source.enabled||!destination),interval:'review',storage:'feed',destination};
}
