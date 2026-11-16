/**
 * Wires the knowledge base and attachments into the outbox worker: issues' mentions of
 * articles follow their text, and files nothing points at are swept from storage.
 */
import { consumerFactories } from '../server';
import { attachmentSweeper, sweepAttachments } from '../services/attachments';
import { mentionsConsumer } from '../services/mentions';

consumerFactories.push(mentionsConsumer);
consumerFactories.push((runtime) => {
  // Once at start: what a crash mid-upload left, and what went with a deleted project.
  void sweepAttachments(runtime).catch((e) => console.error('attachments: sweeping at start failed', e));
  return attachmentSweeper(runtime);
});
