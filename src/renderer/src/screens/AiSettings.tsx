import { chatLimits } from '../../../shared/chat-limits';
import { ChatBudgets } from './ChatBudgets';

export function AiSettings(): React.JSX.Element {
  return (
    <section aria-labelledby="ai-settings-heading" className="space-y-6">
      <h2 id="ai-settings-heading" className="text-lg font-medium">AI settings</h2>
      <ChatBudgets />
      <section className="space-y-2">
        <h3 className="text-lg font-medium">Image limits</h3>
        <p className="text-sm text-muted-foreground">Attach up to {chatLimits.imagesPerMessage} images per message, 2 MB each. A response can include {chatLimits.uniqueImagesPerRun} different images totaling up to 12 MB from the conversation. Each take retains up to 40 MB of images.</p>
      </section>
    </section>
  );
}
